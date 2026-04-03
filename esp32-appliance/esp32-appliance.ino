/*
 * pi486 Appliance — ESP32 DevKit V1 (DOIT / WROOM-32) firmware
 *
 * Hardware:
 *   UART TX/RX → Raspberry Pi GPIO 14/15 (3.3V TTL, 115200 baud)
 *     ESP32 GPIO17 (TX) → Pi GPIO15 (RXD)
 *     ESP32 GPIO16 (RX) → Pi GPIO14 (TXD)
 *   PN532 NFC  → I2C (SDA=GPIO21, SCL=GPIO22 — default WROOM-32 I2C)
 *   LEDs       → GPIO pins via current-limiting resistors (~330Ω)
 *
 * Behavior:
 *   - Parses "!led <device> <id> <state>" lines from UART → drives LEDs
 *   - Polls PN532 every 500ms for NTAG215 tags
 *   - On tag detect: parses "<type>:<wp>:<path>", sends fddload/cdload over UART
 *   - On tag removal (2 consecutive missed polls): sends fddeject/cdeject
 */

#include <Wire.h>
#include <Adafruit_PN532.h>

// ---------------------------------------------------------------------------
// Pin assignments (ESP32 DevKit V1 — DOIT / WROOM-32)
// ---------------------------------------------------------------------------
#define LED_POWER 25
#define LED_HDD 26
#define LED_FLOPPY 27
#define LED_CD 14
#define LED_NET 13

// UART to Raspberry Pi (Serial2 on WROOM-32)
#define PI_UART_RX 16
#define PI_UART_TX 17

// PN532 I2C (default WROOM-32 I2C pins)
#define PN532_SDA 21
#define PN532_SCL 22

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
#define SERIAL_BAUD 115200
#define NFC_POLL_MS 500
#define EJECT_MISS_COUNT 2 // consecutive missed polls before eject

// NTAG215 memory layout: pages 4-129 are user data (504 bytes)
#define NTAG_USER_PAGE_START 4
#define NTAG_USER_PAGE_END 129
#define NTAG_MAX_USER_BYTES 504
#define NTAG_PAGE_SIZE 4

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
Adafruit_PN532 nfc(PN532_SDA, PN532_SCL); // I2C mode (no reset/IRQ)

// NFC state tracking
uint8_t lastTagUid[7];
uint8_t lastTagUidLen = 0;
char lastTagType = 0; // 'F' or 'C'
char lastTagWp = '0';
char lastTagPath[NTAG_MAX_USER_BYTES + 1] = {0};
bool tagMounted = false;
bool tagEjected = true; // start as "nothing mounted"
uint8_t missedPolls = 0;

// Serial line buffer
char lineBuf[256];
uint8_t linePos = 0;

// Timing
unsigned long lastNfcPoll = 0;

// --------------------------------------------------------------------------
// LED helpers
// ---------------------------------------------------------------------------
void setAllLeds(uint8_t state)
{
    digitalWrite(LED_HDD, state);
    digitalWrite(LED_FLOPPY, state);
    digitalWrite(LED_CD, state);
    digitalWrite(LED_NET, state);
}

void handleLedEvent(const char *device, const char *state)
{
    bool on = (strcmp(state, "read") == 0 || strcmp(state, "write") == 0);
    int pin = -1;

    if (strcmp(device, "hdd") == 0)
        pin = LED_HDD;
    else if (strcmp(device, "fdd") == 0)
        pin = LED_FLOPPY;
    else if (strcmp(device, "cdrom") == 0)
        pin = LED_CD;
    else if (strcmp(device, "net") == 0)
        pin = LED_NET;
    else if (strcmp(device, "power") == 0)
        pin = LED_POWER;

    if (pin >= 0)
    {
        digitalWrite(pin, on ? HIGH : LOW);
    }
}

// ---------------------------------------------------------------------------
// Parse a serial line from the Pi
// ---------------------------------------------------------------------------
void processSerialLine(const char *line)
{
    Serial.print("[PI] ");
    Serial.println(line);

    // "!led <device> <id> <state>"
    if (strncmp(line, "!led ", 5) == 0)
    {
        char device[16] = {0};
        char id[4] = {0};
        char state[16] = {0};
        if (sscanf(line + 5, "%15s %3s %15s", device, id, state) == 3)
        {
            handleLedEvent(device, state);
        }
    }
    // "sync" — re-send current mount state
    else if (strcmp(line, "sync") == 0)
    {
        if (tagMounted && !tagEjected && lastTagPath[0] != '\0')
        {
            if (lastTagType == 'F')
            {
                Serial.print("[SYNC] Sending: fddload 0 ");
                Serial.print(lastTagPath);
                Serial.print(" ");
                Serial.println(lastTagWp);
                Serial2.print("fddload 0 ");
                Serial2.print(lastTagPath);
                Serial2.print(" ");
                Serial2.println(lastTagWp);
            }
            else if (lastTagType == 'C')
            {
                Serial.print("[SYNC] Sending: cdload 0 ");
                Serial.println(lastTagPath);
                Serial2.print("cdload 0 ");
                Serial2.println(lastTagPath);
            }
        }
        else
        {
            Serial.println("[SYNC] No disk mounted, nothing to send");
        }
    }
}

// ---------------------------------------------------------------------------
// NFC tag reading
// ---------------------------------------------------------------------------

/// Read NTAG215 user pages into buf.
/// Returns number of bytes read on success (null terminator found),
/// or -1 if the read was incomplete (tag removed before null terminator).
int readNtagUserData(uint8_t *buf, int maxLen)
{
    Serial.println("[NFC] Reading tag user data...");
    int offset = 0;
    for (uint8_t page = NTAG_USER_PAGE_START; page <= NTAG_USER_PAGE_END && offset < maxLen; page++)
    {
        uint8_t data[NTAG_PAGE_SIZE];
        if (!nfc.ntag2xx_ReadPage(page, data))
        {
            Serial.print("[NFC] Read failed at page ");
            Serial.println(page);
            return -1; // incomplete read — tag likely removed
        }
        int toCopy = min(NTAG_PAGE_SIZE, maxLen - offset);
        memcpy(buf + offset, data, toCopy);
        offset += toCopy;

        // Stop at null terminator
        for (int i = 0; i < toCopy; i++)
        {
            if (data[i] == 0)
            {
                return offset;
            }
        }
    }
    return offset;
}

/// Parse tag data in format "<type>:<wp>:<path>" and send mount command over UART.
void handleTagData(const uint8_t *data, int len)
{
    // Ensure null-terminated
    char tagStr[NTAG_MAX_USER_BYTES + 1];
    int copyLen = min(len, NTAG_MAX_USER_BYTES);
    memcpy(tagStr, data, copyLen);
    tagStr[copyLen] = '\0';

    // Strip trailing nulls/whitespace
    for (int i = copyLen - 1; i >= 0; i--)
    {
        if (tagStr[i] == '\0' || tagStr[i] == '\n' || tagStr[i] == '\r' || tagStr[i] == ' ')
        {
            tagStr[i] = '\0';
        }
        else
        {
            break;
        }
    }

    // Parse: <type>:<wp>:<path>
    // type = 'F' or 'C', wp = '0' or '1', path = rest
    Serial.print("[NFC] Tag data: \"");
    Serial.print(tagStr);
    Serial.println("\"");

    if (strlen(tagStr) < 5 || tagStr[1] != ':' || tagStr[3] != ':')
    {
        Serial.println("[NFC] Invalid format, ignoring");
        return; // invalid format
    }

    char type = tagStr[0];
    char wp = tagStr[2];
    const char *path = &tagStr[4];

    if (type != 'F' && type != 'C')
    {
        Serial.println("[NFC] Invalid type, ignoring");
        return;
    }
    if (wp != '0' && wp != '1')
    {
        Serial.println("[NFC] Invalid write-protect, ignoring");
        return;
    }
    if (strlen(path) == 0)
    {
        Serial.println("[NFC] Empty path, ignoring");
        return;
    }

    lastTagType = type;
    lastTagWp = wp;
    strncpy(lastTagPath, path, sizeof(lastTagPath) - 1);
    lastTagPath[sizeof(lastTagPath) - 1] = '\0';

    if (type == 'F')
    {
        Serial.print("[NFC] Sending: fddload 0 ");
        Serial.print(path);
        Serial.print(" ");
        Serial.println(wp);
        Serial2.print("fddload 0 ");
        Serial2.print(path);
        Serial2.print(" ");
        Serial2.println(wp);
    }
    else
    {
        Serial.print("[NFC] Sending: cdload 0 ");
        Serial.println(path);
        Serial2.print("cdload 0 ");
        Serial2.println(path);
    }

    tagMounted = true;
    tagEjected = false;
}

bool sameUid(const uint8_t *a, uint8_t aLen, const uint8_t *b, uint8_t bLen)
{
    if (aLen != bLen)
        return false;
    return memcmp(a, b, aLen) == 0;
}

void pollNfc()
{
    uint8_t uid[7];
    uint8_t uidLen = 0;

    Serial.println("[NFC] Polling...");
    bool found = nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLen, 100);

    if (found)
    {
        missedPolls = 0;

        Serial.print("[NFC] Tag found, UID: ");
        for (uint8_t i = 0; i < uidLen; i++)
        {
            if (uid[i] < 0x10)
                Serial.print("0");
            Serial.print(uid[i], HEX);
        }
        Serial.println();

        // Same tag as already mounted → no-op
        if (tagMounted && !tagEjected && sameUid(uid, uidLen, lastTagUid, lastTagUidLen))
        {
            Serial.println("[NFC] Same tag already mounted, skipping");
            return;
        }

        // New tag (or re-inserted after eject) — read and mount
        memcpy(lastTagUid, uid, uidLen);
        lastTagUidLen = uidLen;

        uint8_t tagData[NTAG_MAX_USER_BYTES];
        int bytesRead = -1;
        for (int attempt = 0; attempt < 3; attempt++)
        {
            bytesRead = readNtagUserData(tagData, sizeof(tagData));
            if (bytesRead >= 0)
                break;
            Serial.print("[NFC] Incomplete read (attempt ");
            Serial.print(attempt + 1);
            Serial.println("/3), retrying...");
        }

        Serial.print("[NFC] Read ");
        Serial.print(bytesRead);
        Serial.println(" bytes from tag");
        if (bytesRead > 0)
        {
            handleTagData(tagData, bytesRead);
        }
        else if (bytesRead == -1)
        {
            Serial.println("[NFC] Incomplete read, ignoring tag");
        }
        else
        {
            Serial.println("[NFC] No data on tag");
        }
    }
    else
    {
        // No tag found
        if (tagMounted && !tagEjected)
        {
            missedPolls++;
            Serial.print("[NFC] No tag, missed polls: ");
            Serial.println(missedPolls);
            if (missedPolls >= EJECT_MISS_COUNT)
            {
                // Send eject
                if (lastTagType == 'F')
                {
                    Serial.println("[NFC] Sending: fddeject 0");
                    Serial2.println("fddeject 0");
                }
                else if (lastTagType == 'C')
                {
                    Serial.println("[NFC] Sending: cdeject 0");
                    Serial2.println("cdeject 0");
                }
                tagEjected = true;
                tagMounted = false;
                lastTagPath[0] = '\0';
                missedPolls = 0;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Arduino setup / loop
// ---------------------------------------------------------------------------
void setup()
{
    // LED pins
    pinMode(LED_POWER, OUTPUT);
    pinMode(LED_HDD, OUTPUT);
    pinMode(LED_FLOPPY, OUTPUT);
    pinMode(LED_CD, OUTPUT);
    pinMode(LED_NET, OUTPUT);

    // Power LED starts off — pi486 will turn it on when socket connects
    digitalWrite(LED_POWER, LOW);
    setAllLeds(LOW);

    // UART to Raspberry Pi (Serial2 on WROOM-32, explicit pin assignment)
    Serial2.begin(SERIAL_BAUD, SERIAL_8N1, PI_UART_RX, PI_UART_TX);

    // USB serial for debug output
    Serial.begin(SERIAL_BAUD);
    Serial.println("pi486 appliance starting");

    // PN532 init
    Wire.begin(PN532_SDA, PN532_SCL);
    nfc.begin();

    uint32_t versiondata = nfc.getFirmwareVersion();
    if (!versiondata)
    {
        Serial.println("ERROR: PN532 not found");
    }
    else
    {
        Serial.print("PN532 firmware: ");
        Serial.println((versiondata >> 8) & 0xFF, DEC);
        nfc.SAMConfig();
    }
}

void loop()
{
    // Process incoming serial data from Pi (line-buffered)
    while (Serial2.available())
    {
        char c = Serial2.read();
        if (c == '\n' || c == '\r')
        {
            if (linePos > 0)
            {
                lineBuf[linePos] = '\0';
                processSerialLine(lineBuf);
                linePos = 0;
            }
        }
        else if (linePos < sizeof(lineBuf) - 1)
        {
            lineBuf[linePos++] = c;
        }
    }

    // Poll NFC at interval
    unsigned long now = millis();
    if (now - lastNfcPoll >= NFC_POLL_MS)
    {
        lastNfcPoll = now;
        pollNfc();
    }
}

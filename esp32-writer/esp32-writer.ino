/*
 * pi486 NFC Writer — ESP32-C6 firmware
 *
 * Hardware:
 *   USB-CDC serial to PC (for commands from web UI)
 *   PN532 NFC → I2C (SDA=GPIO6, SCL=GPIO7 on XIAO ESP32-C6)
 *
 * Protocol (line-based over USB serial):
 *   → write <data>    Write tag data (e.g. "write F:0:Win95Boot.img")
 *   → read            Read current tag contents
 *   → erase           Erase tag (zero user pages)
 *   ← OK <data>       Success response
 *   ← ERR <message>   Error response
 */

#include <Wire.h>
#include <Adafruit_PN532.h>

// PN532 I2C pins (XIAO ESP32-C6 defaults)
#define PN532_SDA SDA
#define PN532_SCL SCL

// NTAG215 layout
#define NTAG_USER_PAGE_START 4
#define NTAG_USER_PAGE_END   129
#define NTAG_MAX_USER_BYTES  504
#define NTAG_PAGE_SIZE       4

// Timeout for waiting for a tag (ms)
#define TAG_WAIT_TIMEOUT_MS  10000

Adafruit_PN532 nfc(PN532_SDA, PN532_SCL);

char cmdBuf[600];
int  cmdPos = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Wait for an NTAG215 tag to appear. Returns true if found within timeout.
bool waitForTag(uint8_t *uid, uint8_t *uidLen, unsigned long timeoutMs) {
    unsigned long start = millis();
    while (millis() - start < timeoutMs) {
        if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, uidLen, 200)) {
            return true;
        }
    }
    return false;
}

/// Write data to NTAG215 user pages. Returns true on success.
bool writeNtagUserData(const uint8_t *data, int len) {
    if (len > NTAG_MAX_USER_BYTES) return false;

    // Pad to page boundary
    int totalPages = (len + NTAG_PAGE_SIZE - 1) / NTAG_PAGE_SIZE;

    for (int i = 0; i < totalPages; i++) {
        uint8_t page[NTAG_PAGE_SIZE] = {0};
        int offset = i * NTAG_PAGE_SIZE;
        int toCopy = min(NTAG_PAGE_SIZE, len - offset);
        if (toCopy > 0) {
            memcpy(page, data + offset, toCopy);
        }
        if (!nfc.ntag2xx_WritePage(NTAG_USER_PAGE_START + i, page)) {
            return false;
        }
    }
    return true;
}

/// Read NTAG215 user data. Returns bytes read.
int readNtagUserData(uint8_t *buf, int maxLen) {
    int offset = 0;
    for (uint8_t page = NTAG_USER_PAGE_START; page <= NTAG_USER_PAGE_END && offset < maxLen; page += 4) {
        uint8_t data[16];
        if (!nfc.ntag2xx_ReadPage(page, data)) {
            break;
        }
        int toCopy = min(16, maxLen - offset);
        memcpy(buf + offset, data, toCopy);
        offset += toCopy;

        // Stop at null terminator
        for (int i = 0; i < toCopy; i++) {
            if (data[i] == 0) {
                return offset;
            }
        }
    }
    return offset;
}

/// Zero all user pages on the tag.
bool eraseNtagUserData() {
    uint8_t zeros[NTAG_PAGE_SIZE] = {0};
    for (uint8_t page = NTAG_USER_PAGE_START; page <= NTAG_USER_PAGE_END; page++) {
        if (!nfc.ntag2xx_WritePage(page, zeros)) {
            return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

void handleWrite(const char *data) {
    int len = strlen(data);
    if (len == 0) {
        Serial.println("ERR empty data");
        return;
    }
    if (len > NTAG_MAX_USER_BYTES) {
        Serial.println("ERR data too long (max 504 bytes)");
        return;
    }

    // Validate format: <type>:<wp>:<path>
    if (len < 5 || data[1] != ':' || data[3] != ':') {
        Serial.println("ERR invalid format, expected <type>:<wp>:<path>");
        return;
    }
    if (data[0] != 'F' && data[0] != 'C') {
        Serial.println("ERR type must be F or C");
        return;
    }
    if (data[2] != '0' && data[2] != '1') {
        Serial.println("ERR write-protect must be 0 or 1");
        return;
    }

    Serial.println("OK waiting for tag...");

    uint8_t uid[7];
    uint8_t uidLen;
    if (!waitForTag(uid, &uidLen, TAG_WAIT_TIMEOUT_MS)) {
        Serial.println("ERR timeout waiting for tag");
        return;
    }

    // Write the data (including null terminator)
    if (writeNtagUserData((const uint8_t *)data, len + 1)) {
        Serial.print("OK written ");
        Serial.print(len);
        Serial.println(" bytes");
    } else {
        Serial.println("ERR write failed");
    }
}

void handleRead() {
    Serial.println("OK waiting for tag...");

    uint8_t uid[7];
    uint8_t uidLen;
    if (!waitForTag(uid, &uidLen, TAG_WAIT_TIMEOUT_MS)) {
        Serial.println("ERR timeout waiting for tag");
        return;
    }

    uint8_t buf[NTAG_MAX_USER_BYTES + 1];
    memset(buf, 0, sizeof(buf));
    int bytesRead = readNtagUserData(buf, NTAG_MAX_USER_BYTES);

    if (bytesRead > 0) {
        buf[bytesRead] = '\0';
        Serial.print("OK ");
        Serial.println((const char *)buf);
    } else {
        Serial.println("ERR read failed or tag empty");
    }
}

void handleErase() {
    Serial.println("OK waiting for tag...");

    uint8_t uid[7];
    uint8_t uidLen;
    if (!waitForTag(uid, &uidLen, TAG_WAIT_TIMEOUT_MS)) {
        Serial.println("ERR timeout waiting for tag");
        return;
    }

    if (eraseNtagUserData()) {
        Serial.println("OK erased");
    } else {
        Serial.println("ERR erase failed");
    }
}

void processCommand(const char *line) {
    if (strncmp(line, "write ", 6) == 0) {
        handleWrite(line + 6);
    } else if (strcmp(line, "read") == 0) {
        handleRead();
    } else if (strcmp(line, "erase") == 0) {
        handleErase();
    } else {
        Serial.print("ERR unknown command: ");
        Serial.println(line);
    }
}

// ---------------------------------------------------------------------------
// Arduino setup / loop
// ---------------------------------------------------------------------------

void setup() {
    Serial.begin(115200);
    while (!Serial) delay(10); // Wait for USB serial

    Serial.println("pi486 NFC writer ready");

    Wire.begin(PN532_SDA, PN532_SCL);
    nfc.begin();

    uint32_t versiondata = nfc.getFirmwareVersion();
    if (!versiondata) {
        Serial.println("ERR PN532 not found");
    } else {
        Serial.print("OK PN532 firmware v");
        Serial.println((versiondata >> 8) & 0xFF, DEC);
        nfc.SAMConfig();
    }
}

void loop() {
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n' || c == '\r') {
            if (cmdPos > 0) {
                cmdBuf[cmdPos] = '\0';
                processCommand(cmdBuf);
                cmdPos = 0;
            }
        } else if (cmdPos < (int)sizeof(cmdBuf) - 1) {
            cmdBuf[cmdPos++] = c;
        }
    }
}

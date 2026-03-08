# pi486

A middleware system for a Raspberry Pi 5 based 86Box Win95/i486 emulation appliance. Bridges the 86Box emulator (via its unix socket control interface) with physical hardware — status LEDs and NFC-based disc swapping — through an ESP32-C6 microcontroller.

## Components

### `pi486` — Rust binary (runs on the Pi)

Async bridge between the 86Box unix control socket and a serial-connected ESP32-C6.

- Forwards `!led` and `!media` status events from 86Box to serial for LED control
- Receives `fddload`/`cdload`/`fddeject`/`cdeject` mount commands from serial (NFC tag reads) and relays them to 86Box with an optional path prefix
- Optionally polls `screencrc` and sends `exit` when the screen matches a target CRC + dimensions (for auto-shutdown when the emulated OS has shut down)
- Reconnects automatically when 86Box restarts

```
pi486 --socket /tmp/86box.sock \
      --serial /dev/ttyAMA0 \
      --fdd-prefix /mnt/floppy/ \
      --cd-prefix /mnt/cdrom/ \
      --screencrc "27CDAD2E 656 416"
```

| Flag | Required | Description |
|------|----------|-------------|
| `--socket`, `-U` | yes | 86Box unix control socket path |
| `--serial`, `-S` | no | Serial port device (falls back to stdio) |
| `--baud`, `-b` | no | Baud rate (default: 115200) |
| `--screencrc`, `-C` | no | `"<CRC> <WIDTH> <HEIGHT>"` — auto-exit trigger |
| `--fdd-prefix` | no | Path prefix for floppy mount commands |
| `--cd-prefix` | no | Path prefix for CD-ROM mount commands |

### `esp32-appliance/` — Arduino firmware (XIAO ESP32-C6)

Connects to the Pi via 3.3V TTL UART on GPIO 14/15. Drives status LEDs and reads NFC tags.

- **LEDs**: Power, HDD, Floppy, CD, Network — driven by `!led` events from serial
- **NFC reader**: PN532 over I2C, polls NTAG215 tags every 500ms
- **Tag insert**: Reads tag data, sends `fddload`/`cdload` command over UART
- **Tag removal**: 2 consecutive missed polls (~1s) triggers `fddeject`/`cdeject`

### `esp32-writer/` — Arduino firmware (XIAO ESP32-C6)

USB-connected NFC tag writer. Accepts commands over USB serial:

| Command | Description |
|---------|-------------|
| `write <data>` | Write tag (e.g. `write F:0:Win95Boot.img`) |
| `read` | Read current tag contents |
| `erase` | Zero all user pages |

### `writer-ui/` — Web UI for NFC tag writing

Browser-based UI using the Web Serial API to communicate with the writer ESP32. Built with TypeScript, Vite, React, TailwindCSS, and shadcn/ui components. Requires Chrome/Edge.

## NFC Tag Format

NTAG215 tags (504 bytes). Simple text format:

```
<type>:<write_protect>:<path>
```

| Field | Values | Description |
|-------|--------|-------------|
| type | `F`, `C` | Floppy or CD-ROM |
| write_protect | `0`, `1` | Write protection (floppy only) |
| path | string | Image filename (prefix added by pi486) |

**Examples:**
- `F:0:Win95Boot.img` → `fddload 0 /mnt/floppy/Win95Boot.img 0`
- `C:0:Quake.iso` → `cdload 0 /mnt/cdrom/Quake.iso`

## Project Structure

```
pi486/
├── Cargo.toml
├── flake.nix                       # Nix dev shell
├── src/
│   ├── main.rs                     # CLI, entry point
│   ├── bridge.rs                   # Socket ↔ serial event loop
│   ├── protocol.rs                 # Command parsing, path prefix, screencrc
│   ├── serial.rs                   # Serial port / stdio abstraction
│   └── socket.rs                   # Unix socket connection + reconnect
├── esp32-appliance/
│   └── esp32-appliance.ino         # Appliance firmware (LEDs + NFC reader)
├── esp32-writer/
│   └── esp32-writer.ino            # Writer firmware (USB serial + NFC writer)
└── writer-ui/                      # Web UI (Vite + React + TypeScript)
    ├── src/
    │   ├── App.tsx
    │   ├── lib/serial.ts           # Web Serial API abstraction
    │   └── components/ui/          # shadcn-style components
    └── package.json
```

## Building

### Rust binary

```sh
cargo build --release
```

### Writer web UI

```sh
cd writer-ui
npm install
npm run build
```

### ESP32 firmware

Open `esp32-appliance/esp32-appliance.ino` or `esp32-writer/esp32-writer.ino` in the Arduino IDE with ESP32-C6 board support installed. Requires the `Adafruit_PN532` library.

## Development

With Nix:

```sh
nix develop
```

This provides Rust toolchain, Node.js, and Arduino CLI in a single shell.

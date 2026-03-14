/// Web Serial API abstraction for communicating with the ESP32 NFC writer.

// Web Serial API type declarations
declare global {
  interface Navigator {
    serial: {
      requestPort(): Promise<SerialPortDevice>;
    };
  }

  interface SerialPortDevice {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
  }
}

type SerialListener = (line: string) => void;

export class SerialConnection {
  private port: SerialPortDevice | null = null;
  private rawReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopActive = false;
  private listeners: SerialListener[] = [];
  private _connected = false;
  private decoder = new TextDecoder();

  get connected(): boolean {
    return this._connected;
  }

  onLine(listener: SerialListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async connect(baudRate = 115200): Promise<void> {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial API not supported. Use Chrome or Edge.');
    }

    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate });
    this._connected = true;

    this.rawReader = this.port.readable!.getReader();
    this.writer = this.port.writable!.getWriter();

    this.readLoopActive = true;
    this.readLoop();
  }

  async disconnect(): Promise<void> {
    this.readLoopActive = false;

    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        /* ignore */
      }
      this.writer = null;
    }

    if (this.rawReader) {
      try {
        await this.rawReader.cancel();
      } catch {
        /* ignore */
      }
      try {
        this.rawReader.releaseLock();
      } catch {
        /* ignore */
      }
      this.rawReader = null;
    }

    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // Port may already be closed
      }
      this.port = null;
    }
    this._connected = false;
  }

  async sendCommand(cmd: string): Promise<void> {
    if (!this.writer) {
      throw new Error('Not connected');
    }
    await this.writer.write(new TextEncoder().encode(cmd + '\n'));
  }

  private async readLoop(): Promise<void> {
    let buffer = '';
    while (this.readLoopActive && this.rawReader) {
      try {
        const { value, done } = await this.rawReader.read();
        if (done) break;
        if (!value) continue;

        buffer += this.decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (trimmed.length > 0) {
            for (const listener of this.listeners) {
              listener(trimmed);
            }
          }
        }
      } catch {
        if (this.readLoopActive) {
          this._connected = false;
        }
        break;
      }
    }
  }
}

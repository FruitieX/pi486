/// Web Serial API abstraction for communicating with the ESP32 NFC writer.

// Web Serial API type declarations
declare global {
  interface Navigator {
    serial: {
      requestPort(): Promise<SerialPortDevice>
    }
  }

  interface SerialPortDevice {
    open(options: { baudRate: number }): Promise<void>
    close(): Promise<void>
    readable: ReadableStream<Uint8Array> | null
    writable: WritableStream<Uint8Array> | null
  }
}

type SerialListener = (line: string) => void

export class SerialConnection {
  private port: SerialPortDevice | null = null
  private reader: ReadableStreamDefaultReader<string> | null = null
  private writer: WritableStreamDefaultWriter<string> | null = null
  private readLoopActive = false
  private listeners: SerialListener[] = []
  private _connected = false

  get connected(): boolean {
    return this._connected
  }

  onLine(listener: SerialListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  async connect(baudRate = 115200): Promise<void> {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API not supported. Use Chrome or Edge.")
    }

    this.port = await navigator.serial.requestPort()
    await this.port.open({ baudRate })
    this._connected = true

    const writable = this.port.writable!
    const readable = this.port.readable!

    // Set up writer (text → bytes)
    const encoder = new TextEncoderStream()
    encoder.readable.pipeTo(writable)
    this.writer = encoder.writable.getWriter()

    // Set up reader (bytes → text)
    const decoder = new TextDecoderStream()
    readable.pipeTo(decoder.writable as unknown as WritableStream<Uint8Array>)
    this.reader = decoder.readable.getReader()

    this.readLoopActive = true
    this.readLoop()
  }

  async disconnect(): Promise<void> {
    this.readLoopActive = false
    this.reader?.cancel()
    this.reader = null
    this.writer?.close()
    this.writer = null

    if (this.port) {
      try {
        await this.port.close()
      } catch {
        // Port may already be closed
      }
      this.port = null
    }
    this._connected = false
  }

  async sendCommand(cmd: string): Promise<void> {
    if (!this.writer) {
      throw new Error("Not connected")
    }
    await this.writer.write(cmd + "\n")
  }

  private async readLoop(): Promise<void> {
    let buffer = ""
    while (this.readLoopActive && this.reader) {
      try {
        const { value, done } = await this.reader.read()
        if (done) break
        if (!value) continue

        buffer += value
        const lines = buffer.split("\n")
        // Keep the last incomplete chunk in the buffer
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trimEnd()
          if (trimmed.length > 0) {
            for (const listener of this.listeners) {
              listener(trimmed)
            }
          }
        }
      } catch {
        if (this.readLoopActive) {
          this._connected = false
        }
        break
      }
    }
  }
}

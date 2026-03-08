import { useState, useRef, useEffect } from "react"
import { SerialConnection } from "./lib/serial"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { Label } from "./components/ui/label"
import { Select } from "./components/ui/select"
import { Card, CardHeader, CardTitle, CardContent } from "./components/ui/card"
import { Usb, Disc, HardDrive, BookOpen, Trash2, CircleDot } from "lucide-react"

function App() {
  const serialRef = useRef(new SerialConnection())
  const logEndRef = useRef<HTMLDivElement>(null)

  const [connected, setConnected] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // Write form state
  const [mediaType, setMediaType] = useState<"F" | "C">("F")
  const [writeProtect, setWriteProtect] = useState(false)
  const [imagePath, setImagePath] = useState("")

  const addLog = (entry: string) => {
    setLog((prev) => [...prev.slice(-200), entry])
  }

  useEffect(() => {
    const unsubscribe = serialRef.current.onLine((line) => {
      addLog(`← ${line}`)
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [log])

  const handleConnect = async () => {
    try {
      if (connected) {
        await serialRef.current.disconnect()
        setConnected(false)
        addLog("Disconnected")
      } else {
        await serialRef.current.connect()
        setConnected(true)
        addLog("Connected")
      }
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const sendCommand = async (cmd: string) => {
    setBusy(true)
    try {
      addLog(`→ ${cmd}`)
      await serialRef.current.sendCommand(cmd)
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleWrite = () => {
    if (!imagePath.trim()) return
    const wp = mediaType === "F" ? (writeProtect ? "1" : "0") : "0"
    const data = `${mediaType}:${wp}:${imagePath.trim()}`
    sendCommand(`write ${data}`)
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">pi486 NFC Writer</h1>
          <Button
            onClick={handleConnect}
            variant={connected ? "destructive" : "default"}
          >
            {connected ? (
              <>
                <Usb className="h-4 w-4" />
                Disconnect
              </>
            ) : (
              <>
                <Usb className="h-4 w-4" />
                Connect
              </>
            )}
          </Button>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2 text-sm">
          <CircleDot className={`h-4 w-4 ${connected ? "text-green-500" : "text-muted-foreground"}`} />
          <span>{connected ? "Connected" : "Not connected"}</span>
        </div>

        {/* Write tag card */}
        <Card>
          <CardHeader>
            <CardTitle>Write Tag</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="media-type">Media Type</Label>
              <Select
                id="media-type"
                value={mediaType}
                onChange={(e) => setMediaType(e.target.value as "F" | "C")}
                disabled={!connected || busy}
              >
                <option value="F">Floppy Disk</option>
                <option value="C">CD-ROM</option>
              </Select>
            </div>

            {mediaType === "F" && (
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="write-protect"
                  checked={writeProtect}
                  onChange={(e) => setWriteProtect(e.target.checked)}
                  disabled={!connected || busy}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="write-protect">Write Protected</Label>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="image-path">Image Path</Label>
              <Input
                id="image-path"
                placeholder="e.g. Win95Boot.img"
                value={imagePath}
                onChange={(e) => setImagePath(e.target.value)}
                disabled={!connected || busy}
              />
              <p className="text-xs text-muted-foreground">
                Relative path — the mount prefix is added by pi486 on the Pi.
              </p>
            </div>

            <Button
              onClick={handleWrite}
              disabled={!connected || busy || !imagePath.trim()}
              className="w-full"
            >
              {mediaType === "F" ? (
                <HardDrive className="h-4 w-4" />
              ) : (
                <Disc className="h-4 w-4" />
              )}
              Write to Tag
            </Button>
          </CardContent>
        </Card>

        {/* Read / Erase actions */}
        <div className="grid grid-cols-2 gap-4">
          <Button
            variant="outline"
            onClick={() => sendCommand("read")}
            disabled={!connected || busy}
          >
            <BookOpen className="h-4 w-4" />
            Read Tag
          </Button>
          <Button
            variant="destructive"
            onClick={() => sendCommand("erase")}
            disabled={!connected || busy}
          >
            <Trash2 className="h-4 w-4" />
            Erase Tag
          </Button>
        </div>

        {/* Serial log */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Serial Log
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLog([])}
              >
                Clear
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48 overflow-y-auto rounded-md bg-muted p-3 font-mono text-xs">
              {log.length === 0 && (
                <span className="text-muted-foreground">No messages yet.</span>
              )}
              {log.map((entry, i) => (
                <div key={i} className={entry.startsWith("←") ? "text-green-400" : entry.startsWith("Error") ? "text-red-400" : "text-foreground"}>
                  {entry}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export default App

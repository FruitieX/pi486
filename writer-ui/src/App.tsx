import { useState, useRef, useEffect } from 'react';
import { SerialConnection } from './lib/serial';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Select } from './components/ui/select';
import { Card, CardHeader, CardTitle, CardContent } from './components/ui/card';
import {
  Usb,
  Disc,
  HardDrive,
  BookOpen,
  Trash2,
  CircleDot,
  XCircle,
  FolderOpen,
} from 'lucide-react';

function App() {
  const serialRef = useRef(new SerialConnection());
  const logEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<(() => void) | null>(null);
  // Write form state
  const [mediaType, setMediaType] = useState<'F' | 'C'>('C');
  const [writeProtect, setWriteProtect] = useState(false);
  const [imagePath, setImagePath] = useState('');

  const addLog = (entry: string) => {
    setLog((prev) => [...prev.slice(-200), entry]);
  };

  useEffect(() => {
    const unsubscribe = serialRef.current.onLine((line) => {
      addLog(`← ${line}`);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [log]);

  const handleConnect = async () => {
    try {
      if (connected) {
        if (busy) {
          try {
            await serialRef.current.sendCommand('cancel');
          } catch {
            /* ignore if send fails */
          }
          cancelRef.current?.();
          setBusy(false);
        }
        await serialRef.current.disconnect();
        setConnected(false);
        addLog('Disconnected');
      } else {
        await serialRef.current.connect();
        setConnected(true);
        addLog('Connected');
      }
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Send a command and wait until a response line matches the predicate. */
  const sendCommandAndWait = (
    cmd: string,
    predicate: (line: string) => boolean,
  ): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        unsubscribe();
        cancelRef.current = null;
      };

      const unsubscribe = serialRef.current.onLine((line) => {
        if (predicate(line)) {
          cleanup();
          resolve(line);
        }
      });

      cancelRef.current = () => {
        cleanup();
        reject(new Error('cancelled'));
      };

      setBusy(true);
      addLog(`→ ${cmd}`);
      serialRef.current.sendCommand(cmd).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  };

  const handleCancel = async () => {
    addLog('→ cancel');
    try {
      await serialRef.current.sendCommand('cancel');
    } catch {
      // ignore if not connected
    }
    // Always cancel client-side too — if the ESP32 response arrives later
    // it will just appear in the log without affecting any pending command.
    cancelRef.current?.();
  };

  const isOkOrErr = (line: string) =>
    (line.startsWith('OK') && !line.startsWith('OK waiting')) ||
    line.startsWith('ERR');

  const handleWrite = async () => {
    if (!imagePath.trim()) return;
    const wp = mediaType === 'F' ? (writeProtect ? '1' : '0') : '0';
    const data = `${mediaType}:${wp}:${imagePath.trim()}`;
    try {
      const result = await sendCommandAndWait(
        `write ${data}`,
        (line) => line.startsWith('OK written') || line.startsWith('ERR'),
      );
      if (result.startsWith('OK written')) {
        await sendCommandAndWait('read', isOkOrErr);
      }
    } catch (err) {
      if (err instanceof Error && err.message !== 'cancelled')
        addLog(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRead = async () => {
    try {
      await sendCommandAndWait('read', isOkOrErr);
    } catch (err) {
      if (err instanceof Error && err.message !== 'cancelled')
        addLog(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleErase = async () => {
    try {
      const result = await sendCommandAndWait(
        'erase',
        (line) => line.startsWith('OK erased') || line.startsWith('ERR'),
      );
      if (result.startsWith('OK erased')) {
        await sendCommandAndWait('read', isOkOrErr);
      }
    } catch (err) {
      if (err instanceof Error && err.message !== 'cancelled')
        addLog(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">pi486 NFC Writer</h1>
          <Button
            onClick={handleConnect}
            variant={connected ? 'destructive' : 'default'}
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
          <CircleDot
            className={`h-4 w-4 ${connected ? 'text-green-500' : 'text-muted-foreground'}`}
          />
          <span>{connected ? 'Connected' : 'Not connected'}</span>
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
                onChange={(e) => setMediaType(e.target.value as 'F' | 'C')}
                disabled={!connected || busy}
              >
                <option value="C">CD-ROM</option>
                <option value="F">Floppy Disk</option>
              </Select>
            </div>

            {mediaType === 'F' && (
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
              <div className="flex gap-2">
                <Input
                  id="image-path"
                  placeholder="e.g. Win95Boot.img"
                  value={imagePath}
                  onChange={(e) => setImagePath(e.target.value)}
                  disabled={!connected || busy}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) setImagePath(file.name);
                    e.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!connected || busy}
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Relative path — the mount prefix is added by pi486 on the Pi.
              </p>
            </div>

            <Button
              onClick={handleWrite}
              disabled={!connected || busy || !imagePath.trim()}
              className="w-full"
            >
              {mediaType === 'F' ? (
                <HardDrive className="h-4 w-4" />
              ) : (
                <Disc className="h-4 w-4" />
              )}
              Write to Tag
            </Button>
          </CardContent>
        </Card>

        {/* Read / Erase / Cancel actions */}
        <div className="grid grid-cols-3 gap-4">
          <Button
            variant="outline"
            onClick={handleRead}
            disabled={!connected || busy}
          >
            <BookOpen className="h-4 w-4" />
            Read Tag
          </Button>
          <Button
            variant="destructive"
            onClick={handleErase}
            disabled={!connected || busy}
          >
            <Trash2 className="h-4 w-4" />
            Erase Tag
          </Button>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={!connected || !busy}
          >
            <XCircle className="h-4 w-4" />
            Cancel
          </Button>
        </div>

        {/* Serial log */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              Serial Log
              <Button variant="ghost" size="sm" onClick={() => setLog([])}>
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
                <div
                  key={i}
                  className={
                    entry.startsWith('←')
                      ? 'text-green-400'
                      : entry.startsWith('Error')
                        ? 'text-red-400'
                        : 'text-foreground'
                  }
                >
                  {entry}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export default App;

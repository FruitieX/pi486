use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tracing::{debug, info, warn};

/// A connected 86Box unix socket with line-based I/O.
pub struct SocketConn {
    reader: BufReader<tokio::io::ReadHalf<UnixStream>>,
    writer: tokio::io::WriteHalf<UnixStream>,
}

impl SocketConn {
    /// Try to connect to the unix socket at `path`.
    pub async fn connect(path: &str) -> Result<Self> {
        let stream = UnixStream::connect(path)
            .await
            .with_context(|| format!("connecting to socket {path}"))?;
        let (read_half, write_half) = tokio::io::split(stream);
        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
        })
    }

    /// Read the next line from the socket. Returns `None` on EOF (disconnect).
    pub async fn read_line(&mut self) -> Result<Option<String>> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .await
            .context("reading from socket")?;
        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        debug!(line = trimmed, "socket rx");
        Ok(Some(trimmed.to_string()))
    }

    /// Send a command line to the socket (appends newline).
    pub async fn send(&mut self, cmd: &str) -> Result<()> {
        debug!(cmd, "socket tx");
        self.writer
            .write_all(format!("{cmd}\n").as_bytes())
            .await
            .context("writing to socket")?;
        self.writer.flush().await.context("flushing socket")?;
        Ok(())
    }

    /// Send a command and read one response line.
    pub async fn send_recv(&mut self, cmd: &str) -> Result<Option<String>> {
        self.send(cmd).await?;
        self.read_line().await
    }
}

/// Repeatedly try to connect to the socket with a delay between attempts.
/// Returns `None` if the cancellation token fires before connecting.
pub async fn connect_loop(
    path: &str,
    cancel: tokio_util::sync::CancellationToken,
) -> Option<SocketConn> {
    loop {
        match SocketConn::connect(path).await {
            Ok(conn) => {
                info!(path, "connected to 86Box socket");
                return Some(conn);
            }
            Err(e) => {
                warn!(path, error = %e, "socket connect failed, retrying in 2s");
            }
        }
        tokio::select! {
            () = cancel.cancelled() => return None,
            () = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
        }
    }
}

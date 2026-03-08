use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::debug;

/// Abstraction over serial port or stdio for line-based I/O.
pub enum SerialPort {
    Stdio {
        reader: BufReader<tokio::io::Stdin>,
        writer: tokio::io::Stdout,
    },
    Serial {
        reader: BufReader<tokio::io::ReadHalf<tokio_serial::SerialStream>>,
        writer: tokio::io::WriteHalf<tokio_serial::SerialStream>,
    },
}

impl SerialPort {
    /// Open a serial port device, or fall back to stdio if no path given.
    pub fn open(path: Option<&str>, baud: u32) -> Result<Self> {
        match path {
            Some(device) => {
                let builder = tokio_serial::new(device, baud);
                let stream = tokio_serial::SerialStream::open(&builder)
                    .with_context(|| format!("opening serial port {device}"))?;
                let (r, w) = tokio::io::split(stream);
                Ok(Self::Serial {
                    reader: BufReader::new(r),
                    writer: w,
                })
            }
            None => Ok(Self::Stdio {
                reader: BufReader::new(tokio::io::stdin()),
                writer: tokio::io::stdout(),
            }),
        }
    }

    /// Read the next line from serial/stdio. Returns `None` on EOF.
    pub async fn read_line(&mut self) -> Result<Option<String>> {
        let mut line = String::new();
        let n = match self {
            Self::Stdio { reader, .. } => reader.read_line(&mut line).await,
            Self::Serial { reader, .. } => reader.read_line(&mut line).await,
        }
        .context("reading from serial")?;

        if n == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
        debug!(line = trimmed, "serial rx");
        Ok(Some(trimmed.to_string()))
    }

    /// Write a line to serial/stdio (appends newline).
    pub async fn write_line(&mut self, line: &str) -> Result<()> {
        debug!(line, "serial tx");
        let data = format!("{line}\n");
        match self {
            Self::Stdio { writer, .. } => {
                writer.write_all(data.as_bytes()).await?;
                writer.flush().await?;
            }
            Self::Serial { writer, .. } => {
                writer.write_all(data.as_bytes()).await?;
                writer.flush().await?;
            }
        }
        Ok(())
    }
}

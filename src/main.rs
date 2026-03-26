mod bridge;
mod protocol;
mod serial;
mod socket;

use anyhow::Result;
use clap::Parser;
use tracing::info;

#[derive(Parser, Debug)]
#[command(
    name = "pi486",
    about = "86Box ↔ hardware bridge for Raspberry Pi appliance"
)]
pub struct Args {
    /// Path to the 86Box unix control socket
    #[arg(short = 'U', long)]
    socket: String,

    /// Serial port device path (e.g. /dev/ttyAMA0). If omitted, uses stdio.
    #[arg(short = 'S', long)]
    serial: Option<String>,

    /// Serial baud rate
    #[arg(short, long, default_value_t = 115200)]
    baud: u32,

    /// Screen CRC match string: "<CRC> <WIDTH> <HEIGHT>" (e.g. "27CDAD2E 656 416").
    /// When the screencrc response matches, sends exit to 86Box.
    #[arg(short = 'C', long)]
    screencrc: Option<String>,

    /// Path prefix prepended to floppy mount paths from serial (e.g. /mnt/floppy/)
    #[arg(long)]
    fdd_prefix: Option<String>,

    /// Path prefix prepended to CD-ROM mount paths from serial (e.g. /mnt/cdrom/)
    #[arg(long)]
    cd_prefix: Option<String>,

    /// Combine FDD and CD-ROM activity LEDs: activity on either device is sent
    /// as both FDD and CD LED events to the ESP32 appliance.
    #[arg(long, default_value_t = false)]
    combine_disk_leds: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args = Args::parse();

    if let Some(ref crc) = args.screencrc {
        protocol::parse_screencrc_target(crc)?;
    }

    info!(
        socket = %args.socket,
        serial = ?args.serial,
        baud = args.baud,
        screencrc = ?args.screencrc,
        fdd_prefix = ?args.fdd_prefix,
        cd_prefix = ?args.cd_prefix,
        combine_disk_leds = args.combine_disk_leds,
        "starting pi486"
    );

    bridge::run(args).await
}

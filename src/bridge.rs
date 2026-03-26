use std::time::Duration;

use anyhow::Result;
use tokio::time::{MissedTickBehavior, interval};
use tracing::{info, warn};

use crate::Args;
use crate::protocol::{
    self, MountPrefixes, ScreenCrcTarget, all_leds_off_lines, build_socket_command, is_event_line,
    parse_serial_command, power_led_on_line, rewrite_combined_led_events, screencrc_matches,
};
use crate::serial::SerialPort;
use crate::socket::{self, SocketConn};

/// Main run loop: connect → bridge → disconnect → repeat.
pub async fn run(args: Args) -> Result<()> {
    let cancel = tokio_util::sync::CancellationToken::new();
    let token = cancel.clone();

    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("received SIGINT, shutting down");
        token.cancel();
    });

    let screencrc_target = args
        .screencrc
        .as_deref()
        .map(protocol::parse_screencrc_target)
        .transpose()?;

    let mount_prefixes = MountPrefixes {
        fdd: args.fdd_prefix.clone(),
        cd: args.cd_prefix.clone(),
    };

    let mut serial = SerialPort::open(args.serial.as_deref(), args.baud)?;

    loop {
        if cancel.is_cancelled() {
            info!("shutdown requested");
            break;
        }

        info!(socket = %args.socket, "waiting for 86Box socket");
        let Some(conn) = socket::connect_loop(&args.socket, cancel.clone()).await else {
            break;
        };

        if let Err(e) = run_bridge(
            conn,
            &mut serial,
            screencrc_target.as_ref(),
            &mount_prefixes,
            args.combine_disk_leds,
            cancel.clone(),
        )
        .await
        {
            warn!(error = %e, "bridge session ended with error");
        }

        info!("disconnected from 86Box, will reconnect");
    }

    info!("pi486 exiting");
    Ok(())
}

/// Bridge a single socket session: multiplex socket events to serial and serial commands to socket.
async fn run_bridge(
    mut conn: SocketConn,
    serial: &mut SerialPort,
    screencrc_target: Option<&ScreenCrcTarget>,
    mount_prefixes: &MountPrefixes,
    combine_disk_leds: bool,
    cancel: tokio_util::sync::CancellationToken,
) -> Result<()> {
    // Turn on the power LED when the socket session starts.
    serial.write_line(power_led_on_line()).await?;

    let mut crc_interval = interval(Duration::from_secs(1));
    crc_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Skip the first immediate tick so we don't poll screencrc right away.
    crc_interval.tick().await;

    let result: Result<()> = async {
        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    return Ok(());
                }

                // Read event lines from 86Box socket and forward to serial
                line = conn.read_line() => {
                    let Some(line) = line? else {
                        info!("socket disconnected (EOF)");
                        return Ok(());
                    };
                    if is_event_line(&line) {
                        for rewritten in rewrite_combined_led_events(&line, combine_disk_leds) {
                            serial.write_line(&rewritten).await?;
                        }
                    }
                }

                // Read commands from serial and forward to socket
                line = serial.read_line() => {
                    let Some(line) = line? else {
                        info!("serial EOF");
                        return Ok(());
                    };
                    if let Some(cmd) = parse_serial_command(&line) {
                        let socket_cmd = build_socket_command(&cmd, mount_prefixes);
                        info!(serial_line = %line, socket_cmd = %socket_cmd, "forwarding mount command");
                        conn.send(&socket_cmd).await?;
                    }
                }

                // Periodically poll screencrc if configured
                _ = crc_interval.tick(), if screencrc_target.is_some() => {
                    let target = screencrc_target.expect("guarded by if");
                    match conn.send_recv("screencrc").await? {
                        Some(resp) if screencrc_matches(&resp, target) => {
                            info!(response = %resp, "screencrc matched, sending exit");
                            conn.send("exit").await?;
                            return Ok(());
                        }
                        Some(_) => {}
                        None => {
                            info!("socket disconnected during screencrc poll");
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
    .await;

    // Turn all LEDs off when the bridge session ends (disconnect, exit, or cancel).
    send_all_leds_off(serial).await;

    result
}

/// Send LED-off commands for all devices to serial, ignoring write errors
/// (the serial port may already be closed).
async fn send_all_leds_off(serial: &mut SerialPort) {
    for line in all_leds_off_lines() {
        if let Err(e) = serial.write_line(&line).await {
            warn!(error = %e, "failed to send LED off command");
            break;
        }
    }
}

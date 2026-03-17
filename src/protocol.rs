use anyhow::{Result, bail};

/// Parsed screencrc target for matching against 86Box responses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenCrcTarget {
    pub crc: String,
    pub width: String,
    pub height: String,
}

/// Parse a screencrc target string in the format "<CRC> <WIDTH> <HEIGHT>".
pub fn parse_screencrc_target(s: &str) -> Result<ScreenCrcTarget> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    if parts.len() != 3 {
        bail!("screencrc must be in format \"<CRC> <WIDTH> <HEIGHT>\", got: {s:?}");
    }
    Ok(ScreenCrcTarget {
        crc: parts[0].to_uppercase(),
        width: parts[1].to_string(),
        height: parts[2].to_string(),
    })
}

/// Check whether a screencrc response line matches the target.
/// Expected response format: "OK <CRC> <WIDTH> <HEIGHT>"
pub fn screencrc_matches(response: &str, target: &ScreenCrcTarget) -> bool {
    let parts: Vec<&str> = response.split_whitespace().collect();
    if parts.len() < 4 || parts[0] != "OK" {
        return false;
    }
    parts[1].eq_ignore_ascii_case(&target.crc)
        && parts[2] == target.width
        && parts[3] == target.height
}

/// Result of parsing a serial mount/eject command from the ESP32.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SerialCommand {
    FddLoad { path: String, write_protect: u8 },
    CdLoad { path: String },
    FddEject,
    CdEject,
}

/// Parse a line received from serial into a command, if recognized.
/// Accepts: fddload 0 <path> <wp>, cdload 0 <path>, fddeject 0, cdeject 0
/// Filenames may contain spaces, so we avoid naive whitespace splitting.
pub fn parse_serial_command(line: &str) -> Option<SerialCommand> {
    let line = line.trim();

    if let Some(rest) = line.strip_prefix("fddload 0 ") {
        // rest = "<path> <wp>" — wp is the last token if it parses as u8
        if let Some((path, wp_str)) = rest.rsplit_once(' ') {
            if let Ok(wp) = wp_str.parse::<u8>() {
                return Some(SerialCommand::FddLoad {
                    path: path.to_string(),
                    write_protect: wp,
                });
            }
        }
        // No valid wp suffix — treat entire rest as path, default wp=0
        return Some(SerialCommand::FddLoad {
            path: rest.to_string(),
            write_protect: 0,
        });
    }

    if let Some(rest) = line.strip_prefix("cdload 0 ") {
        return Some(SerialCommand::CdLoad {
            path: rest.to_string(),
        });
    }

    if line.starts_with("fddeject") {
        return Some(SerialCommand::FddEject);
    }

    if line.starts_with("cdeject") {
        return Some(SerialCommand::CdEject);
    }

    None
}

/// Mount prefixes for floppy and CD-ROM paths.
#[derive(Debug, Clone, Default)]
pub struct MountPrefixes {
    pub fdd: Option<String>,
    pub cd: Option<String>,
}

/// Build the 86Box socket command string for a serial command, applying per-type mount prefixes.
pub fn build_socket_command(cmd: &SerialCommand, prefixes: &MountPrefixes) -> String {
    match cmd {
        SerialCommand::FddLoad {
            path,
            write_protect,
        } => {
            let full_path = prepend_prefix(path, prefixes.fdd.as_deref());
            format!("fddload 0 {full_path} {write_protect}")
        }
        SerialCommand::CdLoad { path } => {
            let full_path = prepend_prefix(path, prefixes.cd.as_deref());
            format!("cdload 0 {full_path}")
        }
        SerialCommand::FddEject => "fddeject 0".to_string(),
        SerialCommand::CdEject => "cdeject 0".to_string(),
    }
}

fn prepend_prefix(path: &str, prefix: Option<&str>) -> String {
    match prefix {
        Some(p) => {
            let p = p.trim_end_matches('/');
            let path = path.trim_start_matches('/');
            format!("{p}/{path}")
        }
        None => path.to_string(),
    }
}

/// Check if a line from the socket is a broadcast event (starts with '!').
pub fn is_event_line(line: &str) -> bool {
    line.starts_with('!')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_screencrc_target() {
        let t = parse_screencrc_target("27CDAD2E 656 416").unwrap();
        assert_eq!(t.crc, "27CDAD2E");
        assert_eq!(t.width, "656");
        assert_eq!(t.height, "416");
    }

    #[test]
    fn test_parse_screencrc_target_invalid() {
        assert!(parse_screencrc_target("27CDAD2E 656").is_err());
        assert!(parse_screencrc_target("").is_err());
    }

    #[test]
    fn test_screencrc_matches() {
        let target = parse_screencrc_target("27CDAD2E 656 416").unwrap();
        assert!(screencrc_matches("OK 27CDAD2E 656 416", &target));
        assert!(screencrc_matches("OK 27cdad2e 656 416", &target));
        assert!(!screencrc_matches("OK AABBCCDD 656 416", &target));
        assert!(!screencrc_matches("OK 27CDAD2E 800 600", &target));
        assert!(!screencrc_matches("ERR something", &target));
    }

    #[test]
    fn test_parse_serial_fddload() {
        let cmd = parse_serial_command("fddload 0 Win95Boot.img 0").unwrap();
        assert_eq!(
            cmd,
            SerialCommand::FddLoad {
                path: "Win95Boot.img".to_string(),
                write_protect: 0,
            }
        );
    }

    #[test]
    fn test_parse_serial_cdload() {
        let cmd = parse_serial_command("cdload 0 SomeGame.iso").unwrap();
        assert_eq!(
            cmd,
            SerialCommand::CdLoad {
                path: "SomeGame.iso".to_string(),
            }
        );
    }

    #[test]
    fn test_parse_serial_eject() {
        assert_eq!(
            parse_serial_command("fddeject 0"),
            Some(SerialCommand::FddEject)
        );
        assert_eq!(
            parse_serial_command("cdeject 0"),
            Some(SerialCommand::CdEject)
        );
    }

    #[test]
    fn test_parse_serial_unknown() {
        assert_eq!(parse_serial_command("unknown command"), None);
        assert_eq!(parse_serial_command(""), None);
    }

    #[test]
    fn test_build_socket_command_with_fdd_prefix() {
        let cmd = SerialCommand::FddLoad {
            path: "Win95Boot.img".to_string(),
            write_protect: 0,
        };
        let prefixes = MountPrefixes {
            fdd: Some("/mnt/floppy/".to_string()),
            cd: Some("/mnt/cdrom/".to_string()),
        };
        assert_eq!(
            build_socket_command(&cmd, &prefixes),
            "fddload 0 /mnt/floppy/Win95Boot.img 0"
        );
    }

    #[test]
    fn test_build_socket_command_with_cd_prefix() {
        let cmd = SerialCommand::CdLoad {
            path: "Game.iso".to_string(),
        };
        let prefixes = MountPrefixes {
            fdd: Some("/mnt/floppy/".to_string()),
            cd: Some("/mnt/cdrom/".to_string()),
        };
        assert_eq!(
            build_socket_command(&cmd, &prefixes),
            "cdload 0 /mnt/cdrom/Game.iso"
        );
    }

    #[test]
    fn test_build_socket_command_no_prefix() {
        let cmd = SerialCommand::CdLoad {
            path: "/full/path/Game.iso".to_string(),
        };
        let prefixes = MountPrefixes::default();
        assert_eq!(
            build_socket_command(&cmd, &prefixes),
            "cdload 0 /full/path/Game.iso"
        );
    }

    #[test]
    fn test_build_socket_command_eject() {
        let prefixes = MountPrefixes {
            fdd: Some("/mnt/floppy/".to_string()),
            cd: Some("/mnt/cdrom/".to_string()),
        };
        assert_eq!(
            build_socket_command(&SerialCommand::FddEject, &prefixes),
            "fddeject 0"
        );
        assert_eq!(
            build_socket_command(&SerialCommand::CdEject, &prefixes),
            "cdeject 0"
        );
    }

    #[test]
    fn test_prepend_prefix_normalizes_slashes() {
        assert_eq!(
            prepend_prefix("/img.iso", Some("/mnt/roms/")),
            "/mnt/roms/img.iso"
        );
        assert_eq!(
            prepend_prefix("img.iso", Some("/mnt/roms")),
            "/mnt/roms/img.iso"
        );
    }

    #[test]
    fn test_parse_serial_cdload_with_spaces() {
        let cmd = parse_serial_command("cdload 0 My image.iso").unwrap();
        assert_eq!(
            cmd,
            SerialCommand::CdLoad {
                path: "My image.iso".to_string(),
            }
        );
    }

    #[test]
    fn test_parse_serial_fddload_with_spaces() {
        let cmd = parse_serial_command("fddload 0 My floppy image.img 1").unwrap();
        assert_eq!(
            cmd,
            SerialCommand::FddLoad {
                path: "My floppy image.img".to_string(),
                write_protect: 1,
            }
        );
    }

    #[test]
    fn test_is_event_line() {
        assert!(is_event_line("!led fdd 0 write"));
        assert!(is_event_line("!media cdrom 0 ejected"));
        assert!(!is_event_line("OK loaded"));
        assert!(!is_event_line("ERR something"));
    }
}

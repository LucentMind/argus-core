//! Serde mirror of app/src/shared/diagnostics.ts. PROTOCOL_VERSION must match
//! DIAGNOSTICS_PROTOCOL_VERSION there.

use serde::{Deserialize, Serialize};

/// Per-process `command` cap. 256 B is ample for any future prefix/substring
/// labeling; see the spec's §8 "out of scope" note on the labeling feature
/// this was originally retained for.
pub const MAX_COMMAND_BYTES: usize = 256;

/// Truncate `s` to at most `max_bytes` bytes, cutting on a UTF-8 character
/// boundary so the result is always valid UTF-8. A single process's argv can
/// legitimately approach `ARG_MAX` (up to ~1 MiB on macOS); this is what keeps
/// one process from dominating a whole snapshot line.
pub fn truncate_command(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// v2: dropped `streaming` from Configure and removed the SetStreaming command.
/// The slow tick now always delivers its sample (main.rs no longer discards it),
/// which made `streaming` write-only dead weight — nothing in the sidecar ever
/// read it again. A stale v1 binary requires `streaming` on Configure and would
/// silently fail to configure against a v2-shaped payload missing that field, so
/// the version bump exists to make that drift loud rather than a silent no-op.
pub const PROTOCOL_VERSION: u32 = 2;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    SampleNow { version: u32, request_id: String },
    #[serde(rename_all = "camelCase")]
    Shutdown { version: u32 },
}

impl Command {
    pub fn version(&self) -> u32 {
        match self {
            Command::Configure { version, .. }
            | Command::SetSampleInterval { version, .. }
            | Command::SampleNow { version, .. }
            | Command::Shutdown { version } => *version,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSample {
    pub pid: u32,
    pub ppid: u32,
    pub start_time_ms: u64,
    pub run_time_ms: u64,
    pub name: String,
    pub command: String,
    pub status: String,
    pub cpu_time_ms: u64,
    pub resident_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub version: u32,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub sidecar_version: &'static str,
    pub pid: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    #[serde(rename = "type")]
    pub event_type: &'static str,
    pub sequence: u64,
    pub sampled_at_unix_ms: u64,
    pub collection_duration_micros: u64,
    pub scanned_process_count: usize,
    pub retained_process_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub processes: Vec<ProcessSample>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_a_configure_command() {
        let cmd: Command = serde_json::from_str(
            r#"{"version":2,"type":"configure","rootPid":42,"sampleIntervalMs":1000}"#,
        )
        .expect("configure should decode");
        match cmd {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1000);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn ignores_an_extra_streaming_field_on_configure_rather_than_erroring() {
        // serde ignores unrecognised struct fields by default, so a Configure
        // payload still carrying the old (now-removed) `streaming` field — e.g.
        // from a main process one commit behind this binary — decodes fine
        // instead of silently failing to configure the sidecar at all.
        let cmd: Command = serde_json::from_str(
            r#"{"version":2,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"streaming":true}"#,
        )
        .expect("extra unknown field should be ignored");
        assert!(matches!(cmd, Command::Configure { root_pid: 42, .. }));
    }

    #[test]
    fn set_streaming_is_no_longer_a_known_command() {
        let result: Result<Command, _> =
            serde_json::from_str(r#"{"version":2,"type":"setStreaming","streaming":true}"#);
        assert!(result.is_err());
    }

    #[test]
    fn serialises_a_snapshot_with_camel_case_keys_and_omits_absent_request_id() {
        let snap = Snapshot {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 5,
            collection_duration_micros: 9,
            scanned_process_count: 400,
            retained_process_count: 3,
            request_id: None,
            processes: vec![],
        };
        let json = serde_json::to_string(&snap).expect("serialises");
        assert!(json.contains("\"retainedProcessCount\":3"));
        assert!(json.contains("\"sampledAtUnixMs\":5"));
        assert!(!json.contains("requestId"));
    }

    #[test]
    fn truncate_command_leaves_a_short_string_untouched() {
        assert_eq!(truncate_command("node server.js", 256), "node server.js");
    }

    #[test]
    fn truncate_command_cuts_at_the_byte_cap() {
        let s = "a".repeat(300);
        let out = truncate_command(&s, 256);
        assert_eq!(out.len(), 256);
        assert_eq!(out, "a".repeat(256));
    }

    #[test]
    fn truncate_command_never_splits_a_multibyte_char() {
        // Each '€' is 3 bytes (0xE2 0x82 0xAC). A cap of 256 lands mid-character
        // (256 is not a multiple of 3), so the naive `&s[..256]` would panic on a
        // non-boundary byte index. The fixed cut point must be <= 256 and must
        // land on a full character.
        let s = "€".repeat(100); // 300 bytes total
        let out = truncate_command(&s, 256);
        assert!(out.len() <= 256);
        assert!(out.is_char_boundary(out.len()));
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
        // 256 / 3 = 85.33, so the cut must land on the 85th full '€' (255 bytes).
        assert_eq!(out, "€".repeat(85));
    }

    #[test]
    fn truncate_command_at_exactly_the_cap_is_unchanged() {
        let s = "a".repeat(256);
        assert_eq!(truncate_command(&s, 256), s);
    }

    #[test]
    fn a_snapshot_with_hundreds_of_max_length_commands_stays_comfortably_under_the_main_process_buffer_cap(
    ) {
        // Cross-checks the one invariant that makes the two-sided fix (this cap +
        // MAX_BUFFER_CHARS in app/src/main/services/diagnostics/sidecarClient.ts)
        // actually hold: every process capped at MAX_COMMAND_BYTES, even at a
        // process count far above anything realistic (the spec's §3 "generalisation"
        // table shows ~1900 average-sized processes reach the OLD uncapped bound),
        // must still serialise to well under the 1,000,000-character buffer cap on
        // the TypeScript side. The `1_000_000` below is a literal, not a shared
        // constant, so this only catches MAX_COMMAND_BYTES growing far enough to
        // close the gap (~6x today) — it can't catch MAX_BUFFER_CHARS shrinking on
        // the TS side. Keep the two numbers in sync by hand if either changes.
        let processes: Vec<ProcessSample> = (0..600)
            .map(|i| ProcessSample {
                pid: i,
                ppid: 1,
                start_time_ms: 0,
                run_time_ms: 0,
                name: "node".to_string(),
                command: truncate_command(&"x".repeat(MAX_COMMAND_BYTES * 2), MAX_COMMAND_BYTES),
                status: "Run".to_string(),
                cpu_time_ms: 0,
                resident_bytes: 0,
            })
            .collect();
        let snap = Snapshot {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: 1,
            sampled_at_unix_ms: 0,
            collection_duration_micros: 0,
            scanned_process_count: 600,
            retained_process_count: 600,
            request_id: None,
            processes,
        };
        let json = serde_json::to_string(&snap).expect("serialises");
        assert!(
            json.len() < 1_000_000,
            "snapshot of 600 max-length commands serialised to {} chars, not comfortably under the 1,000,000-char buffer cap",
            json.len()
        );
    }
}

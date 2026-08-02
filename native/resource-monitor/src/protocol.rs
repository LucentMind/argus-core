//! Serde mirror of app/src/shared/diagnostics.ts. PROTOCOL_VERSION must match
//! DIAGNOSTICS_PROTOCOL_VERSION there.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Command {
    #[serde(rename_all = "camelCase")]
    Configure {
        version: u32,
        root_pid: u32,
        sample_interval_ms: u64,
        streaming: bool,
    },
    #[serde(rename_all = "camelCase")]
    SetSampleInterval {
        version: u32,
        sample_interval_ms: u64,
    },
    #[serde(rename_all = "camelCase")]
    SetStreaming { version: u32, streaming: bool },
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
            | Command::SetStreaming { version, .. }
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
            r#"{"version":1,"type":"configure","rootPid":42,"sampleIntervalMs":1000,"streaming":true}"#,
        )
        .expect("configure should decode");
        match cmd {
            Command::Configure {
                root_pid,
                sample_interval_ms,
                streaming,
                ..
            } => {
                assert_eq!(root_pid, 42);
                assert_eq!(sample_interval_ms, 1000);
                assert!(streaming);
            }
            other => panic!("wrong variant: {other:?}"),
        }
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
}

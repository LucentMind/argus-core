mod protocol;
mod tree;

use protocol::{Command, Hello, ProcessSample, Snapshot, PROTOCOL_VERSION};
use std::io::{BufRead, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tree::{clamp_interval, select_tracked_pids};

const DEFAULT_INTERVAL_MS: u64 = 15_000;

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn refresh_kind() -> ProcessRefreshKind {
    // Disk usage is deliberately NOT refreshed: throughput was cut from the
    // design. without_tasks() skips walking per-thread entries.
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .without_tasks()
}

struct Monitor {
    system: System,
    sequence: u64,
    root_pid: u32,
}

impl Monitor {
    fn sample(&mut self, request_id: Option<String>) -> Snapshot {
        let started = Instant::now();
        self.system
            .refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());

        let rows: Vec<(u32, u32)> = self
            .system
            .processes()
            .iter()
            .map(|(pid, p)| (pid.as_u32(), p.parent().map(|pp| pp.as_u32()).unwrap_or(0)))
            .collect();

        let tracked = select_tracked_pids(&rows, self.root_pid);

        let mut processes: Vec<ProcessSample> = self
            .system
            .processes()
            .iter()
            .filter(|(pid, _)| tracked.contains(&pid.as_u32()))
            .map(|(pid, p)| ProcessSample {
                pid: pid.as_u32(),
                ppid: p.parent().map(|pp| pp.as_u32()).unwrap_or(0),
                start_time_ms: p.start_time().saturating_mul(1000),
                run_time_ms: p.run_time().saturating_mul(1000),
                name: p.name().to_string_lossy().to_string(),
                command: p
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
                status: format!("{:?}", p.status()),
                cpu_time_ms: p.accumulated_cpu_time(),
                resident_bytes: p.memory(),
            })
            .collect();
        processes.sort_by_key(|p| p.pid);

        self.sequence += 1;
        Snapshot {
            version: PROTOCOL_VERSION,
            event_type: "snapshot",
            sequence: self.sequence,
            sampled_at_unix_ms: now_unix_ms(),
            collection_duration_micros: started.elapsed().as_micros() as u64,
            scanned_process_count: rows.len(),
            retained_process_count: processes.len(),
            request_id,
            processes,
        }
    }
}

fn main() {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let hello = Hello {
        version: PROTOCOL_VERSION,
        event_type: "hello",
        sidecar_version: env!("CARGO_PKG_VERSION"),
        pid: std::process::id(),
    };
    let _ = writeln!(out, "{}", serde_json::to_string(&hello).unwrap_or_default());
    let _ = out.flush();

    // Reading stdin on its own thread keeps the sample timer honest: recv_timeout
    // below wakes for whichever comes first, a command or the next tick.
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) => {
                    if tx.send(l).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });

    let mut monitor = Monitor {
        system: System::new(),
        sequence: 0,
        root_pid: 0,
    };
    let mut interval_ms = DEFAULT_INTERVAL_MS;
    let mut configured = false;
    let mut next_sample_at = Instant::now() + Duration::from_millis(interval_ms);

    loop {
        let timeout = next_sample_at.saturating_duration_since(Instant::now());
        match rx.recv_timeout(timeout) {
            Ok(line) => {
                let cmd: Command = match serde_json::from_str(line.trim()) {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if cmd.version() != PROTOCOL_VERSION {
                    eprintln!("protocol version mismatch: {}", cmd.version());
                    std::process::exit(2);
                }
                match cmd {
                    Command::Configure {
                        root_pid,
                        sample_interval_ms,
                        ..
                    } => {
                        monitor.root_pid = root_pid;
                        interval_ms = clamp_interval(sample_interval_ms);
                        configured = true;
                        next_sample_at = Instant::now();
                    }
                    Command::SetSampleInterval {
                        sample_interval_ms, ..
                    } => {
                        interval_ms = clamp_interval(sample_interval_ms);
                        next_sample_at = Instant::now() + Duration::from_millis(interval_ms.max(1));
                    }
                    Command::SampleNow { request_id, .. } => {
                        if configured {
                            let snap = monitor.sample(Some(request_id));
                            let _ = writeln!(
                                out,
                                "{}",
                                serde_json::to_string(&snap).unwrap_or_default()
                            );
                            let _ = out.flush();
                        }
                    }
                    Command::Shutdown { .. } => return,
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if configured && interval_ms > 0 {
                    // Always deliver the tick's sample. The interval itself IS the
                    // rate limit: at FAST_INTERVAL_MS (page open) that's one snapshot
                    // a second; at SLOW_INTERVAL_MS (page closed) it's one every 15s,
                    // a deliberately low-rate heartbeat so main always has a recent
                    // sample and a delta baseline the moment the page opens, instead
                    // of a blank first render. Discarding this sample when nothing
                    // was listening used to be the point of `streaming`, but that
                    // just paid the full scan cost every tick for nothing.
                    let snap = monitor.sample(None);
                    let _ = writeln!(out, "{}", serde_json::to_string(&snap).unwrap_or_default());
                    let _ = out.flush();
                    next_sample_at = Instant::now() + Duration::from_millis(interval_ms);
                } else {
                    next_sample_at = Instant::now() + Duration::from_millis(1_000);
                }
            }
            // Parent died or closed our stdin. Exit rather than orphan ourselves.
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

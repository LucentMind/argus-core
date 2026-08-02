//! Pure tree-selection and clamping logic. Kept free of sysinfo and I/O so it
//! can be unit tested without spawning anything or touching the host.

use std::collections::{HashMap, HashSet, VecDeque};

pub const MIN_SAMPLE_INTERVAL_MS: u64 = 250;
pub const MAX_SAMPLE_INTERVAL_MS: u64 = 60_000;

/// (pid, ppid) pairs from a host-wide scan.
pub type PidRow = (u32, u32);

/// Breadth-first walk of the pid/ppid graph from a single root.
///
/// Argus spawns everything from the Electron main process, so one root reaches
/// every agent CLI, MCP server, npx->node grandchild and pack app. The
/// `tracked.insert` return value is the cycle guard: a malformed parent table
/// must terminate, not hang.
pub fn select_tracked_pids(rows: &[PidRow], root: u32) -> HashSet<u32> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut known: HashSet<u32> = HashSet::new();
    for (pid, ppid) in rows {
        known.insert(*pid);
        if pid != ppid {
            children_by_parent.entry(*ppid).or_default().push(*pid);
        }
    }

    let mut tracked: HashSet<u32> = HashSet::new();
    if !known.contains(&root) {
        return tracked;
    }

    let mut queue: VecDeque<u32> = VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if !tracked.insert(pid) {
            continue;
        }
        if let Some(children) = children_by_parent.get(&pid) {
            queue.extend(children.iter().copied());
        }
    }
    tracked
}

/// Clamp a requested interval into a sane range. Zero is preserved and means
/// "hold": the loop keeps serving commands but stops sampling.
pub fn clamp_interval(requested: u64) -> u64 {
    if requested == 0 {
        return 0;
    }
    requested.clamp(MIN_SAMPLE_INTERVAL_MS, MAX_SAMPLE_INTERVAL_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1 -> 2 -> 4, 1 -> 3, and 9 is an unrelated host process.
    fn rows() -> Vec<PidRow> {
        vec![(1, 0), (2, 1), (3, 1), (4, 2), (9, 0)]
    }

    #[test]
    fn selects_root_and_all_descendants() {
        let tracked = select_tracked_pids(&rows(), 1);
        assert_eq!(tracked, HashSet::from([1, 2, 3, 4]));
    }

    #[test]
    fn excludes_unrelated_host_processes() {
        assert!(!select_tracked_pids(&rows(), 1).contains(&9));
    }

    #[test]
    fn returns_empty_when_the_root_is_not_in_the_scan() {
        assert!(select_tracked_pids(&rows(), 12345).is_empty());
    }

    #[test]
    fn terminates_on_a_parent_cycle() {
        // A malformed table where 5 and 6 are each other's parent must not hang.
        let cyclic = vec![(1, 0), (5, 6), (6, 5)];
        let tracked = select_tracked_pids(&cyclic, 5);
        assert_eq!(tracked, HashSet::from([5, 6]));
    }

    #[test]
    fn a_process_reparented_to_itself_is_counted_once() {
        let tracked = select_tracked_pids(&[(7, 7)], 7);
        assert_eq!(tracked, HashSet::from([7]));
    }

    #[test]
    fn clamps_interval_into_range_and_passes_zero_through() {
        assert_eq!(clamp_interval(0), 0); // 0 means "hold, do not sample"
        assert_eq!(clamp_interval(10), MIN_SAMPLE_INTERVAL_MS);
        assert_eq!(clamp_interval(1_000), 1_000);
        assert_eq!(clamp_interval(999_999), MAX_SAMPLE_INTERVAL_MS);
    }
}

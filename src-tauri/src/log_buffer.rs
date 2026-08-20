use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

/// In-memory ring buffer of the most recent formatted log lines. The issue
/// report dialog reads it via the `get_recent_logs` command, so users can
/// review (and redact) what would be attached to a GitHub issue.
pub struct LogBuffer {
    entries: Mutex<VecDeque<String>>,
    capacity: usize,
}

impl LogBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            entries: Mutex::new(VecDeque::with_capacity(capacity)),
            capacity,
        }
    }

    /// Append a line; once full, the oldest entry is evicted.
    pub fn push(&self, line: String) {
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= self.capacity {
            entries.pop_front();
        }
        entries.push_back(line);
    }

    /// Clone the buffered lines, oldest first. The caller owns the copy —
    /// mutating it never touches the buffer.
    pub fn snapshot(&self) -> Vec<String> {
        let entries = self.entries.lock().unwrap();
        entries.iter().cloned().collect()
    }
}

static GLOBAL: OnceLock<LogBuffer> = OnceLock::new();

/// Process-wide buffer holding the last 500 log lines.
pub fn global() -> &'static LogBuffer {
    GLOBAL.get_or_init(|| LogBuffer::new(500))
}

/// `log::Log` implementation that mirrors every record into [`global()`]
/// before delegating to the wrapped `env_logger` (which still filters and
/// writes to stderr as before).
pub struct BufferedLogger {
    inner: env_logger::Logger,
}

impl BufferedLogger {
    pub fn new(inner: env_logger::Logger) -> Self {
        Self { inner }
    }
}

impl log::Log for BufferedLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        self.inner.enabled(metadata)
    }

    fn log(&self, record: &log::Record) {
        let line = format!(
            "[{} {:<5} {}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            record.level(),
            record.target(),
            record.args()
        );
        global().push(line);

        if self.inner.matches(record) {
            self.inner.log(record);
        }
    }

    fn flush(&self) {
        self.inner.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_keeps_arrival_order() {
        let buf = LogBuffer::new(3);
        buf.push("one".to_string());
        buf.push("two".to_string());
        buf.push("three".to_string());
        assert_eq!(
            buf.snapshot(),
            vec!["one".to_string(), "two".to_string(), "three".to_string()]
        );
    }

    #[test]
    fn full_buffer_evicts_oldest() {
        let buf = LogBuffer::new(2);
        buf.push("one".to_string());
        buf.push("two".to_string());
        buf.push("three".to_string());
        assert_eq!(buf.snapshot(), vec!["two".to_string(), "three".to_string()]);
    }

    #[test]
    fn snapshot_is_isolated_from_buffer() {
        let buf = LogBuffer::new(2);
        buf.push("one".to_string());
        let mut snap = buf.snapshot();
        snap.clear();
        snap.push("tampered".to_string());
        assert_eq!(buf.snapshot(), vec!["one".to_string()]);
    }
}

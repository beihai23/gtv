//! Embedded terminal backend: UTF-8 chunk reassembly across PTY read
//! boundaries, and the full PTY lifecycle against a real child process
//! (`/bin/cat` echoes what we write; kill() must fire the exit callback).

use gtv_lib::terminal::{drain_utf8, spawn_process};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// A 3-byte char (中 = E4 B8 AD) split after 2 of its 3 bytes: the first
/// drain must emit only the complete ASCII prefix and keep the dangling
/// 2-byte fragment buffered, so appending the rest reconstructs the char.
#[test]
fn drain_utf8_reassembles_three_byte_char_split_after_two_bytes() {
    // "a中b" = [61, E4, B8, AD, 62]
    let mut buf: Vec<u8> = vec![b'a', 0xE4, 0xB8];
    let first = drain_utf8(&mut buf).expect("prefix drained");
    assert_eq!(first, "a");
    assert_eq!(buf, vec![0xE4, 0xB8], "incomplete tail must stay buffered");

    buf.extend_from_slice(&[0xAD, b'b']);
    let second = drain_utf8(&mut buf).expect("char completed");
    assert_eq!(second, "中b");
    assert!(buf.is_empty(), "buffer fully drained");
    assert_eq!(format!("{}{}", first, second), "a中b");
}

/// Same char split after only 1 byte — the harder boundary: the fragment
/// alone is an invalid prefix and must neither emit nor be dropped.
#[test]
fn drain_utf8_reassembles_three_byte_char_split_after_one_byte() {
    let mut buf: Vec<u8> = vec![b'a', 0xE4];
    let first = drain_utf8(&mut buf).expect("prefix drained");
    assert_eq!(first, "a");
    assert_eq!(buf, vec![0xE4]);

    buf.extend_from_slice(&[0xB8, 0xAD, b'b']);
    let second = drain_utf8(&mut buf).expect("char completed");
    assert_eq!(second, "中b");
    assert!(buf.is_empty());
    assert_eq!(format!("{}{}", first, second), "a中b");
}

/// A buffer holding nothing but an incomplete char emits nothing.
#[test]
fn drain_utf8_returns_none_while_only_fragment_buffered() {
    let mut buf: Vec<u8> = vec![0xE4];
    assert!(drain_utf8(&mut buf).is_none());
    assert_eq!(buf, vec![0xE4], "fragment preserved untouched");
    assert!(drain_utf8(&mut Vec::new()).is_none());
}

/// Round trip through a real PTY: spawn /bin/cat, write "hi\n", read the
/// echo back through the on_output callback, then kill() and require the
/// exit callback within the deadline.
#[test]
fn cat_pty_roundtrip_then_kill_fires_exit() {
    let dir = std::env::temp_dir().join(format!("gtv-pty-cat-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp dir");

    let (out_tx, out_rx) = mpsc::channel::<String>();
    let (exit_tx, exit_rx) = mpsc::channel::<()>();
    let mut session = spawn_process(
        "/bin/cat",
        &[],
        &dir,
        80,
        24,
        Box::new(move |data| {
            let _ = out_tx.send(data);
        }),
        Box::new(move || {
            let _ = exit_tx.send(());
        }),
    )
    .expect("spawn /bin/cat in pty");

    session.write("hi\n").expect("write to pty");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = String::new();
    while Instant::now() < deadline && !seen.contains("hi") {
        match out_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => seen.push_str(&chunk),
            Err(_) => continue,
        }
    }
    assert!(seen.contains("hi"), "cat echo not observed, got {:?}", seen);

    session.kill();
    assert!(
        exit_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        "on_exit not fired after kill"
    );
}

//! Dev tool: dump GitData for a repo as JSON.
//! Usage: cargo run --example dump_json -- /path/to/repo > out.json

use gtv_lib::git_reader::GitReader;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump_json <repo path>");
    let mut reader = GitReader::new(&path).expect("open repo");
    let data = reader.read_git_data(2000).expect("read git data");
    println!("{}", serde_json::to_string_pretty(&data).unwrap());
}

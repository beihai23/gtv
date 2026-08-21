//! Dev tool: dump GitData for a repo after paging through ALL history in
//! chunks. Usage: cargo run --example dump_paged -- /path/to/repo > out.json

use gtv_lib::git_reader::GitReader;
use std::collections::HashSet;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump_paged <repo path>");
    let mut reader = GitReader::new(&path).expect("open repo");
    let first = reader.read_git_data(2000).expect("read git data");
    let mut data = first.data;
    let mut guard = 0;
    while data.has_more {
        guard += 1;
        assert!(guard < 50, "pagination must terminate");
        let seen: HashSet<String> = data.commits.iter().map(|c| c.id.clone()).collect();
        data = reader
            .load_more(&first.seeds, &seen, data.commits, 2000)
            .expect("load_more");
        eprintln!("paged: {} commits, has_more={}", data.commits.len(), data.has_more);
    }
    println!("{}", serde_json::to_string_pretty(&data).unwrap());
}

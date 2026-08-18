// Dev tool: dump a repo's patch links (cherry-pick / rebase detection) as JSON.
// Usage: cargo run --example dump_links -- /path/to/repo
use gtv_lib::git_reader::GitReader;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump_links <repo>");
    let mut reader = GitReader::new(&path).expect("open repo");
    let data = reader.read_git_data(2000).expect("read git data");
    let links = reader.get_patch_links(&data.commits).expect("patch links");
    println!("{}", serde_json::to_string_pretty(&links).unwrap());
}

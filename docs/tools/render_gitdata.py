"""Render gtv's GitData JSON as a lane diagram PNG for visual comparison
against the gmaster screenshots in docs/assets/."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src-tauri" / "target"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

def main(json_path: str, out_path: str) -> None:
    data = json.load(open(json_path))
    commits = {c["id"]: c for c in data["commits"]}
    lanes = {b["name"]: b for b in data["branches"]}

    fig, ax = plt.subplots(figsize=(14, 6))
    fig.patch.set_facecolor("#1e1e1e")
    ax.set_facecolor("#1e1e1e")

    # edges
    style = {"Direct": dict(lw=2.5, alpha=0.9, solid_capstyle="round"),
             "Branch": dict(lw=1.6, alpha=0.8, linestyle="-"),
             "Merge": dict(lw=1.2, alpha=0.7, linestyle="-")}
    for e in data["edges"]:
        a, b = commits.get(e["from"]), commits.get(e["to"])
        if not a or not b:
            continue
        color = lanes[a["lane_owner"]]["color"]
        et = e["edge_type"]
        if et == "Direct":
            ax.plot([b["x"], a["x"]], [-b["lane"], -a["lane"]], color=color,
                    **style["Direct"], zorder=2)
        else:
            xs = [b["x"], (a["x"] + b["x"]) / 2, a["x"]]
            ys = [-b["lane"], (-b["lane"] - a["lane"]) / 2, -a["lane"]]
            ax.plot(xs, ys, color=color, **style[et], zorder=1)

    # nodes + labels
    for c in data["commits"]:
        color = lanes[c["lane_owner"]]["color"]
        y = -c["lane"]
        ax.scatter([c["x"]], [y], s=260, facecolor="#1e1e1e",
                   edgecolor=color, linewidth=2.2, zorder=3)
        if c["is_head"]:
            ax.scatter([c["x"]], [y], s=560, facecolor="none",
                       edgecolor="#4CAF50", linewidth=1.8, zorder=3)
            ax.text(c["x"], y - 0.38, "HEAD", color="#4CAF50",
                    fontsize=8, ha="center", weight="bold")
        if c["fork_branch_name"]:
            ax.text(c["x"], y - 0.30, "⑂ " + c["fork_branch_name"], color="#aaa",
                    fontsize=7, ha="center")
        if c["merge_branch_name"]:
            ax.text(c["x"], y + 0.32, "⤶ " + c["merge_branch_name"], color="#E91E63",
                    fontsize=7, ha="center")

    # lane names on the left
    min_x = min(c["x"] for c in data["commits"])
    for b in data["branches"]:
        ax.text(min_x - 60, -b["lane_index"], b["name"], color=b["color"],
                fontsize=10, ha="right", va="center", weight="bold")

    ax.autoscale_view()
    ax.axis("off")
    ax.set_title("gtv lane assignment — gmaster tour repo", color="#ccc", fontsize=12)
    fig.savefig(out_path, bbox_inches="tight", facecolor=fig.get_facecolor())
    print(f"saved {out_path}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

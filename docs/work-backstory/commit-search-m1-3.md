---
arc: commit-search-m1-3
started: 05c4d37
status: active
commits: [a7c2a7f]
---

# M1.3 提交搜索定位补全（message/author + 全历史）

## Intent

Roadmap M1.3 的收尾：现有 Cmd+F（graph-locate-and-select arc）只搜分支名 +
hash 前缀，且仅限已加载范围（分页 2000 窗口）。要求补 message/author 搜索，
验收「大仓库任意提交 2 秒内定位」——"任意"意味着未加载的历史也要能搜到，
这是本 arc 的核心难点（搜索本身便宜，**范围外命中的跳转**才是设计大头）。

## Process

- 上下文勘察：前端 `CommitNode.message` = `commit.summary()`（subject 行），
  `author_name` 随行——已加载范围的 message/author 搜索零后端改动可做。
  后端 `walk_commits(seeds, hide, limit)` / `build_view` 是种子驱动管线，
  `read_git_data_from_branch` 已证明"单种子开窗 + session 接管分页"模式。
  hash 前缀可走 `revparse_single` 快速路径。
- 需求澄清结论（用户逐项拍板）：
  1. 搜索范围 = **全历史**（新增只读后端命令；"任意提交 2 秒内定位"的验收
     只有这条路能达成）。
  2. 范围外命中跳转 = **"从该提交查看"**：以目标 oid 为种子开 2000 窗口
     （复用 read_git_data_from_branch 的单种子模式 + session 接管分页），
     一次调用亚秒级。否决深分页（walk 数万 + 全集 layout，秒级且 90k
     layout 未验证）。
  3. 执行架构 = **混合双源**：输入时前端即时搜已加载范围（含 message/author
     扩展），200ms 防抖后后端补全全史命中，按 id 去重合并。已加载命中拿得到
     lane_owner（死泳道自动展开的既有行为保住），后端返回 in_view 标志
     （查 session loaded oids）分流跳转路径。

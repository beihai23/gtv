# M1.3 提交搜索定位补全 — 设计文档

日期：2026-08-28
状态：已与用户逐节确认
Roadmap：M1.3（Cmd/Ctrl+F 搜索 message/author/hash，验收「大仓库任意提交
2 秒内定位」）
Backstory：docs/work-backstory/commit-search-m1-3.md
前置：graph-locate-and-select arc（Cmd+F 浮窗、分支名/hash 前缀搜索、
focusCommit 聚焦机制）；large-repo-pagination arc（分页与 ViewSession）；
inactive-lane-collapse arc（locate 命中死泳道自动展开）。

## 1. 背景与目标

现有 Cmd+F 只搜**分支名子串 + hash 前缀（≥4 位 hex）**，且仅限已加载范围
（分页 2000 窗口）。缺 message/author 匹配，未加载历史完全搜不到。

**验收**：任意提交（含未加载的深历史）从键入到图上定位完成 < 2 秒；
大小写不敏感子串匹配 subject/author；hash 前缀与分支名搜索保持现状行为。

## 2. 需求决策记录（用户逐项拍板）

| # | 问题 | 决策 |
|---|---|---|
| 1 | 搜索范围 | **全历史**——新增只读后端命令；"任意提交"的验收只有这条路能达成 |
| 2 | 范围外命中跳转 | **"从该提交查看"**：以目标 oid 为种子开 2000 窗口（单种子模式），一次调用亚秒级；否决深分页（walk 数万 + 全集 layout，秒级且大规模 layout 未验证） |
| 3 | 执行架构 | **混合双源**：输入时前端即时搜已加载范围，200ms 防抖后后端补全全史，按 id 去重合并 |

细则（随架构一并确认）：大小写不敏感子串匹配 subject/author；hash 前缀
≥4 位；分支名命中继续排前；commit 命中时间倒序；**不做**多词分词/正则。

## 3. 方案选择

混合双源（已选）vs 全后端（防抖后一律走后端含已加载范围）：后者单一数据
源但每次击键有 IPC 往返、且前端还得回查 lane_owner 才能做死泳道自动展开。
双源保住即时反馈与 M1.2 的展开行为，代价是前端一个合并纯函数——更便宜。

## 4. 组件设计

### 4.1 后端命令一：`search_commits`

```
search_commits(query: String, limit: usize) → Vec<SearchHit>

// 前端调用固定传 50；测试传小值。Rust 命令无默认参数。
SearchHit {
  id: String,          // full oid
  message: String,     // subject 行（commit.summary()）
  author_name: String,
  timestamp: i64,      // committer ts，与详情面板一致
  in_view: bool,       // 该 commit 是否在当前 session 已加载窗口内
}
```

- 种子与正常视图一致（所有分支 tips），全量 revwalk；walk 新→旧，命中
  天然时间倒序，取满 limit 即停。
- 匹配：小写化后子串比对 `summary` **或** `author_name`；query 为 ≥4 位
  hex 时同时比对 commit id 前缀（在 walk 循环内顺手做，覆盖全部歧义匹配，
  不用 `revparse_single`——它遇歧义直接报错反而丢结果）。
- `in_view`：从 `AppState.session` 的已加载 oid 集合判定；无 session 恒
  false。命令在 `task::spawn_blocking` 内（遵循现有重命令模式）。
- 匹配逻辑写进 `git_reader.rs`（纯函数 seeds→hits，无 Tauri 依赖，可测）。

### 4.2 后端命令二：`jump_to_commit`

```
jump_to_commit(commit_id: String) → GitData
```

- 照 `read_git_data_from_branch` 的单种子模式：目标 oid 构造**伪种子**
  （lane 名 = 7 位短 hash，颜色走 LANE_PALETTE 顺位），`build_view(seed,
  2000)` + stale 检测 + `store_session(result, true)` 接管分页续走。
- 目标 commit 是 walk 的 tip，必然在新视图内。
- oid 不存在或指向非 commit 对象 → `Err(String)` 用户可读错误。
- 语义等同「从此分支查看」：不做返回栈，重开仓库即回默认视图（YAGNI）。

### 4.3 IPC 契约

`models.rs` 新增 `SearchHit`（字段全必填，无 serde default 需求）；
`lib.rs` invoke_handler 注册两条命令；`src/api.ts` 加
`searchCommits(query, limit)` / `jumpToCommit(commitId)` 包装；
`src/types.ts` 镜像 `SearchHit`——遵守"两侧都改"的既有约定（AGENTS.md）。

### 4.4 前端：混合管道（新纯函数模块 `src/locate.ts`）

```
matchLoaded(commits, branches, query) → LocateResult[]
mergeLocate(local, remote, cap = 12) → LocateResult[]
```

- `matchLoaded`：现有 `locateResults` memo 内联逻辑抽出并**扩展**
  message/author 子串（大小写不敏感）。LocateResult 精确形状：
  `{ kind: 'branch'; name; color; commitId }`（不变）或
  `{ kind: 'commit'; id; message; author: string; timestamp: number;
  in_view: boolean }`（本地图内命中恒 `in_view: true`）。
- `mergeLocate`：**仅在 commit 类内**按 id 去重（本地优先——带 lane_owner
  的本地命中保住死泳道展开路径）；分支命中与 commit 命中可并存（现状
  行为）；分支命中在前；commit 命中时间倒序；总截断 cap。
- App：`useEffect` 对 `locateQuery` 200ms 防抖调 `searchCommits(query,
  50)`，cancelled-flag 丢弃过期响应（patchLinks 模式）；query < 2 字符
  跳过后端调用（本地匹配规则不变：分支名任意长度、hash ≥4 位）。
- **跳转分流**（`handleLocate`）：
  - 命中 `in_view`（或本地命中）→ 现有 `focusCommit` 路径：居中 + 自动
    展开压缩泳道与死泳道（M1.2 行为原样）。
  - `in_view = false` → `jumpToCommit(oid)` → `setGitData` +
    `viewResetKey++` + `setExpandedDead(new Set())` + 清空 `selectedCommit`
    + `focusCommit` 目标（与 handleViewFromBranch 同构）。
- 下拉 commit 行呈现：hash + subject + 暗色 author（帮消歧）；全史命中
  超过截断数时 footer 提示全史命中总数。

## 5. 边界情况

| 场景 | 行为 |
|---|---|
| 防抖竞态 | effect cleanup 置 cancelled，过期响应丢弃 |
| 搜索中切换仓库 | gitData 在 effect 依赖中，响应自动作废 |
| jump 期间再次操作 | loading 态复用现有守卫 |
| 特殊字符 | 纯子串匹配，无正则——无转义问题 |
| 仓库未打开 | Cmd+F 本就需要 gitData；session 空时 in_view 恒 false |
| 多词查询 | v1 不做分词 |
| hash 歧义前缀 | walk 内前缀比对，全部返回 |

## 6. 测试与验收

- **Rust `tests/search.rs`**（git CLI 造临时仓，复用 pagination.rs 模式）：
  大小写不敏感命中；空结果；`in_view` 真/假（先 open 再搜）；hash 前缀与
  歧义前缀；limit 截断按时间倒序；`jump_to_commit` 的 tip 断言 +
  `load_older_commits` 续走 + 错误 oid 报错。
- **前端 vitest `src/locate.test.ts`**：matchLoaded 四类命中路径 +
  mergeLocate 去重/排序/截断/空输入。
- **E2E**：mock.html 补 `search_commits`/`jump_to_commit` invoke mock
  （新命令必须补 mock，既有教训）+ playwright：输入 → 全史命中 → 跳转 →
  聚焦全链路。
- **验收计时**：gen_inactive_repo.sh 仓库 + 任一真实大仓库，键入到定位
  < 2s。

## 7. 明确不做（本 arc 范围外）

- 多词分词 / 正则 / 精确短语语法
- 跳转返回栈（与 view-from-branch 同语义，重开即回）
- 搜索历史 / 最近跳转记忆
- 全文 message（body）搜索——只搜 subject 行（body 在后端只有
  get_commit_detail 按需拉取，全史 body 搜索是另一个量级的索引问题）

## 8. 风险与注意点

- 后端全量 walk 的大仓库耗时：taskon-server 6292 commits 亚秒；10 万级
  仓库 walk + 每 commit 两次小写化比对约 200-500ms，防抖 200ms + 渲染
  距 2s 验收余量充足。若实测超限，优化方向是预小写化缓存（YAGNI 先不做）。
- `search_commits` 与分页 session 的 oid 集合一致性：session 的 loaded
  oids 在 `load_older_commits` 后增长，in_view 判定读同一 Mutex——无
  竞态面（命令串行）。
- 前端 `locateResults` memo 与防抖 effect 的双源结果必须在**同一次渲染**
  合并（都进 state/memo，不直接混 effect 与渲染），否则下拉会闪未合并态。

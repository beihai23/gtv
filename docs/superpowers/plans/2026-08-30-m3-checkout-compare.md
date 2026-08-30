# M3.1 + M3.2 checkout 与对比 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gtv 的头两个"干活"能力：真实 checkout（SAFE 携带 + 脏确认 + watcher 刷新，唯一写操作）与分支/提交对比（Ctrl/Cmd 配对 + 与 HEAD 对比，纯读）；顺带核实 M3.4 已存在并在收尾划掉、放宽 README/AGENTS 只读措辞。

**Architecture:** 后端两个新命令对（写：`get_worktree_status` + `checkout_branch`；读：`get_compare_detail` + `get_pair_file_diff` + `GitData.head_branch` 字段）+ 前端两根接线（M3.1 菜单/对话框/泳道标记；M3.2 comparePair 状态机/CompareDetails 面板）。**checkout 只返回 ack 不返回视图**——刷新全权交既有 `repo-changed` → `handleRepoRefresh` 链路（防双重建竞态）。对比与单提交详情共用面板位，普通点击即切单详情。

**Tech Stack:** Rust/git2（git_reader.rs 承载全部 git2 访问，commands.rs 薄包装，models.rs 是 IPC 契约 + src/types.ts 手工同 commit 镜像）、React 19 + TS strict、vitest（`src/compare.ts`）、git CLI 造临时仓的 Rust 集成测试（`pagination.rs` 模式）、mock.html 桩 + 浏览器 E2E。

**Spec:** `docs/superpowers/specs/2026-08-30-m3-checkout-compare-design.md`（冲突以 spec 为准）。

## Global Constraints

- **只读红线的唯一豁免**：全 arc 只有 `checkout_branch` 一个命令写仓库（SAFE 模式、无 force、merge 进行中拒绝、脏时必须显式确认）。其余一切改动只读。README/AGENTS.md 的措辞放宽放 Task 7，之前不动文档承诺。
- git2 访问全部落 `src-tauri/src/git_reader.rs`（AGENTS.md 布局约定）；`commands.rs` 只做 State/锁/spawn_blocking 薄包装；`models.rs` 与 `src/types.ts` 在同一 commit 内同步改（手工镜像契约）。
- 门禁（每任务）：`cd src-tauri && cargo test` 全绿 + `npm test` 全绿（当前 65）+ `npm run build` 过。Rust 侧注释同英文 ASCII。
- App.tsx TDZ 地雷（M1.3）：新 memo/useCallback 依赖必须声明在前。
- i18n en/zh 两侧同步；新 UI 文案含 `{n}` 插值走 `t(key, vars)`（settings.tsx:411 模式）。
- E2E 用 mock.html，dev server 起 **1421** 端口（先探测，用户 1420 不碰）；gstack browse CLI（`$HOME/.claude/skills/gstack/browse/dist/browse`），输入框 `fill` 不是 `type`，修饰键点击用 js dispatchEvent 带 `ctrlKey: true`。
- 每任务 commit trailer：`Backstory: docs/work-backstory/checkout-compare-m3.md` 紧贴 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`（无空行，最后）。backstory 文件 Task 1 提交时建立（frontmatter：arc/checkout-compare-m3、started/<当前 HEAD>、status/in-progress、commits/[]）。
- 测试断言计数落笔前重数一遍（M1.3/M2 双教训）；E2E 期望值回查 fixture 真态再写（M2 教训）。

---

### Task 1: Rust — `get_worktree_status` + `checkout_branch`（TDD）

**Files:**
- Modify: `src-tauri/src/git_reader.rs`（GitReader 加 `worktree_status()` 与 `checkout_branch()` 方法——全部 git2 访问在此）
- Modify: `src-tauri/src/commands.rs`（两命令薄包装：clone `current_path` → spawn_blocking → 全新 GitReader；**绝不持 state 锁做树写**，照 open_repository 模式）
- Modify: `src-tauri/src/models.rs` + `src/types.ts`（`WorktreeStatus { modified, untracked, merge_in_progress }`、`CheckoutAck`（空结构或 `{ branch: String }`））
- Modify: `src-tauri/src/lib.rs`（invoke_handler 注册）、`src/api.ts`（wrapper）
- Create: `src-tauri/tests/checkout.rs`（git CLI 造临时仓）、`docs/work-backstory/checkout-compare-m3.md`

**语义（spec §4.1）：**
- `worktree_status()`：`repo.statuses(None)` 统计——WT_MODIFIED/WT_TYPECHANGE/WT_RENAMED 计 modified；WT_NEW 计 untracked；`MERGE_HEAD` 或 `CHERRY_PICK_HEAD` 引用存在 → merge_in_progress。
- `checkout_branch(name)`：
  1. merge_in_progress → Err。
  2. 只收本地分支：`find_branch(name, Local)` 失败或 name 是 tag → Err（错误串英文 ASCII）。
  3. `checkout_tree`（目标 tip 的 tree，`CheckoutBuilder` 安全模式显式 `.force(false)`），**成功后** `set_head("refs/heads/<name>")`——先树后头，冲突时 HEAD 未动。
  4. 成功返回 ack，**不返回 GitData**（刷新交 watcher）。
- `AppState.current_branch` 语义错位**不修不删**（零调用者，spec §8）。

**测试（tests/checkout.rs，git CLI 造仓）：** 干净切换（HEAD 指向变 + 工作区文件内容变）；脏携带（改文件 X → 切到没动 X 的分支 → 改动随行）；冲突拒绝（改 X → 切到也改了 X 的分支 → Err 且 HEAD 不变、X 内容不变）；merge 进行中拒绝（写 `.git/MERGE_HEAD` 模拟）；untracked 不阻塞；status 计数（改 2 建 1 → modified 2 / untracked 1）；tag/不存在分支 → Err。

**验收：** cargo test 全绿（新增 7+ 例）；npm run build 过（types.ts 镜像）；backstory 建档。

### Task 2: Rust — compare 后端 + `head_branch`（TDD）

**Files:**
- Modify: `src-tauri/src/git_reader.rs`、`src-tauri/src/commands.rs`、`src-tauri/src/models.rs` + `src/types.ts`、`src-tauri/src/lib.rs`、`src/api.ts`
- Create: `src-tauri/tests/compare.rs`

**语义（spec §4.5）：**
- `GitData.head_branch: Option<string>`：build_view 里 `repo.head()` 为分支则 shorthand、detached 为 None（head_oid 旁一并取，layout 不动）。
- `get_compare_detail(base_oid, target_oid) -> CompareDetail`：泛化 `get_commit_detail`（git_reader.rs:900-924）的 delta 遍历为任意两树；**每文件 +/−** 用 `Patch::from_diff`（照 get_file_diff:656-660）逐文件取；含合计与两侧 commit 摘要（短 hash/subject/author，头部呈现用）。
- `get_pair_file_diff(base_oid, target_oid, path)`：泛化 `get_file_diff`（610-677），200KB 截断与二进制占位同款。`get_commit_detail`/`get_file_diff` 既有行为不动（parent-vs-commit 通道不回归）。

**测试（tests/compare.rs）：** 两提交差异的文件列表（增/删/改三态）+ 每文件 +/− 数字 + 合计；行级 patch 内容；空 diff（同 oid）零文件；不存在 oid → Err；head_branch：分支头 shorthand / detached None（造仓两态）。

**验收：** cargo test 全绿；npm run build 过；types.ts/api.ts 同步。

### Task 3: 前端纯函数 `src/compare.ts` + i18n 键（TDD）

**Files:**
- Create: `src/compare.ts`、`src/compare.test.ts`
- Modify: `src/settings.tsx`（en+zh 新键）

**Interfaces（Task 4/5 依赖）：**

```ts
export interface ComparePair { base: string; target: string }
/** Ctrl+click contract (spec §4.4): no pair or complete pair -> clicked
 *  becomes the new base (target cleared); base-only -> clicked is target. */
export function nextPair(pair: ComparePair | null, id: string): ComparePair;
/** Lane-menu compare: base = HEAD commit id, target = lane tip commit id;
 *  null when HEAD is not in the loaded commits (windowed/paged out). */
export function headToLaneTip(data: GitData, laneName: string): ComparePair | null;
```

**要点：** lane tip 解析复用 `src/locate.ts` 的 laneTip（如未导出则导出，不改语义）；HEAD 提交 = `data.commits.find(c => c.is_head)`。i18n 键（en/zh 双侧，`{n}` 插值）：checkoutThisBranch、confirmCheckoutTitle、confirmCheckoutBody（{modified}/{untracked}）、carryNote、terminalNote、switchedTo（{branch}）、mergeInProgress、compareWithHead、compareBase、compareTarget、currentBranchTip、nodeCompareTip。

**测试：** nextPair 三态（空→base；半→补 target；满→重开 base）；headToLaneTip（HEAD 在场→pair 方向 base=HEAD；HEAD 缺席→null；lane 无 tip→null 或防御）；laneTip 复用不回归。

**验收：** npm test 全绿（65 + 新增）；npm run build 过。

### Task 4: 接线 M3.1（菜单项 + 脏确认对话框 + 泳道标记）

**Files:**
- Modify: `src/App.tsx`（handleCheckoutBranch：status 预检 → 干净直切 / 脏弹确认 / merge 进行中报错；成功轻提示，失败走 error 通道；**不重建视图**）
- Create: `src/components/CheckoutDialog.tsx`（overlay，照 IssueReportDialog 样式；计数 + 携带说明 + 终端提示；确认/取消）
- Modify: `src/components/Timeline.tsx`（lane-menu 第五项 `checkoutThisBranch`，is_tag 隐藏；当前分支泳道标记——新 prop `headBranch`，同名泳道行加高亮 + currentBranchTip）
- Modify: `src/App.css`（泳道标记 + 轻提示样式 ≤30 行，英文注释）

**要点：** checkout 成功后**什么都不做**——watcher 1.5s 内触发 repo-changed → handleRepoRefresh 自动重建（spec §4.3 铁律，防双重建竞态）。轻提示可用现有 error banner 同款样式的成功变体或独立小 toast，报告里写明选择。api.ts wrapper（Task 1 已建）直接调。

**验收：** npm run build + npm test 全绿；真机不开（E2E 在 Task 6 用桩验）。

### Task 5: 接线 M3.2（配对手势 + CompareDetails + 与 HEAD 对比）

**Files:**
- Modify: `src/components/Timeline.tsx`（节点 click 分流：ctrl/meta → `onCompareClick(d.id)` 新 prop，照边上修饰键先例 :590-601；base 节点高亮环（新色 token，区别单选环与 HEAD 绿环）；lane-menu 第六项 `compareWithHead`，is_tag 隐藏，`headToLaneTip` 为 null 时禁用置灰；节点 tooltip 补契约文案）
- Modify: `src/App.tsx`（`comparePair` state + set/clear handler；面板竞争规则：普通节点点击/Esc → 关对比；箭头步进只动 selectedCommit 不碰 pair）
- Create: `src/components/CompareDetails.tsx`（头部 base→target 摘要、文件列表带每文件 +/−、点文件懒加载行级 diff——复用 CommitDetails 的 DiffView 与懒加载模式，共享部分可抽小组件，最小搬动为度）

**要点：** CompareDetails 与 CommitDetails 共用面板位（互斥渲染）；Esc 语义：对比开着关对比，否则关单详情。CommitDetails 的重构以"抽共享"为限，行为零变化（review 重点）。

**验收：** npm run build + npm test 全绿；TDZ 走查（新 handler/memo 依赖前置）。

### Task 6: mock 桩 + E2E 全量验收

**Files:**
- Modify: `mock.html`（invoke 桩：checkout_branch 可切 success/Err 两档、get_worktree_status 可切 clean/dirty/merge 三档、get_compare_detail + get_pair_file_diff 静态桩数据、mock GitData 注入 head_branch）

**E2E（spec §6 七项）：** 干净直切路径、脏确认（计数正确 + 确认成功 + 取消无事）、冲突错误呈现、tag 泳道无第五/六项、当前分支泳道标记、Ctrl+点两节点对比（文件列表 +/− + 行级 diff + Esc 关闭）、「与 HEAD 对比」方向 base=HEAD。console 全程无错误；js 断言表达式与返回值进报告。

**验收：** 单 commit（桩 + E2E 记录）；`npm run build` 过。

### Task 7: 终审 + 修复波 + 文档收尾

- 终审（opus）全量 diff 复核四不变量：唯一写命令豁免边界、checkout 后无第二重建路径、既有 parent-vs-commit 通道零回归、CommitDetails 重构行为零变化；独立猎新（竞态/组合场景/i18n/CSS）。
- 修复波（sonnet）：终审发现一次清零，门禁 + E2E 复跑。
- 文档：roadmap 3.1/3.2 移入已完成（3.4 核实后一并划掉）；**README + AGENTS.md 只读措辞放宽**（"除显式确认的 checkout 外不修改仓库"语义）；backstory 收口（resolved、commits 全列、Lessons）。
- 用户手动项清单入任务报告：真 checkout 脏携带/冲突、终端共存、detached 观感。

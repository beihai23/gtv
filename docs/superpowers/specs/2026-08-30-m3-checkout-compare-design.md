# M3.1 + M3.2 设计：真实 checkout + 分支/提交对比（2026-08-30）

> 决策依据：roadmap「定位决策（2026-08-29）」——gtv 保持只读，仅开两个例外：
> 切换当前分支（须带脏工作区确认）与分支/提交对比（纯读）。其余写操作不做。
> 用户三项交互裁定（2026-08-30）：菜单并存两项 / 安全携带 / 提交配对+分支对比。

## 1. 背景与目标

- **M3.1**：把 gtv 从"只看"推进到"切换当前分支"。全仓库现无任何真 checkout
  （`switch_branch` 是视图过滤器——`commands.rs:223` 只是以单分支为种子重建
  视图，不动 HEAD 不动工作区）；真 checkout 为全新后端能力。
- **M3.2**：gmaster 形态的 "diff selected changesets"——任意两提交（或两分支
  tip）对比，详情面板呈现文件级 diff。
- 顺带核实：M3.4（详情面板内嵌行内 diff）经勘察**已存在**（`CommitDetails.tsx`
  文件级懒加载 + `DiffView` 行渲染器 + 后端 `get_file_diff` 200KB 截断），本 arc
  收尾时从 roadmap 划掉，对比视图直接复用该基建。

## 2. 现状勘察（侦察结论，file:line 为当前 main）

- 刷新链路免费：watcher 1.5s 指纹轮询**已明确覆盖 checkout**（HEAD symbolic
  name + oid，`git_reader.rs:144-178`）→ `repo-changed` → App 500ms 防抖 →
  `handleRepoRefresh`（`App.tsx:398-429`）全量重建（保留存活选择、不动视口）。
- HEAD 提交已有绿环 + "HEAD" 文字（`layout.rs:249` 置 `is_head`，
  `Timeline.tsx:729-741` 渲染）；但**当前分支的泳道无任何标记**，前端也不知道
  当前分支名（`AppState.current_branch` 是检测出的 main，不是 HEAD，且
  `get_current_branch` 零调用者）。
- 节点点击无修饰键处理（`Timeline.tsx:693-696` 无条件 `onCommitClick`）；边上
  已有 ctrl/meta/shift 先例（`:590-601` 跳父/跳子），tooltip 有契约文案先例。
- 后端 diff 全部是 parent-vs-commit（`git_reader.rs:602/632/697/890` 四处
  `diff_tree_to_tree`）；每文件 +/- 现为硬编码 0（`:918-923`）。
- 确认对话框无现成组件，但有两个 overlay 先例（`SettingsDialog` /
  `IssueReportDialog`）。
- 集成终端 PTY 活在仓库 cwd——checkout 会静默重写用户开着的 shell 下的文件。

## 3. 范围

| 项 | 内容 |
|---|---|
| 后端-写 | `checkout_branch` 命令（git2 SAFE checkout + set_head）+ `get_worktree_status` 预检命令 |
| 后端-读 | `get_compare_detail(base,target)`（文件列表 + 每文件 +/- + 合计）+ `get_pair_file_diff(base,target,path)`（行级 patch，复用 200KB 截断模式） |
| 模型 | `GitData.head_branch: Option<string>`（HEAD 简写名；detached 为 None）+ types.ts 手工镜像 |
| 前端-M3.1 | 泳道菜单第五项「切换到此分支」、脏工作区确认对话框（安全携带语义）、当前分支泳道标记、成功/失败反馈 |
| 前端-M3.2 | 节点 Ctrl/Cmd+点击配对（App comparePair 状态机）、对比详情视图（复用文件列表+DiffView 懒加载）、泳道菜单「与 HEAD 对比」、Esc/关闭清除、节点 tooltip 契约更新 |
| 文档 | README/AGENTS.md 只读措辞放宽（"除显式确认的 checkout 外不修改仓库"级）；roadmap 3.1/3.2 完结 + 3.4 核实划掉 |

## 4. 设计

### 4.1 checkout 后端（新命令，TDD）

```rust
// commands.rs —— 两个新命令
#[tauri::command] pub async fn get_worktree_status(...) -> Result<WorktreeStatus, String>;
#[tauri::command] pub async fn checkout_branch(branch: String, ...) -> Result<CheckoutAck, String>;
```

- `WorktreeStatus { modified: usize, untracked: usize, merge_in_progress: bool }`
  ——`repo.statuses(None)` 统计（WT_MODIFIED/WT_TYPECHANGE/WT_RENAMED 计
  modified；WT_NEW 计 untracked；存在 `MERGE_HEAD`/`CHERRY_PICK_HEAD` 引用则
  merge_in_progress=true）。
- `checkout_branch` 行为（spawn_blocking + 全新 `GitReader`，照
  `open_repository` 模式拿路径，绝不持 state 锁做树写）：
  1. merge_in_progress → 直接 Err（不提供任何绕过；文案 i18n 由前端负责，
     后端错误串英文 ASCII）。
  2. `repo.set_head("refs/heads/<b>")` 前先 `checkout_tree`（目标分支 tip 的
     tree，`CheckoutBuilder` 安全模式：不 force）；顺序**先 tree 后 head**，
     失败时 HEAD 未动、工作区尽量未动（safe checkout 在冲突时写前报错）。
  3. 分支不存在/是 tag/是 remote-tracking → Err。
  4. 成功返回 ack（**不返回 GitData**——刷新交给 watcher，见 §4.3）。
- checkout 后 `AppState.current_repo` 句柄陈旧问题：不做就地处理；watcher 触发
  的 `open_repository` 重建会整体换句柄（现状路径）。
- **测试**（git CLI 造临时仓，`pagination.rs` 模式）：干净切换（HEAD 指向 +
  工作区文件内容变化）；脏携带（改动文件 X 后切到未动 X 的分支 → 改动随行）；
  冲突拒绝（改动 X 切到也改了 X 的分支 → Err 且 HEAD 不变）；merge 进行中
  拒绝（写 `.git/MERGE_HEAD` 模拟）；untracked 不阻塞；status 计数三态。

### 4.2 脏工作区确认（安全携带，用户裁定）

- 泳道菜单点「切换到此分支」→ 先调 `get_worktree_status`：
  - 干净（modified=0 且无 merge）→ 直接 checkout。
  - 脏 → 确认对话框（overlay 先例样式）：列出「N 个已修改文件、M 个未跟踪
    文件」+ 说明文案（兼容的未提交改动会**随行携带**到目标分支；与目标冲突
    时切换失败、工作区保持原样）+ 一句终端提示（切换会重写工作区文件，含
    集成终端 cwd 下的文件）。确认 → checkout；取消 → 无事发生。
  - merge_in_progress → 错误提示（完成或中止合并后再切换），无确认路径。
- 失败（冲突/git 错误）→ 现有 error 通道呈现后端错误文案；成功 → 轻提示
  「已切换到 <branch>」，视图由 watcher 刷新（≤1.5s + 500ms 防抖内自动重建）。
- **无 force/discard 选项**（决策：不做破坏性操作）。

### 4.3 前端接线 M3.1（防双重建竞态）

- `checkout_branch` 只返回 ack，前端**不**用它返回的数据重建视图——真刷新走
  既有 `repo-changed` → `handleRepoRefresh`（它保留存活选择、不动视口）。
  两条重建路径赛跑是侦察明确的竞态，此设计从根上消除。
- 泳道菜单第五项 `checkoutThisBranch`（`is_tag` 泳道隐藏，同 relatedOnly 守卫）；
  与「从此分支查看」并存（语义：改工作区 vs 只改视图）。
- 当前分支泳道标记：`GitData.head_branch` 非空时，Timeline 给同名泳道行加
  「●」/边框高亮（CSS 一处，两种主题变量走既有 token）；detached（None）无
  标记。i18n tooltip「当前分支/current branch」。

### 4.4 对比选择模型（M3.2，纯函数 + 接线）

- App 新状态 `comparePair: { base: string; target: string } | null`；状态机抽
  纯函数 `src/compare.ts`：

```ts
/** Ctrl+click contract: no pair or complete pair -> clicked becomes the new
 *  base (target cleared); base set -> clicked becomes target (compare opens). */
export function nextPair(pair: Pair | null, id: string): Pair;
/** Lane menu "compare with HEAD": base = HEAD commit id, target = lane tip
 *  commit id; null when HEAD is not in the loaded set (windowed out). */
export function headToLaneTip(data: GitData, laneName: string): Pair | null;
```

- Timeline 节点 click 分流：ctrl/meta 按下 → `onCompareClick(d.id)`（新 prop，
  照边上修饰键先例）；否则维持 `onCommitClick`。配对未完成时 base 节点画
  高亮环（区别于单选环与 HEAD 绿环，颜色走新 token）。
- **面板竞争规则（简单优先）**：对比视图与单提交详情共用详情面板位；对比
  激活时普通点击节点 → 关对比开单详情；Esc/关闭按钮 → 关对比。箭头键步进
  只动 selectedCommit，不碰 comparePair。
- 泳道菜单第六项 `compareWithHead`（tag 泳道隐藏）：`headToLaneTip` 为 null
  （HEAD 不在已加载集）时禁用置灰。

### 4.5 对比后端与视图（复用现有 diff 基建）

- `get_compare_detail(base_oid, target_oid)`：泛化 `get_commit_detail`
  （`git_reader.rs:900-924`）的 delta 遍历为任意两树；**每文件 +/−**
  用 `Patch::from_diff`（照 `get_file_diff:656-660` 模式）逐文件取——补上现在
  硬编码 0 的每文件统计；合计沿用现有 totals 语义。
- `get_pair_file_diff(base_oid, target_oid, path)`：泛化 `get_file_diff`
  （610-677），含 200KB 截断与二进制占位同款处理。
- 对比详情视图：**独立 `CompareDetails` 组件**（不往 CommitDetails 里塞分支），
  复用其文件列表渲染、懒加载 per-file 模式与 `DiffView` 行渲染器（可把共享
  部分抽成小组件，以最小搬动为度）。头部显示 `base → target`（短 hash +
  subject），文件列表带每文件 +/−，点文件懒加载行级 diff。
- 分支对比即 tip 对 tip：泳道菜单路径产出的 pair 与手动 Ctrl+点两个 tip 节点
  走完全相同通道。

## 5. 边界情况

- **HEAD 不在已加载集**（日期窗口/分页截断）：与 HEAD 对比禁用；对比视图已
  打开时其中一侧被过滤 → 对比保持（数据已加载，不依赖可见性）。
- **配对两侧相同提交**：nextPair 允许（diff 为空，视图显示 0 文件）——不特殊
  处理，诚实呈现。
- **checkout 目标就是当前分支**：后端照常执行（git 语义：安全无操作），成功
  提示照常；不额外判等。
- **detached HEAD 状态下**：泳道标记消失；「与 HEAD 对比」仍可用（HEAD 提交
  仍会渲染绿环）；checkout 到分支照常。
- **watcher 刷新与终端**：刷新会重建视图（既有行为）；终端面板不动（PTY 会话
  保留，用户 shell 里文件已变——对话框已提示）。
- **mock/E2E**：mock.html 为新命令补 invoke 桩（checkout 模拟成功/冲突两档 +
  status 干净/脏两档 + compare 桩数据），E2E 全链路可测（见 §6）。

## 6. 测试与验收

- **Rust**（临时仓 TDD，§4.1 清单 + compare：两提交差异文件列表/每文件 +/−/
  行级内容/空 diff）。
- **前端 vitest**：`src/compare.test.ts`（nextPair 三态、headToLaneTip 含
  HEAD 缺席 null、tag/laneTip 解析）；i18n 新键 en/zh 双侧齐。
- **E2E（mock，端口 1421）**：
  1. 干净 checkout：菜单第五项 → 无对话框直接成功提示 → 模拟 watcher 刷新。
  2. 脏 checkout：status 桩返回脏 → 对话框出现且计数正确 → 确认 → 成功；
     取消 → 无事。
  3. 冲突桩 → 错误呈现，视图不变。
  4. tag 泳道菜单无第五/六项；当前分支泳道标记出现（mock 数据带 head_branch）。
  5. Ctrl+点两个节点 → 对比视图（文件列表 +/− + 点文件行级 diff）→ Esc 关闭。
  6. 泳道菜单「与 HEAD 对比」→ 同一视图，方向 base=HEAD。
  7. console 全程无错误。
- **真实仓库手动项**（报告记录）：真 checkout 脏携带/冲突两态、终端共存、
  detached HEAD 观感。

## 7. 非目标

- 不做 force/discard 切换、不做建分支/merge/cherry-pick/rename/delete（3.3 已
  裁）、不做 detached checkout 入口（只从分支泳道触发）。
- 不做多仓库标签页、不改 `switch_branch` 既有视图过滤语义（菜单两项并存）。
- 不做 merge/rebase/cherry-pick 进行态的"处理"——只识别并拒绝 checkout。

## 8. 风险与对策

- **写操作首例**：只读红线靠三重护栏——仅此一个命令写树、必须显式确认（脏
  时）、SAFE 模式冲突即止；README/AGENTS 措辞同步放宽，避免文档撒谎。
- **git2 checkout 非原子性**：safe 策略冲突时写前失败（测试钉死 HEAD 不变）；
  极端中断残留交由 git 自身恢复能力，不引入事务层。
- **watcher 刷新时序**：checkout ack 不重建视图，刷新全权交 watcher（防双
  重建竞态，侦察风险 #2 采纳）；最坏 2s 内视图旧态，可接受。
- **AppState.current_branch 语义错位**：不修不删（零调用者，零半径），
  `head_branch` 字段另起炉灶；留待未来清理。

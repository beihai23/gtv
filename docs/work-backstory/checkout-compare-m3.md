---
arc: checkout-compare-m3
started: 294b613
status: in-progress
commits: [461978f, f14a604, 6371ec4, 407dbde, a55091d, 009508a]
---

# M3 checkout 与对比（真实 checkout + 分支/提交对比）

## Intent

Roadmap 2026-08-29 定位裁定：gtv 保持只读，仅开两个例外——切换当前分支
（SAFE 携带语义，须带脏工作区确认）与分支/提交对比（纯读）。本 arc 落地
M3.1（git2 SAFE checkout 后端 + 脏确认对话框 + 当前分支泳道标记）与 M3.2
（Ctrl/Cmd 点击配对 + CompareDetails 对比面板）。设计文档：
`docs/superpowers/specs/2026-08-30-m3-checkout-compare-design.md`。

## Process

- Task 1（Rust `get_worktree_status` + `checkout_branch`，TDD）：先写
  `tests/checkout.rs` 七例（git CLI 造临时仓，`pagination.rs` 模式，每例独立
  临时目录）看红，再落实现。七例：干净切换（HEAD 简名 + oid + 工作区内容
  三重断言）、脏携带（改动随行 + 目标分支新增文件同步生效）、冲突拒绝
  （Err 后 HEAD/文件内容/porcelain 原样零变化——验收核心）、merge 进行中
  拒绝且删 MERGE_HEAD 后恢复、untracked 不阻塞且文件保留、status 三态计数
  （改 2 建 1 + MERGE_HEAD 翻旗）、tag/origin-x 形态/不存在名全拒。
- 两处简报草图与 git2 0.20 实际 API 的偏差，按语义不变原则适配：
  1. `repo.statuses(None)` 拿不到 untracked——libgit2 的
     INCLUDE_UNTRACKED 是 opt-in（默认 flags=0），WT_NEW 永远不出现，
     untracked 恒 0。改为 `StatusOptions::new().include_untracked(true)`
     再 `statuses(Some(&mut opts))`，其余默认与 `git status --porcelain`
     一致（untracked 目录记单条，不递归）。
  2. `CheckoutBuilder` 没有 `.force(bool)`，安全模式是独立方法
     `.safe()`（libgit2 默认即 SAFE）。显式调用 `.safe()` 而非依赖默认
     ——无 force 是本命令的安全契约，值得在调用点写成明文。
- 计数只收 spec §4.1 枚举的两桶：WT_MODIFIED/WT_TYPECHANGE/WT_RENAMED 计
  modified（用 `intersects` 而非精确 match——一条 entry 可同时带
  INDEX_* 位），WT_NEW 计 untracked；WT_DELETED 有意不计入（spec 未列，
  不擅自扩桶）。merge_in_progress 探测 `find_reference("MERGE_HEAD")` 或
  `CHERRY_PICK_HEAD` 伪引用——libgit2 的 refdb 会从 $GITDIR 直读这两个
  伪引用，测试实证有效。
- checkout 顺序铁律「先树后头」：`find_branch(name, Local)`（tag/远端名/
  不存在在此自然失败，同错误串 "Branch not found: {name}"）→ 取 tip 的
  tree → `checkout_tree(tree, SAFE)` → 成功后才 `set_head("refs/heads/<name>")`。
  冲突时 SAFE 在写前失败，HEAD 未动（测试三重钉死）。merge 拒绝错误串定
  死 "merge or cherry-pick in progress"（英文 ASCII，测试精确断言）。
- 命令层零新语义：clone `current_path`（短持锁）→ `spawn_blocking` 里开
  全新 `GitReader`（照 `open_repository` 模式）→ 返回 ack。`CheckoutAck`
  只含 `{ branch }`，绝不返回 GitData、绝不碰 AppState 的 view/session
  ——刷新全权交 watcher 的 repo-changed 链路（spec §4.3 防双重建竞态）。
  `AppState.current_branch` 语义错位不修不删（spec §8）。
- 测试踩坑一记：helper `git_out` 全量 trim 会吃掉 porcelain 输出的行首
  状态列空格（`" M x.txt"` 被修剪成 `"M x.txt"`），冲突零变化断言误判；
  改为对该断言读原始 stdout 字节 `b" M x.txt\n"`。期望值落笔前重数
  （M1.3/M2 教训）——本 arc 首例翻车在 trim 语义而非计数，同族教训。
- 门禁实况：cargo test 42 过（新增 7）；tour_repo 2 例失败为既有状态
  ——fixture 是 contentless gitlink（mode 160000），fresh clone 里永远
  NotFound，与本次改动无关。npm test 73/73 全绿（简报写 65 是 M2 时代
  的旧数，M1.3 arc 后 locate/terminalSize 已加 8 例）。npm run build 过
  （types.ts 镜像编译，chunk >500kB 警告为既有）。
- 评审修复波（461978f 独立评审 CHANGES_REQUESTED，三项全采纳；评审已在
  一次性 worktree 实证补丁并编译跑通，本波照单落地）：
  1. Important-1（预裁定）：staged 变更两桶皆空——git2 的 status flags 把
     head→index（staged，INDEX_*）与 index→worktree（WT_*）分成两组位，
     只 `git add` 过的改动不带任何 WT_* 位，原实现两桶都收不到，脏确认
     对话框会被 `modified: 0` 骗过去。分桶改为 git-status-porcelain 语义：
     仅带 WT_NEW 的 entry 计 untracked（untracked 独来独往，不携带其他
     flag），其余任何 flag（INDEX_* 整组、WT_DELETED、WT_RENAMED、
     WT_TYPECHANGE）都是对 HEAD 的未提交变更，计 modified。上面那条
     Process 里"两桶只收 WT_* / WT_DELETED 有意不计"的表述作废——INDEX_*
     整组漏掉不是保守是漏报。git2 每个 dirty path 恰一条 entry（flags 合并），
     if/else 每条只进一桶，MM 双 flag 场景断言 modified 1 钉死无重复计数。
     新增 4 例：staged 编辑 / staged 新文件（非 untracked）/ 未 staged
     删除 / MM 单计。
  2. Minor-1：先树后头顺序下 set_head 失败（exotic：需 refdb/文件系统级
     故障）的残余态是"index+工作区 = 目标树，HEAD 仍在旧分支"，原错误串
     "Failed to move HEAD" 对此只字不提。改为如实陈述中间态并附恢复命令：
     "Worktree moved to <name> but HEAD could not follow: <e> (run
     `git checkout <name>` to finish)"。
  3. Nit 采纳：REVERT_HEAD 与 MERGE_HEAD/CHERRY_PICK_HEAD 并列纳入进行中
     探测——checkout_branch 拒绝串与 worktree_status 的 merge_in_progress
     旗两处同步（旗的职责就是让对话框提前说出拒绝理由，两处探测集不同步
     会自相矛盾），拒绝串放宽为 "merge, cherry-pick, or revert in
     progress"，精确断言随之更新，另加 REVERT_HEAD 拒绝 + 删除后恢复一例。
  4. 门禁复跑：cargo test 47 过 / 2 败（checkout 套件 7→12；2 败仍为
     tour_repo contentless gitlink 既有状态）；npm test 73/73；npm run
     build 过。commands.rs:279 的命令层注释仍写 "merge or cherry-pick"
     旧措辞——该文件不在本修复波允许触碰清单内，留给后续顺路提交。
- Task 2（Rust compare 后端 + `head_branch`，TDD）：先写
  `tests/compare.rs` 六例看红（13 个编译错：compare_detail /
  pair_file_diff / head_branch 三者皆缺），再落实现。六例：三态文件
  列表（增/删/改各一，每文件 +/− 与合计手数——new.txt A +2/0、gone.txt
  D 0/−2、mod.txt M +1/−1、合计 +3/−3；git CLI 提交输出自证 "3 files
  changed, 3 insertions(+), 3 deletions(-)"）、行级 patch（+TWO/−two
  与 a/b 文件头；未变文件必须解析不到 delta）、空 diff（同 oid 零文件
  零合计，另验方向性：target->base 的 new.txt 变 D 0/−2，两侧合计互为
  镜像）、不存在 oid 双侧皆 Err、head_branch 三态（main→Some("main")、
  checkout feature→Some("feature")、--detach→None 且 is_head 仍在）、
  回归钉（get_commit_detail 每文件 +/- 仍为 0、合计 3/3，get_file_diff
  原样可用，root 提交走空树）。
- 类型决策：**复用 FileChange**——path/additions/deletions/status 四字
  段恰好覆盖对比文件列表的全部所需，compare 只是把它硬编码 0 的两个字
  段填上真值；新增类型只有头部两侧摘要 `CompareSide` 与容器
  `CompareDetail`（files/total_*，totals 按简报 usize）。
- 每文件统计的实现点：delta 遍历带 enumerate 拿索引，
  `Patch::from_diff(&diff, i)` 逐文件再 `line_stats()`。简报草图按
  `stats.additions()` 方法式访问写的——git2 0.20 实际 `line_stats()`
  直接返回 `(context, additions, deletions)` 三元组（无 DiffLineStats
  结构体包装），按元组解构适配，语义不变。binary 文件无 hunk 计 0/0；
  `from_diff` 返回 None（如纯 mode 变更）同样计 0/0。
- 既有通道零回归的手法：把 get_file_diff 的尾部（delta 路径定位 + 建
  patch + 二进制占位 + 200KB 截断，含常量本体）原样抽成私有
  `render_file_patch`，两通道共用——常量只有一份（无新魔数），错误串与
  输出字节级不变，get_file_diff 自身的 oid 解析段（Oid::from_str 三段
  错误串）原封未动。compare 两方法的 oid 解析则走新私有
  `resolve_commit`（revparse_single + peel_to_commit，收全/短 oid、分支
  名、tag 名，与 `git rev-parse` 同宽），compare_detail 产出的 pair 在
  pair_file_diff 里必然可解析。
- `head_branch`：全仓 grep `GitData {` 仅两处构造点——`build_view` 与
  `load_more`，两处都在 head_oid 旁一并取值填入。判别用
  `repo.head().is_branch()`：分支头时 head() 解析为 refs/heads/<b>（true，
  shorthand 即分支名），detached 时返回名为 HEAD 的 direct ref（false→
  None），unborn 时 head() 直接 Err→None。layout 的 is_head 逻辑未动。
- 捎带项落地：commands.rs checkout_branch 命令层 doc 注释由 "merge or
  cherry-pick" 拓宽为 "merge, cherry-pick, or revert"（与 git_reader.rs
  现行文案及拒绝串一致，Task 1 修复波欠账清偿）。
- types.ts 镜像的连锁修正：`npm run build` = `tsc && vite build`，而
  tsconfig include 整个 src（含三个测试文件的 `gitData()` 全字面量构造
  助手）——GitData 加必填 `head_branch: string | null` 后
  related/daterange/inactive 三个测试助手必须补 `head_branch: null`
  （fixture 默认按 detached 语义取 null）。纯类型补齐，73 例计数与行为
  不动。mock.html 未碰（Task 6 统一补桩）。
- 门禁实况：cargo test 53 过（新增 compare 6 例）/ 2 败（tour_repo
  contentless gitlink 既有，与基线一致）；checkout 套件 12/12 无回归；
  npm test 73/73；npm run build 过（chunk >500kB 警告为既有）。
- Task 3（前端纯函数 `src/compare.ts` + M3 i18n 键，TDD）：先写
  `compare.test.ts` 八例看红（模块不存在，编译错），再落实现。nextPair
  三分支照 spec §4.4 契约逐字落：null 或满选（target 非空）→ 点击者
  成为新 base（target 清空）；半选（target 空串）→ 点击者补为 target；
  base===target 不去重不特判（空 diff 诚实呈现，spec §5，测试钉死
  {A,A}）。
- laneTip「导出」实况与简报设想的偏差：locate.ts 里的 laneTip 不是
  模块级函数，是 matchLoaded 体内的局部 Map——「加个 export 就行」
  无从谈起。按两条红线的最小交集落地：在 locate.ts 新增导出纯函数
  `laneTip(commits)`（lane_owner → x 最大提交，与 matchLoaded 内联构造
  逐语义相同）；matchLoaded 体内那四行内联构造原样保留（改它去调用
  新函数就是函数体改动，被「只允许 export 修饰」红线禁止）。代价是
  locate.ts 内四行镜像重复；tip 规则对外单一来源在 locate.ts，Task 5
  接线或 Task 7 终审若认为值得，可申请豁免把 matchLoaded 收敛到该
  函数（语义零变化，locate 现有 10 例护栏已就位）。
- headToLaneTip 三重 null：HEAD 不在已加载 commits（`find(c => c.is_head)`
  落空——日期窗口/分页裁掉，菜单置灰）；泳道名不在 branches 注册表
  （防御——测试用「游离 lane_owner 同名提交但无 branch 泳道」钉死该
  防御先于 tip 解析生效）；泳道无已加载提交（tip 缺席）。方向钉死
  base=HEAD id、target=tip id（fixture 里 tip 按 x 最大取胜而非列表
  顺序，顺带钉住复用的 tip 规则）。
- fixture 照 related.test.ts 手搓 GitData（`head_branch: null` 已是
  Task 2 后的必填镜像字段）。i18n 12 键（checkoutThisBranch …
  nodeCompareTip）en/zh 双侧同序追加在两字典尾部（en :119-130、zh
  :234-245），插值 {modified}/{untracked}/{branch} 走既有 t(key, vars)
  通道；本任务纯加键零消费，Task 4/5 接线时启用。
- 门禁实况：npm test 81/81（73 + compare 8 例；locate.test.ts 现有
  10 例不动全绿——新增导出不触 matchLoaded 语义）；npm run build 过
  （chunk >500kB 警告为既有）。Rust 侧零改动、mock.html 未碰。
- Task 4（接线 M3.1：泳道菜单第五项 + 脏确认对话框 + 当前分支泳道标记）：
  App 状态机照 spec §4.2 逐条——handleCheckoutBranch 预检
  get_worktree_status：merge_in_progress → error 通道且无确认路径；
  脏（modified>0 或 untracked>0——untracked 单独存在也算脏，同名路径
  未跟踪文件会令 SAFE checkout 失败）→ 弹 CheckoutDialog；干净直切。
  doCheckout 成功后除关对话框 + 轻提示外**零操作**——不 setGitData、
  不调任何 refresh；repo-changed watcher（1.5s 指纹轮询 + 500ms 防抖 →
  handleRepoRefresh）是唯一重建路径（spec §4.3 防双重建竞态，四不变量
  之一，调用点注释明文钉死）。失败分支先关对话框再走 error 通道——
  对话框开着会把 banner 压在暗化 backdrop 后面，呈现等于没呈现（简报
  未明说，按「错误必须可见」的意图落地）。
- CheckoutDialog 照 IssueReportDialog overlay 契约（settings-backdrop
  点击 = 取消 + 内层卡片 stopPropagation），卡片类全复用既有
  settings-dialog/settings-header/settings-body/issue-note/issue-actions，
  零新增 CSS。按钮文案零新键：取消复用 close、确认直接用动词短语
  checkoutThisBranch（动作即确认，比裸 Confirm 更诚实）。当前分支自身
  泳道不特判（git 语义安全无操作，spec §5，照常走确认/直切）。
- 轻提示选型：error banner 同款结构的成功变体（`.error.success` 绿底
  覆盖规则，一条 CSS，非独立 toast）。state 形状 `switchedBranch:
  string | null`——存分支名、渲染时 t('switchedTo') 插值（切语言即时
  跟随）；4s 自动消退（effect 定时器，cleanup 覆盖卸载与连续切换）。
  绿色走硬编码 #2ea043：主题系统没有绿 token，而 .error 自身的红就是
  硬编码先例；为单用途给五主题 × 绿 token 超出本任务文件清单。
- 当前分支标记：chip join 里 `d.name === headBranch` 的 chip 加
  head-lane 类（::before ● 前缀 + `rgba(var(--link-rgb), 0.25)` 填充
  ——与 .view-btn.active 同款 active 色，五主题通吃）+ title=
  currentBranchTip；detached（headBranch null）无标记，且 attr(null)
  会清掉旧标记。draw 依赖数组补 headBranch：实践中 head_branch 变化必
  伴随 data 整体重建（watcher setGitData）本已免费，补上是因为 join
  现在直接读它，依赖数组应如实反映。
- 捎带（Task 3 评审 Low-1）：headToLaneTip happy-path fixture x 对调
  ——f1 x=9 列表在前、f2 x=5 在后，期望 target 由 f2 改 f1：现在
  「列表最后一条」与「x 最大」分属两个提交，列表序实现会误取 f2 而挂
  测试，tip 规则真正钉死。断言语义（pair 形状与方向）不变。
- 门禁实况：npm test 81/81（8 文件）；npm run build 过（tsc strict
  门禁；chunk >500kB 警告为既有）。Rust 侧零改动、mock.html 未碰
  （Task 6 统一补桩）、i18n 零新键（Task 3 的 12 键本任务启用 8 个，
  余 4 个留给 Task 5）。
- Task 5（接线 M3.2：Ctrl 配对手势 + CompareDetails 面板 + 与 HEAD
  对比）：DiffView + FileDiffState 从 CommitDetails.tsx 逐字搬出到
  新 DiffView.tsx（唯一改动是两个 export 关键字），CommitDetails 仅
  换成 import——CSS 类名与行为零变化，本任务是评审重点的等价搬动。
  CompareDetails 自取数（useEffect 键 = base+target，cancelled 旗丢
  陈旧响应，懒加载 state 随 fetch 重置），文件列表/行级 diff 结构照
  CommitDetails 抄，头部 base/target 两行用 CompareSide 三字段
  （short_id/subject/author）。
- **简报自相矛盾处按 spec 裁决**：简报要求「handleCommitClick 开头加
  setComparePair(null)」与「箭头步进 :750-775 零改动（箭头不碰
  pair）」不能同时成立——箭头 effect 最后一行就是调 handleCommitClick
  （App.tsx:830），把清 pair 塞进去会让箭头步进顺手关掉对比面板，
  违反 spec §4.4「箭头键步进只动 selectedCommit，不碰 comparePair」。
  落地为 handleNodeClick wrapper（清 pair + 委派），只喂给 Timeline
  的 onCommitClick；handleCommitClick 本体逐字未动，箭头/locate 走
  原通道因此天然不碰 pair（对比面板开着时箭头在面板底下换选择，
  属预期行为）。
- Esc 语义：新全局 keydown（放在箭头 effect 之后），仅当完整对
  （target 非空）开着时 setComparePair(null)，selectedCommit 不动；
  半选（target 空串）不算「对比开着」，Esc 不清它（留给普通点击或
  下一次 ctrl+点击解决）；input/textarea 焦点时让行（locate 下拉的
  Esc 归它自己），照箭头 effect 的 target.tagName 守卫先例。不新增
  「全局 Esc 关单详情」行为（现状无此行为，红线）。
- 三环语义区分（Timeline 注释明文）：单选 = accent 双环（r+8 光晕 +
  r+4 实线）；HEAD = 绿环（r+5）；配对 pending = --compare-ring 双环
  （r+11 光晕 + r+7 虚线 1.5px），半径、线宽、虚线三重可区分。环色
  走新 token cssVar('--compare-ring', ...)，五套主题各配一紫
  （#b388ff/#b48ead/#bd93f9/#6c71c4/#8250df）——简报写「两套 palette」
  与现实不符（THEMES 共五套），五套全配：漏配的三套会静默落到硬编码
  fallback，与既有 token 机制不一致。
- App.css +14 行（≤15 预算内）：.compare-side（面板头部三行堆叠）
  与 .lane-menu button:disabled（「与 HEAD 对比」置灰——无既有
  disabled 样式，置灰是本任务硬需求）。「base 环样式」本体是 D3 SVG
  attr 描边，不走 CSS，故 CSS 预算花在面板与菜单上。
- repo 切换重置块（handleOpenRepo/handleOpenLatestRepo 的
  setSelectedCommit(null) 处）各加三行：setComparePair(null)（本任务
  必须——comparePair 无 backdrop 挡着，旧仓 oid 残留会把新仓
  getCompareDetail 打挂）+ setCheckoutDialog(null) +
  setSwitchedBranch(null)（捎带，Task 4 评审 Low-1，防御性）。
- 门禁实况：npm test 81/81（8 文件）；npm run build 过（tsc strict；
  chunk >500kB 警告为既有）。Rust 侧零改动、mock.html 未碰（Task 6
  统一补桩）、i18n 零新键（余下 4 键本任务全启用：compareWithHead/
  compareBase/compareTarget/nodeCompareTip）、compare.ts 纯函数零
  改动、箭头步进代码零改动。真机不跑（Task 6 mock 桩 E2E 统一验）。
- Task 6（mock.html invoke 桩 + E2E 七项全量验收）：唯一源码侧改动
  mock.html——新增 `window.MOCK = { worktree: 'clean'|'dirty'|'merge',
  checkout: 'ok'|'err' }` 档位（js 实时翻档，免 reload）与四个 invoke
  桩（get_worktree_status 三档 / checkout_branch ok+err / get_compare_detail
  静态合成 / get_pair_file_diff 手写 patch），并在 ready 注入
  `d.head_branch='main'`（dump 早于该字段）。compare 桩 CONTRACT
  APPROXIMATION：mock 跑不了 git，文件列表与合计写死（+10/0、0/-4、
  +6/-2、合计 16/6，逐数断言），但两侧按 id 查 DATA 真提交——面板头部
  如实反映实际配对；base===target 照 git 空差异诚实返回空列表（spec
  §5 边界因此可测）。既有桩行为零变化。
- E2E 关键决策：dump 里 `DATA.branches[1]`（feat/1）是死泳道——默认
  视图被 collapse 进 trace row，chip 不存在，右键不到。方向验证改用
  活泳道 **now/1**（tip 09016ec「active 1」），与 HEAD a78834f 天然
  区分方向。另外默认视图 compressed，「`.node[i]` ↔ DATA.commits[i]」
  简报映射不成立（527 可见 vs 1477 总数）——改用 d3 `__data__` 直读
  节点 id，更稳。
- E2E 发现（未修，红线 src/ 不动）：**CompareDetails 文件行不渲染
  每文件 +/-**——Task 5 简报明文「直接渲染 additions/deletions + status
  字母」、spec §4.5「文件列表带每文件 +/−」，实际行内只有 status 字母
  + 路径 + 展开箭头（照 CommitDetails 无数字行抄死了）。数据模型
  FileChange.additions/deletions 已到位，纯展示缺口。
- E2E 发现（既有、非 M3）：App 每次重渲（toast 出现/消失、error banner、
  对话框）都会整幅重画 d3 场景——`patchLinks={showPatchLinks ?
  patchLinks : []}`（App.tsx，125742b 引入）每渲一个新 `[]`，落在 draw
  useCallback 依赖里。React `<svg>` 不重挂、transform/节点数/选择全保
  留，视觉无感，纯性能疣。七项断言的「无重建」按 React/data/viewport
  三层取证，d3 `<g>` 身份不作为断言依据。
- E2E 其余：tag 泳道菜单实测 3 项（简报写 4 项是漏算——relatedOnly 从
  M2 起就 tag-gated，mock.html 注释本有记载）；核心断言（无第五/六项）
  通过。console 全程零错误；门禁 npm test 81/81 + build 过。
- 修复波（Task 6 E2E BUG-1 单点修）：CompareDetails 文件行补上每文件
  +/−——`.file-row` 的 path 与展开箭头之间加两个 span，直接复用既有
  diff-add/diff-del 类（与合计行、时间轴悬浮同款绿/红），零新增 CSS；
  CommitDetails 的逐字 0 行不碰（后端钉死行为）。mock E2E 复验（1421）：
  右键 now/1 → 与 HEAD 对比，三行 +10/−0、+0/−4、+6/−2 全数落 DOM
  （行文本 "Amock/added.txt+10−0▸" 等，computed color 实证绿
  #4CAF50/红 #F44336），点行展开懒加载照常，console 零错误；门禁
  npm test 81/81、npm run build 过。

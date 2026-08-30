---
arc: checkout-compare-m3
started: 294b613
status: in-progress
commits: [461978f, f14a604, 6371ec4]
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

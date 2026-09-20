---
arc: transfi-lane-misattribution
started: c616820812955a96ee073a9ff586b7fd4b8bc38c
status: resolved
commits: []
---

# 查明 gtv 把 transfi 提交画到 webhook 车道的原因

## Intent

用户在 ms_otc 仓库发现：commit `15557e0`（chore(transfi)，tip of
`origin/feat/otc-transfi-form-engine-submit-gate`）被 gtv 画在
`feat/noah-va-rfi-webhook` 车道末尾（tooltip lane_owner 也显示 webhook），
而另一个 git 客户端显示它属于 transfi 分支。按 git 语义该提交根本不是
webhook 的祖先。目标：定位根因，判断是算法 bug 还是视图状态问题。

## Process

- git 取证（ms_otc）：15557e0 parent=72e3da7，仅被 transfi 分支与 pre（经
  merge 68ab97，second parent=15557e0）包含；**不是** webhook/test/main 的
  祖先。ms_otc 无本地 transfi、无本地 pre 分支 → origin 版本按规则成为种子。
- 纸面推演：按 layout.rs（merged-tip 优先、tip 墙、first-parent 认领），
  没有任何其他种子的 first-parent 链能到达 15557e0 → 全种子视图下应归
  transfi 车道，与截图矛盾 → 转向「用户视图状态」假设。
- 复现测试（临时 tests/lanes_repro_tmp.rs，已删）：真实 ms_otc +
  `read_git_data(2000)` 全种子视图 → 15557e0 正确归 lane 67
  feat/otc-transfi-form-engine-submit-gate。**算法本身没错**。
- 用 `filter_by_branches` 模拟「选中集无 transfi、无 main」→ 复现截图：
  `main_branch=feat/noah-va-rfi-webhook`，webhook 变 lane 0（#4A90D9 蓝），
  15557e0 兜底归 webhook。
- 直接证据：Tauri WebView localStorage
  `~/Library/WebKit/com.gtv.app/WebsiteData/.../localstorage.sqlite3`
  （UTF-16LE 编码，hex → xxd → iconv 解码），key
  `gtv_branch_sel:/Users/lance.wang/workspace/backend/ms_otc` 的值为
  **`["feat/noah-va-rfi-webhook","test","pre"]`** —— M2.4 持久化分支选择
  正好只有三个分支（面板页脚提示的工作流：None 后双击 solo 常用分支）。

## Decisions

根因（两层兜底叠加，非车道传播算法 bug）：

1. 用户某次在分支面板把 ms_otc 的选择收窄为 webhook/test/pre 三支，M2.4
   将其持久化并在每次打开时自动恢复 → transfi 种子缺席。
2. transfi 缺席后，没有任何种子的 first-parent 链能到达 15557e0（它只在
   transfi 自己的链上；对 pre 是 68ab97 的第二父侧）→ 命中
   `layout.rs:183-187`「每个提交必须有车道」兜底 = 归 `main_branch`。
3. `detect_main_branch`（git_reader.rs:128）在选中集无 main/master 时退化
   为 `seeds.first()` = feat/noah-va-rfi-webhook → webhook 被当主线：
   lane 0、主蓝 #4A90D9、最先认领。15557e0（窗口内最新提交）画在蓝道
   最右端，tooltip 显示 lane_owner=webhook。
4. 徽章来自 branch_refs（与种子无关）→ origin/transfi 徽章照常钉在该
   节点上，视觉上成了「webhook 车道上挂着 transfi 徽章」。

全种子视图下同一提交正确归 transfi 车道（测试验证）——用户即时解法：
分支面板把 transfi 勾回（或 All）。

遗留缺陷候选（未实施，等用户决定）：
- 携带 ref 的提交若其分支未被选中，兜底归 main_branch 具有误导性；候选：
  自动把 ref 分支拉进种子 / 标记为未归属（幽灵节点）。
- `detect_main_branch` 的 `seeds.first()` 兜底会在 main 未选时把任意分支
  当主线（本例 webhook 顶替成蓝道即此）。
- 面板 Disabled 分组已存在，但视图层面缺少「当前仅显示 N 个选中分支」
  的强提示。

## 修复阶段（同日续）

- 用户拍板：修好直接覆盖 `~/workspace/tools/gtv.app`，覆盖无需确认；
  并质疑「两个方向为什么要用户选」——应当自己定夺。定夺依据如下。
- 方案取舍（决定：未归属标记，不做自动拉种子、不动 seeds.first()）：
  - **自动把 ref 分支拉进种子** → 违背面板 Disabled 契约：用户明确关掉
    的分支会重新长出车道，且注入的 lane 不在 selectedBranches 里，面板
    Enabled/Disabled 分组与实际渲染自相矛盾。否决。
  - **去掉 seeds.first() 兜底** → 单分支聚焦视图（from_branch /
    from_commit）靠它让焦点分支占 lane 0；去掉会让未归属提交 owner 变
    空串但仍 unwrap_or(0) 落在蓝道，撒谎程度不减。否决。
  - **未归属标记（最终方案）**：layout.rs 兜底改两趟——第一趟，未被任何
    种子认领但携带 branch_refs 的提交置 `lane_owner=""`，且沿 first-parent
    链向下把同样无主的祖先一起置空（否则会出现灰 tip 压在 main 色父链上
    的分裂）；第二趟，匿名无主提交维持旧 main_branch 兜底（陈旧合并世系
    行为不变）。连带修掉 merge 标签 bug：第二父未归属时不再设置空标签
    （修复前过滤视图里 68ab97 的 merge chip 会错误显示 webhook）。
- 前端（Timeline.tsx）：`ownerColor(owner)` helper——空 owner 返回中性灰
  `#9E9E9E`（双主题可见、区别于主蓝）；节点/徽章/边/小地图四处渲染统一
  走 helper；tooltip 的「author · 车道」在 owner 为空时不显示分支段，
  归属信息交给提交自带的 refs 徽章。
- 验证：layout_pure 新增 3 测试（未选中 ref tip → 未归属且链式传播、
  选中 ref tip → 自有车道 + merge 标签、匿名无主 → 维持 main 兜底）；
  `cargo test` 全绿（tour_repo 2 个失败为既有环境问题——
  docs/reference/gmaster-tour fixture 目录为空，与本次改动无关）；
  `tsc --noEmit` 干净；vitest 108 通过。构建用 `tauri build --bundles app`
  跳过 dmg（本机 bundle_dmg.sh 一直失败）。

## 二次返工：灰色借道方案被否，改为彻底隐藏（同日）

- 第一版部署后用户否决：灰节点仍然停在 webhook 泳道上（fallback 落在
  lane 0 = webhook 行），且 laneSpan 把它们算进车道条跨度，蓝线直接穿过
  灰节点——视觉上依然是「别的分支的 commit 出现在我的泳道上」。用户
  立下不变量：**每个泳道只能出现自己分支的 commit**，与选没选中无关，
  准确性最高优先级。
- 重新定语义：lane = 该分支 first-parent 谱系（git log --first-parent 的
  图形化）。任何未被选中种子 first-parent 认领的提交 = 外来谱系 =
  未归属 = **彻底隐藏**（不再有灰节点、不再有 main_branch 兜底）。
  旧「匿名无主 → main_branch」兜底同步废除——它正是过滤视图里外来
  提交染成 webhook 蓝的根源，对陈旧合并世系同样成立（那不是 main 的
  提交）。
- layout.rs：
  - 兜底简化为一趟：所有无主提交置 `lane_owner=""`（链式传播不再需要，
    因为无主即隐藏，颜色无意义）。
  - `is_key` 对空 owner 强制 false：不进 x 级联、不进小地图、不进压缩
    视图、不触发 stats 拉取。
  - merge 标签新来源：第二父未归属时，从其 branch_refs 取名（去
    origin/ 前缀、跳过 tag）——merge 节点留在泳道上且「合入了什么」
    依然可读（68ab97 → "feat/otc-transfi-form-engine-submit-gate"）。
- Timeline.tsx：visibleCommits 过滤 `lane_owner===''`（节点与边经
  visibleIds 自动消失）；laneSpan（车道条/小地图活跃条/collapse chip）
  排除空 owner；hiddenCountByLane 同步排除。ownerColor 灰色分支保留
  作防御。
- RepoView.tsx：locate 双路（matchLoaded 载入匹配 + 后端 remoteHits）
  均过滤外来提交——隐藏的提交不再以 in_view 命中搜索；「从该提交查看」
  的 jump 路径不受影响（单种子视图里它自成一车道，合理）。
- 测试更新：layout_pure 匿名用例改为断言未归属；ref-tip 用例断言
  is_key=false 且 merge 标签来自 refs。cargo test 全绿（除既有 tour
  fixture 环境失败）、tsc 干净、vitest 108 通过。
- 部署：`tauri build --bundles app` → rsync 覆盖 `~/workspace/tools/gtv.app`
  （用户明确授权覆盖，无需再确认）。
- 经验：**先问清不变量再给折中**。灰色借道是「DAG 连续性优先」下的
  折中，但用户的不变量是「泳道纯净」——两者冲突时折中方案必然返工。
  泳道图的产品语义应该从用户对 git 的心智模型（first-parent 历史）
  推导，而不是从渲染便利性推导。

## Lessons

- 「提交被画在哪条车道」由 lane_owner 决定（Timeline.tsx:1505 tooltip
  直接显示它），徽章只是 refs 渲染，两者来源不同——徽章所在车道 ≠
  该提交真属于那条分支。
- gtv 的视图状态里有一层看不见的输入：M2.4 持久化分支选择（localStorage
  `gtv_branch_sel:<repoPath>`），排障时先核对它，再怀疑算法。
- Tauri WKWebView 的 localStorage 在
  `~/Library/WebKit/<bundle-id>/WebsiteData/.../localstorage.sqlite3`，
  值为 UTF-16LE，`CAST AS TEXT` 会在首个 NUL 截断；用
  `hex(value)` → `xxd -r -p` → `iconv -f UTF-16LE` 解码。
- 排查渲染类 bug：先在真实数据上复现「算法应然」，再对比「用户实然」，
  差值往往指向会话状态而不是代码。

## Related

- `src-tauri/src/layout.rs:146-187`（种子认领 + fallback=main_branch）
- `src-tauri/src/git_reader.rs:75-137`（collect_lane_seeds / detect_main_branch）
- `src/RepoView.tsx:341-379`（handleFilterChange + M2.4 选择恢复）
- `src/persist.ts`（gtv_branch_sel:<repoPath> 持久化）
- `src/components/Timeline.tsx:1505`（tooltip 显示 lane_owner）
- 参照：docs/work-backstory/filter-system-m2.md、inactive-lane-collapse.md

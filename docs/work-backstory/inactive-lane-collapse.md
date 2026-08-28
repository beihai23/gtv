---
arc: inactive-lane-collapse
started: 4eca091
status: resolved
commits: [4a519f1, 6a7872d, 7154f11, 7196efa, 5f63c9a, 6c024f0, 7ffeacb, 6fe9ebe, b0f21c7]
---

# M1.2 非活跃泳道收拢

## Intent

Roadmap M1.2（最高优先级里程碑 M1 的最后一项）：已合并且 tip 超过 N 天无活动的
泳道默认收拢，让大仓库（1000+ 分支）打开后默认泳道数 ≤ 30，实现"打开即用"。
背景：现有 stale 开关（分页 arc 引入）是"tip 在已加载窗口外"的加载语义，
不解决"几百条早已合并的死分支占满画布"的默认视图问题。

## Process

- 上下文勘察：`BranchLane` 模型已有 `merged_into: Option<String>`（吸收该 tip
  的 merge commit）——"已合并"信号现成；`is_active` 是"分支 ref 是否还存在"
  （ghost lane 概念），与活跃度无关，勿混淆。前端 y = `lane_index *
  LANE_HEIGHT` 直接用后端 lane_index；分支面板已有 enabled/rest 分组和
  `filterByBranches(names)` 全量视图重建路径（后端复用缓存视图，便宜）。
- 注意：settings 里 "stale" 的中文翻译就叫"显示不活跃分支"（gtv_show_stale），
  与本 arc 的 inactive 概念撞名，设计时要理顺命名。
- 需求澄清结论（用户逐项拍板）：
  1. 收拢范围 = 已合并 + 长期未合并都收，分两组（"已归档" / "休眠"）——
     只收已合并的大概率到不了 ≤30 泳道的验收线。
  2. 阈值 90 天默认，设置页可调；判定基准 = 泳道 tip commit 的 committer ts。
  3. 图上形态 = 压缩痕迹行：死泳道不占独立行，lane bar 压进特殊薄行
     （只画 bar 不画节点），一眼看出"历史沉在这里"。（用户主动选了比
     "完全消失"更有信息量的路线。）
  4. 展开交互 = 分支面板分组勾选（单条恢复）+ 痕迹行点击整组展开；
     本次不持久化（跨会话记忆归 M2.4 另做）。
  5. 长驻保护 = 内置名单（main/master/dev/develop/test/uat/staging/release/*、
     hotfix/*）+ 结构规则（活跃泳道的 fork 父链闭包不收，"死的定义是没有
     活的东西依赖它"）。结构性红利：merge 目标泳道自动保鲜（吸收 merge
     commit 落在目标泳道，tip ts 更新），近期被合入的 env 分支天然不收。
- tag 泵道不是真泳道：get_branch_list 里 append 的伪 lane（fork_point/
  merged_into 恒 None，无 commit 归属），收拢逻辑必须 is_tag=false 才适用。
- 实现方案选 A（纯前端渲染层收拢），否决 B（后端剔除重建：打开多一次全量
  重建、x 随收拢变化、展开要回程）与 C（后端打标：判定下沉的收益抵不过
  阈值变更需重开的开销，留作演进）。
- 用户修正长驻名单：release/*、hotfix/* 这类**无界**通配不能进名单——不清理
  的团队会堆几百条，名单一保护验收就破产。洞察：活跃的 release/hotfix 本就
  被活动规则保住，fork 父链闭包再保「有活跃后代的」；名单真正管的是「安静
  超阈值但用户预期在场」的 env 基座。终版名单只收确名（每仓至多一两条）：
  main/master/dev/develop/test/testing/uat/staging/sit/qa/prod/production/
  integration/release/hotfix。v1 无通配匹配、无第二档时间上限。
- 写实施计划（docs/superpowers/plans/2026-08-28-inactive-lane-collapse.md，
  7 个任务 TDD）时自审揪出两个设计漏洞，已回修 spec：
  1. **零自有 commit 泳道逃逸**：ref 挂在别的泳道 commit 上（release/v1.x
     挂在旧 main commit 上）的泳道没有自有 commit，"tip = 本泳道 commit
     最大时间戳"取不到值 → 不参与判定 → 不收拢。验收 fixture 里 100 条
     release/* 恰好全是这种形态，规则砸自己脚。修复：判定加 ref 目标
     commit 时间戳兜底。
  2. **伪 lane 不能进 branches 数组**：spec 原文说"追加两条伪 lane 进
     branches 让渲染点原样工作"，但隐藏 commit 的 lane/y 指向痕迹行号后，
     laneSpan（按 lane 号聚合）会让 lane-bar join 画出一条合并 span 的
     伪 bar；rail chip 的点击语义也不同（展开整组 vs 聚焦）。修复：伪
     行不进 branches，bar/chip 走 traceBars/traceRows prop 单独渲染。
- 视口锚定（分页重排）代码读完确认只按 x 补偿、而收拢不变 x——spec 里
  "只在可见 commit 里取锚点"的预防性要求实际不需要改锚定路径（重置
  视口的目标选择仍改为优先可见节点，防 HEAD 落在收拢泳道上）。
- 实施（Tasks 1-6）：vitest 进入前端（`npm test`，目前仅 src/inactive.test.ts，
  20 用例）；computeInactive/collapseLanes 纯函数、阈值设置 gtv_inactive_days
  （默认 90，0=关）、Timeline 痕迹行（traceBars/traceRows 独立 prop，伪行不进
  branches 数组）、App 接线（expandedDead 状态、面板已归档/休眠分组 + 单条
  恢复、locate 命中死泳道先自动展开、方向键只在可见 commit 间步进）。
- Task 6 顺序坑：brief 指定 memo 块放 refActivity 前、expandTraceGroup 放
  toggleBranchFilter 后，但实际文件里 toggleBranchFilter 在 refActivity 之前，
  照抄会让 useCallback deps 引用尚未声明的 inactive（TS2448/TDZ 崩溃）——
  memo 块上移到 handlers 之前解决。
- 验收（Task 7）：`docs/tools/gen_inactive_repo.sh` 造 1079 分支仓库（1477
  commits，~400 天前活动），默认 90 天首开 = 26 泳道 + 已归档(500)/休眠(450)
  两条痕迹行（≤30 达标且未碰设置）；痕迹行/trace chip 整组恢复、面板死芯片
  单条恢复、Cmd+F 定位 wip/123 自动展开、设置切"不收拢"后 976 泳道全量渲染、
  main 泳道上 ←/→ 步进严格留在本泳道可见 commit 内，全程无 console 错误。
- fixture 脚本隐蔽坑：c() 的日期环境变量只包住 commit，`git merge` 不吃——
  500 个 merge 不钉日期就全是"现在"，挂在最后一个 merge 上的 100 条 release/*
  引用随之全变新鲜，≤30 验收当场破产。脚本里 merge 单独包一层 m() 钉
  GIT_AUTHOR_DATE/GIT_COMMITTER_DATE。
- 实测推翻计划期预判："ref 停在别的泳道 commit 上"的分支（dev/uat/staging/
  release/*）在后端 layout 里**根本不产生泳道**，只作为该 commit 的
  branch_refs 徽标出现——本 fixture 里零自有 commit 泳道一条都不存在，
  refTs 兜底与 PROTECTED_NAMES 均未被触发（纯函数测试仍覆盖该路径）。
  ≤30 的实际构成 = main + 25 条 now/*，950 条死泳道（500 已合并 + 450 弃置）全收。
- mock.html 的 get_commit_detail 恒返 null，详情面板开不了 → 方向键验收被堵；
  临时给 mock 补了从 DATA 拼 CommitDetail 的分支（repo 惯例：临时 patch、
  验完 git checkout 还原并记录于报告）。
- public/mock-data.json 在 .gitignore 里（本地文件，不入库）——"git checkout
  还原"约定在这里不成立：本机找不到 taskon-server 源仓库，原 dump 无法重建，
  该文件现留验收 fixture 内容（对任意真实仓库重跑 dump_json 即可覆盖）。

## Decisions

- 收拢实现选纯前端显示变换（方案 A）：后端视图不动、x 坐标不动、展开零回程。
  否决后端剔除重建（打开多一次全量重建、x 随收拢变化）与后端打标（阈值变更
  要重开仓库，留作演进）。
- 死泳道不删不隐，沉成"痕迹行"（sediment）：已归档（已合并）/休眠（未合并）
  两组各一行薄 bar，"历史沉在这里"一眼可见——用户主动选了比"完全消失"更有
  信息量的路线。
- 伪痕迹行不进 branches 数组，bar/chip 走 traceBars/traceRows 单独 prop：
  进数组会被 laneSpan 聚合画出合并 span 的伪 bar，rail chip 的点击语义也冲突
  （整组展开 vs 泳道聚焦）。
- 长驻保护只收确名（main/master/dev/develop/test/testing/uat/staging/sit/qa/
  prod/production/integration/release/hotfix），无通配：release/*、hotfix/* 无界
  堆积，名单一保护验收就破产；名单真正管的是"安静超阈值但用户预期在场"的
  env 基座，活跃的 release/hotfix 由新鲜度规则天然保住。
- 泳道 tip 判定 = max(本泳道已加载 commit ts, ref 目标 commit ts)——零自有
  commit 的泳道用 ref 时间戳兜底（防 release/v1.x 形态逃逸）。
- 前端测试基建 = vitest 只测纯函数（src/inactive.ts）；渲染/交互层仍不设自动
  化测试，其余留在 Rust。
- 验收 fixture 的每个 commit 与 merge 都显式钉死日期——merge 不钉会静默把
  死引用变新鲜。

## Lessons

- `git merge` 不继承 `git commit` 那套日期环境变量的调用点，要单独包一层；
  造时间敏感 fixture 先 `git log --format=%ct` 抽查再跑判定逻辑。
- "ref 挂在别的泳道 commit 上"的分支可能根本不是泳道——设计 fixture 断言前
  先看 dump 出的 branches 数组，别按数据模型想象。
- mock.html 驱动不了依赖 get_commit_detail 的路径；临时 patch mock + 验后
  还原可行，但要在报告里写明改了什么、何时还原。
- public/mock-data.json 是 gitignored 的本地文件："还原 mock 数据"只在源仓库
  在手时成立；跨机环境可能拿不回原 dump。
- App.tsx 里 memo/useCallback 声明顺序是硬约束（deps 引用未声明标识符 =
  TS2448/TDZ）；插入位置以"被依赖者先声明"为准，不照抄 brief 的相对位置。
- rail 上 trace chip 必须放在 branches join 之后追加：branches join 的 exit
  负责清除上一帧 trace chip（其 key 不在 branches 数据里）。

## Related

- 核心改动：`src/inactive.ts`（computeInactive/collapseLanes）、`src/settings.tsx`
  （gtv_inactive_days）、`src/components/Timeline.tsx`（痕迹行渲染/cull/minimap/
  视口重置）、`src/App.tsx`（expandedDead、面板分组、locate 自动展开、方向键
  可见集过滤）
- 测试：`src/inactive.test.ts`（vitest，20 用例）；验收工具：
  `docs/tools/gen_inactive_repo.sh`

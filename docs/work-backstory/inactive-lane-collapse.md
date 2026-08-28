---
arc: inactive-lane-collapse
started: 4eca091
status: active
commits: [4a519f1, 6a7872d, 7154f11]
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

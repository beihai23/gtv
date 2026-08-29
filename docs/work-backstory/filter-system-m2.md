---
arc: filter-system-m2
started: 4dcc5fe
status: in-progress
commits: [190df0a, 88393c2, e2cd6cb, 732b351, 8da6c0d]
---

# M2 过滤系统补完（关联分支 / 日期范围 / remotes / 关注集持久化）

## Intent

Roadmap M2 四件套：右键泳道只看血缘闭包（2.1）、顶栏日期范围下拉（2.2）、
一键隐藏 origin/* badge（2.3）、分支选择按仓库路径持久化恢复（2.4）。
四项全部前端改动，Rust 后端零改动；分支选择集 `selectedBranches` 是唯一
事实源——2.1 产出选择集（`src/related.ts` 闭包 → 既有 `filter_by_branches`
重建），2.4 持久化选择集，2.2/2.3 是选择集之上的显示层变换。设计文档：
`docs/superpowers/specs/2026-08-29-m2-filter-system-design.md`（血缘定义在
§4.1：单线上链、兄弟排除、子孙 BFS、merge 单跳、main 兜底）。

## Process

- Task 1（related.ts）：TDD 先写 10 个用例看红再实现。共用一个 master
  fixture（main←A←B 单线 + C 兄弟 + D/E 子孙 + D 并入 release + release
  再并入 other 传递陷阱 + X 反向并入 B）跑满 7 个计划用例，另加 3 个计划
  外锚点：全集精确断言（7 条，落笔前手工重数）、未知 target 防御、tag 泳道
  排除（后两者是计划"实现要点"里有、测试清单里没有的行为）。与计划的理解
  差异：反向 merge（被并入者算血缘）实现对**整条 core**（target ∪ 上链 ∪
  子孙）判定，而非仅 target——并入 target 祖先的分支其 tip 同样落在血史里；
  计划只钉了 target 这一情形，此为语义外推，Task 4 接线时留意是否过宽。
  断言计数无翻车（M1.3 教训生效：全集 7、最小 3、截断 3、防御 1、tag 2）。
- 复审改判（review Minor #3，fix 提交）：上条"整条 core 判定"的初判被推翻——
  main 几乎总在闭包里（兜底 + 上链终点），真实仓库几乎所有已合并分支的
  merged_into 都指向 main，core 级反扫会把大半个仓库拉进闭包，M2.1 的目的
  落空。终版：反向并入只对 target 泳道判定（并入受检分支的子特性是它的
  故事；并入祖先/main/子孙的是共享基座的其他故事，与兄弟 fork 排除同理；
  误归属无虞——solo 展示（双击 chip）的 layout 回退本就把这类提交算进
  所在泳道）。master fixture 加 Y/Z/W 三条反向陷阱（并入 A / 并入 main /
  并入 D 均不进），全集断言仍恰为 7 条；TDD 先红（旧实现收 10 条）后绿。
- Task 2（daterange.ts）：TDD 先红（模块未建，39 旧用例不受影响）后绿，9
  用例按清单全数落地。简报用例 2 的示意数字内部矛盾：ts {100..900} 配
  days=1 时窗口 [900−86400, 900] 起点为负，任何正 ts 都在窗内，"ts=5 被滤
  掉"不可能发生；按原意改用 epoch 秒尺度 fixture（锚点=最新已加载 ts、左
  缘恰好压界的提交保留），被测语义不变。
- x 平移有意打破 M1.2「x 永不移动」不变量（spec §4.2 已记录）：泳道收拢是
  同数据重排行的约束，日期窗口是数据级裁剪，纯平移保 px/day 密度，刻度尺
  分段插值自洽。gap 只裁 x 不动 t_start/t_end——刻度尺 inGap 判定读时间
  字段，保留原始时间跨度才不误导。
- Task 3（refs.ts + persist.ts + hideRemotes）：TDD 先红（两模块未建，48 旧
  用例不受影响）后绿，13 用例 = refs 2 + persist 11。清单只要求 ≥7，补的
  四例：空数组显式保存的往返（"全不选"是真选择）、key 格式 `gtv_branch_sel:
  <repoPath>` 钉死（Task 4/5 依赖该持久化契约）、非 JSON 垃圾、saved 顺序
  打乱验证输出按 available 排序。
- persist 的 localStorage 在 vitest（node 环境）不存在：persist.ts 惰性经
  globalThis 取 storage、读写全程 try/catch（save 失败静默 best-effort，
  load 任何脏数据——缺失/非 JSON/非字符串数组——一律 null）；测试用
  vi.stubGlobal 注入 Map 桩（beforeEach 装、afterEach 卸，unstubAllGlobals
  还原原始描述符，不惧未来 node 自带 storage）。
- hideRemotes 照抄 showStaleBranches 模式，仅默认值方向相反：初始化
  `=== '1'`（默认 false = 现状显示），而 showStale 是 `!== '0'`（默认
  true）。filterRefs 在 false 时返回原数组引用保下游 memo 身份——与
  daterange 'all' 的 toBe 先例同一原则。
- Task 4（接线 2.1+2.3）：lane-menu 第四项 relatedOnly → App
  handleRelatedBranch（原始 gitData 算闭包——view 副本的 lane_index 已被
  收拢重写，Set 展开成 string[] 走既有 handleFilterChange）。画布 badge 是
  五处里的暗坑：`<title>` 全名 join 原先直读 `s.c.branch_refs`，只把
  slice(0,2)/extra 挪到 filter 之后不够，BadgeSpec 得把过滤后列表带进渲染
  闭包（s.refs）幽灵计数才断根；tooltip/CommitDetails 整行显隐改按过滤后
  长度判。matchLoaded 第 4 参默认 false 保 8 个旧用例零改动，TDD 先红后绿
  加 2 例（remote-only ref 隐藏后不命中；同名本地 lane 经未动的 laneTip
  仍命中）。TDZ：handleRelatedBranch 落 handleFilterChange 之后（M1.3
  地雷），依赖全前置，tsc strict 过。

## Decisions

- 反向 merge（被并入 target 的分支算血缘）**只对 target 泳道判定**，单跳
  不传递：并入祖先（含 main）或子孙的分支不进闭包。理由：真实仓库几乎所有
  merged_into 都指向 main，而 main 几乎总在闭包里，祖先级反扫等于全仓收录
  （review Minor #3 的爆炸半径论证）；与兄弟 fork 排除同一原则——共享基座的
  其他故事不属于受检分支。正向 mergeTarget 仍是 core 内每条泳道单跳（收
  闭包成员的去向），merge 边永不链式传递。

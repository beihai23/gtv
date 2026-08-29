---
arc: filter-system-m2
started: 4dcc5fe
status: in-progress
commits: [190df0a]
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

## Decisions

- 反向 merge（被并入 target 的分支算血缘）**只对 target 泳道判定**，单跳
  不传递：并入祖先（含 main）或子孙的分支不进闭包。理由：真实仓库几乎所有
  merged_into 都指向 main，而 main 几乎总在闭包里，祖先级反扫等于全仓收录
  （review Minor #3 的爆炸半径论证）；与兄弟 fork 排除同一原则——共享基座的
  其他故事不属于受检分支。正向 mergeTarget 仍是 core 内每条泳道单跳（收
  闭包成员的去向），merge 边永不链式传递。

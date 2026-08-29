---
arc: filter-system-m2
started: 4dcc5fe
status: in-progress
commits: [pending]
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

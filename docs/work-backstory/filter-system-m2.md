---
arc: filter-system-m2
started: 4dcc5fe
status: resolved
commits: [190df0a, 88393c2, 7f73b37, e2cd6cb, 4986429, 732b351, b5b438a, 8da6c0d, c54208f, 4688455, 0bc938f, 3ef3797, d0edd70, 8c92136, ae63b11, 6d6cacf]
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
- Task 5（接线 2.2+2.4）：管道按铁律重排——gitData → applyDateRange →
  computeInactive(过滤后) → dead 并集（范围空覆盖时效规则）→ collapseLanes，
  collapseLanes 只吃 applyDateRange 产物。下游四处同步：箭头步进过滤
  hiddenIds ∪ outOfRange（依赖补全）；locate matchLoaded 改吃 rangedData
  （搜你所见）+ 范围激活时远端命中 in_view 按 outOfRange 降级、沿用既有
  「从该提交查看」跳转路径；header commitCount 改读 rangedData.commits
  （has_more 仍读原始）；refActivity/sortedBranches 刻意不动（面板全量
  活跃度排序更诚实）。TDZ 新雷：M2.4 恢复让两个 open handler 的
  useCallback 依赖数组在渲染期读 handleFilterChange，原声明在其后 →
  handleFilterChange 整体上移到 loadDiffStats 之后（M1.3 地雷同款）。
  自定义窗口：两个 'YYYY-MM-DD' string state，换算 Math.floor(new
  Date(v).getTime()/1000)，空串兜底 from=0 / to=最新已加载 ts（即 preset
  锚点），min/max 交叉约束防 start>end；end 取所选日 UTC 零点（简报公式
  原样，不加当日末端秒）。date input 的 placeholder 是死属性（type=date
  不渲染），dateFrom/dateTo 落在 title/aria-label。保存 effect 保留空选择
  守卫（空=瞬态会话态；无守卫会把策展集覆盖成空、下次恢复回落全选）。
  简报 select onChange 草图的 else 分支漏了 'all'（Number('all')=NaN 会
  清空视图），补成三路分支。
- 复审改判（review Important，Task 5 deviation 4）：自定义 end 只取所选日
  UTC 零点是真缺陷——「止」当天的日内时间戳提交全被排除，而 preset 锚定
  最新日内 ts、含当天，两类范围自相矛盾；修为 +86399 闭到当日末秒。
- Task 6（mock 增强 + E2E 全量验收）：mock filter_by_branches 从「原样
  返回」改为按 lane_owner/名称/双端可见边裁剪——契约近似（真实后端重走
  血缘并重排 lane_index，mock 保 dump index 留空洞，注释写明）；空
  names → 空视图（零种子零提交）。另在前 3 泳道（main/feat1/feat2）tip
  注入 origin/<name> is_remote 合成 ref（fixture 无远端 ref）。E2E 四特性
  全过、console 全程零错误：2.1 右键 now/25 闭包收缩 1477 提交/26 泳道 →
  503/2（选择集恰为 target∪main）、面板 Disabled(974) 出现、All 复原；
  2.2 本月 1477 → 26（fixture 时间分布所致：1451 条挤在 2025-07-24 的
  500 秒内、400 天空洞、26 条同刻锚点——不是"数百级"但语义正确）、
  自定义 2025-07-24 当日 1451 条、锚点日 From=To 当日 26 条（+86399 全天
  含端在 E2E 实证，旧 UTC 零点 end 会得 0）；2.3 origin badge/tooltip/
  详情三层随 Remotes 开关 0↔1 同步、gtv_hide_remotes 持久化往返；2.4
  小选择集（None+3 chips）刷新重开恰好一次 filter_by_branches(3 names)
  重建（invoke 日志实证）、全选保存 976 重开零重建无闪动。附带收获：
  None 空视图态首次在浏览器可达（旧 mock 恒返全量把该路径掩埋）——
  0 提交渲染无错。
- Task 6 遗留（上报 orchestrator，未擅改 Task 4/5 接线）：日期窗口激活时
  面板分组不随 rangeDead 重分类——画布沉痕行（Archived 500/Dormant
  450）而面板仍 Enabled (976)/"976 refs (976 shown)"。根因：dead 并集
  （inactive.dead ∪ rangeDead）只喂 collapseLanes，面板分组的
  allDeadNames 读 inactive.groups，看不到 rangeDead。且 emptyLaneDead
  不认 expandedDead——对窗口清空的泳道，"展开"痕迹 chip 本就是空操作，
  疑为 Task 5 有意留出的接缝（其评审放行该 memo 结构）；是否将窗口清空
  泳道挪进面板 Archived/Dormant 组属 Task 4/5 语义裁决，本任务不越权。
- 终审（CHANGES_REQUESTED，`.superpowers/sdd/final-review-m2.md`）+ 修复
  波（单 commit）：C1——'all' 下 emptyLaneDead 仍运行并进 dead 并集，
  真实仓库的 ref-only/stale 空泳道被无条件击沉且不可恢复（mock 实测 0 条
  此类泳道，E2E 全盲）；修法为 rangeEmpty memo 加 `kind !== 'all'` 守卫，
  'all' 下 dead = inactive.dead 与 arc 前逐字节一致。I1——上条遗留的正式
  裁决落地：emptyLaneDead 改返回 InactiveInfo 形状并感知 expandedDead，
  App 新增 mergedGroups 喂全部五个消费点。I2——handleOpenRepo 换仓瞬间
  保存 effect 以（新路径, 旧仓选择集）触发一次写（setLatestRepo 与
  全集/恢复 set 之间隔 await getBranchList()，即批处理边界），同批
  setSelectedBranches([]) 让空守卫跳过瞬态写。顺手修 Minor 1（tag 泳道
  菜单隐藏 relatedOnly）、2b（开仓清空 custom 日期串）、3（saveSelection
  吞错路径 throwing-stub 测试）、N1（persist 注释纠偏，防据旧注释"修复"
  App 空守卫）。mock 注入 synthetic/ref-only 钉子泳道（ref 挂他人泳道
  可见提交、自身零自有提交）+ synthetic/tag（fixture 无 tag 泳道，菜单
  回归无物可右键，同法合成）。E2E：'all' 下钉子以常规 lane-chip 呈现
  （非痕迹行，Archived 500/Dormant 450 均不含它）；本月视图面板
  Archived(500)/Dormant(451)、Enabled 976→27、header chips 无窗外泳道、
  点钉子 chip 即回画布空行（痕迹 Dormant 451→450、面板仍列且打勾）、
  组展开 500 全覆盖（rail 28→528）再收起复原；回 'all' Dormant 回 450、
  钉子回 Enabled(28)；tag 菜单 3 项（relatedOnly 消失）、普通菜单仍
  4 项、Remotes 往返 badge 1↔0；全程 console 零错误。

## Decisions

- 反向 merge（被并入 target 的分支算血缘）**只对 target 泳道判定**，单跳
  不传递：并入祖先（含 main）或子孙的分支不进闭包。理由：真实仓库几乎所有
  merged_into 都指向 main，而 main 几乎总在闭包里，祖先级反扫等于全仓收录
  （review Minor #3 的爆炸半径论证）；与兄弟 fork 排除同一原则——共享基座的
  其他故事不属于受检分支。正向 mergeTarget 仍是 core 内每条泳道单跳（收
  闭包成员的去向），merge 边永不链式传递。
- 面板镜像走 emptyLaneDead 返回 InactiveInfo 形状：dead 排除
  expandedDead（chip 展开即让泳道以空行回画布），groups 保留全部
  range-dead 泳道**含展开成员**（面板打勾）——与 computeInactive 的展开
  语义（inactive.ts:112-116）对齐。App 侧 mergedGroups 按名去重是必须的：
  同一泳道可同时在两个 map（自有提交全落窗外 AND 时效判死），两者分类是
  同一三元式（merged_into ? archived : dormant），先见者胜。排序只在显示
  层做（byActivity 依赖 refActivity，声明在后，TDZ 铁律）。
- 'all' 守卫（C1）：emptyLaneDead 只在日期窗口激活时运行。真实仓库存在
  无自有提交的非 tag 泳道（release/v1.x 式 ref-only 泳道、全史在加载窗外
  的 stale 泳道），'all' 下击沉即不可恢复——沉入痕迹行却无 bar（无跨度）、
  面板无 chip，重走 filterByBranches 重建后同样被再击沉；违反 arc 不变量
  2（'all' 必须与 arc 前逐字节一致）。
- 换仓 setSelectedBranches([])（I2）：setLatestRepo(新路径) 先于
  await getBranchList() 落帧，保存 effect 会以（新路径, 旧仓策展集）写
  一次——跨仓覆灭新仓的持久化集，随后的恢复读到的是被覆写后的 key。换
  key 同批清空选择让空守卫跳过瞬态写；handleOpenLatestRepo 无此窗口
  （latestRepo 不变），不改。

## Lessons

- 预裁定修法草图要经得起消费点全量扫描：I1 草图漏了 expandTraceGroup/
  traceGroupLabel（grep 旧数据源的全部消费者，不止显眼的那几处），"两个
  dead map 天然近乎不相交"的括注凭直觉下断言——自有提交全落窗外的泳道
  同时在两 map，分类还是同一三元式，去重是必须的。终审两处纠偏都对。
- C1 的 mock 盲区：fixture 恰好 0 条"无自有提交泳道"，默认路径的行为偏
  离全程 E2E 不可见。"基线态与 arc 前逐字节一致"这类不变量不能靠 fixture
  运气，要在接线点用守卫显式保证，并在 fixture 里合成对抗形态（ref-only
  钉子泳道）让它可被测到。
- React 批处理边界即持久化脏写窗口：persisted key 的 setState 与新值的
  setState 之间隔着 await，effect 就可能以（新 key, 旧 value）触发一次写。
  换 key 的同一批里清空值，让守卫跳过瞬态写。
- 简报里的 E2E 期望值要回查 fixture 真态再落笔：本 arc 两次翻车——"数百级"
  （实际 26，时间分布所致）与"'all' 下面板回 Enabled(976)"（'all' 下时效
  组本就存在，Enabled 实为 28）。期望值写错会把正确的实现误判为失败。

## Related

- 核心改动：`src/related.ts`（血缘闭包）、`src/daterange.ts`
  （applyDateRange/emptyLaneDead/outOfRangeIds）、`src/refs.ts`
  （filterRefs）、`src/persist.ts`（选择集持久化）、`src/App.tsx`（管道
  重排 + 面板镜像 + 右键/恢复接线）、`src/components/Timeline.tsx`
  （lane-menu 第四项 + badge 过滤）、`src/components/CommitDetails.tsx`、
  `src/locate.ts`（matchLoaded 第 4 参）、`src/settings.tsx`
  （hideRemotes + 11 个 i18n 键）、`src/App.css`、`mock.html`
- 测试：`src/related.test.ts`（11）、`src/daterange.test.ts`（10）、
  `src/refs.test.ts`（2）、`src/persist.test.ts`（12），前端合计 65；
  设计文档 `docs/superpowers/specs/2026-08-29-m2-filter-system-design.md`

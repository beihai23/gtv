# gmaster / Branch Explorer 资料收集

> 收集时间：2026-08-17（第一轮）；2026-08-18（第二轮：Wayback 恢复，官网快照入库）。
> 用途：作为 gtv 重设计的参照系。
> 官网存档索引见 `docs/reference/gmaster-io/README.md`（页面 HTML + 高清截图 +
> 8 集 tour 视频清单均已本地化）。

## 1. 产品背景

- gmaster 由 Codice Software（Plastic SCM 开发商）出品，定位是"尽可能视觉化、而不是
  命令行的 GUI 包装器"的 Git 客户端。
- ~~版本停在 0.9.x beta，从未发布 1.0~~ **修正（2026-08-18，据官网 releasenotes
  快照）**：gmaster 发布过 1.0——1.0.663 于 2020-10-14 发布；Unity 于 2020 年 8 月
  收购 Codice 后更新停滞， Plastic SCM 演变为 Unity Version Control（UVCS），
  Branch Explorer 在其中延续至今。gmaster 本体已无官方下载渠道。
- 三大支柱（官方自述）：视觉化（Branch Explorer 总览 + 可视化 diff/merge）、完整性
  （内置 side-by-side diff 与三路 merge）、语义化（解析 C#/Java/C/C++ 等代码结构做
  diff/merge）。对 gtv 有参考价值的是第一根支柱。

来源：
- https://livablesoftware.com/tools-to-visualize-the-history-of-a-git-repository （Jordi Cabot，2020-11-18）
- https://marketplace.visualstudio.com/items?itemName=CodiceSoftware.gmaster （VS 市场页）
- https://www.jb51.net/softs/616562.html （0.9.524 beta 安装包信息页）

## 2. Branch Explorer 的确认特征

以下特征均可从现存资料（UVCS 官方文档、Unity Learn 官方教程、Plastic SCM 发布说明、
用户讨论帖）交叉确认，是"这个流派"的既定设计词汇：

### 2.1 布局隐喻：黑板 + 生命轨迹

- 横向时间轴，x 轴是真实时间；仓库从左向右展开。
- **每个分支一条独立的横向轨迹**。分支不只是节点颜色——节点背后有一条贯穿的"分支横杠"
  （bar），选中这条横杠即选中整个分支，可直接对其执行 merge。
  来源：Unity Learn 官方教程 "select the bar behind the changeset nodes of the
  branch — this bar represents the entire branch"。
- 分支在 fork 点"出生"（分叉线出生），在 merge 点"收拢"（merge link 曲线汇合）。
  merge link 是一等公民图形元素，有右键菜单（Go to source/destination changeset）。
  来源：UVCS 5.x 发布说明（2016-11）。

### 2.2 节点编码

- 变更量大的提交一眼可辨："helps identify the commits with more changes at a glance"
  （节点大小/视觉权重编码变更量）。
- 分支/标签/changeset 均有富 tooltip，tooltip 里的链接可直接打开对应 diff。
  来源：UVCS 11.0.16.7608 发布说明。
- 当前工作区位置在图上有"家"图标（home icon）标记。
  来源：Unity Learn 教程。

### 2.3 视图控制

- 显示选项：可分别隐藏分支、changesets、标签、merge links；分支名可全显/截断。
- 日期过滤：可编辑起止日期，只显示该区间。
- 过滤器面板：按日期、分支、用户过滤，支持保存的过滤条件和自定义查询（后续推广到
  branches/changesets/labels 等所有视图）。
- 导航面板（navigation panel）：一次平移两个视口宽度，快速穿越大历史。
- 多选 + 搜索联动：搜索定位一个 changeset 后 Ctrl+点击另一个，做 "diff selected
  changesets"。
  来源：UVCS 5.4.16.791 / 11.x 发布说明、UVA 学位论文（TFG-G2250，Spanish，含移动版
  Branch Explorer 设计章节，是少见的对桌面版交互的系统梳理）。

### 2.4 设计哲学

- Branch Explorer 是 Plastic SCM 的"中心视图"：不是只读历史浏览，而是操作入口——
  checkout、diff、merge、从标签建分支都从这里发起。
- 它服务于"branch per task"方法论：每个任务一条短生命周期分支，完成后合回主线。
  泳道图的信息密度假设就是"大量短命分支"，而不是"几条长命分支"。

## 3. 对 gtv 的直接映射

| Branch Explorer 特征 | gtv 现状 | 差距 |
|---|---|---|
| 分支完整血缘留在自己泳道 | `i % num_lanes` 轮询占位（git_reader.rs:344-358） | **核心差距**，需泳道传播算法 |
| fork 点分叉线 + 出生标注 | `EdgeType::Branch` 从未产生；`fork_branch_name` 从未赋值 | 算法副产物，顺带可填 |
| merge link 曲线 + 汇合标注 | `EdgeType::Merge` 已有；`merge_branch_name` 从未赋值 | 同上 |
| 变更量一眼可辨 | `additions/deletions` 恒为 0，节点等大同色 | 需 diff stats + 节点大小编码 |
| x 轴真实时间比例 | `索引 × 80px` 均匀间距 | 改时间比例 + 最小间距 |
| 标签不占泳道、作为节点徽标 | 每个 tag 一条泳道 | 布局瘦身 |
| home 图标（当前位置） | 无 HEAD 标记 | 小功能 |
| 显示选项 / 日期过滤 / 导航面板 | 仅缩放平移 | 增量功能 |

## 4. 关键工程差异（为什么 git 比 Plastic 难做这件事）

Plastic SCM 服务端原生记录分支的创建/合并元数据，Branch Explorer 直接读元数据画图。
git 的分支只是移动指针，fork/merge 关系必须从图结构推导：
- 用 **first-parent 链**归属主线提交（merge 提交的第一父是"主线方向"）；
- 分支泳道 = 从该分支 tip 沿 first-parent 回溯、尚未被更高优先级泳道认领的提交段；
- fork 点 = 回溯撞上已认领提交的位置；merge 点 = merge 提交的第二父所在泳道。
这套推导是 gtv 重设计的技术核心，详见 design-v2.md 第 3 节。

## 5. 视频一手资料（2026-08-17 用户提供截图与要点）

视频："gmaster features - Branch Explorer"，YouTube 官方频道 @gmaster301，全长 1:14。
截图存档：`docs/assets/gmaster-be-overview.png`（0:03 全景）、
`docs/assets/gmaster-be-sidepanel.png`（0:21 选中提交后的右侧面板）、
`docs/assets/gmaster-be-compression-head.png`（压缩视图 + HEAD 标记）。

### 5.1 过滤系统（视频 0:32-1:11 明确演示的三层）

1. **智能节点压缩（0:32-0:48）**：默认自动压缩图形，隐藏非关键提交，只保留四类节点：
   - 分支的起始位置（Beginning / fork 点）
   - 分支的头部（Head / tip）
   - merge 的源头与目标（Source / Destination）
   - 带标签（Tag）的提交
   被压缩掉的提交段收缩成泳道横杠上的直线段。**这是 gmaster 处理"信息密度"的核心
   手段**——它默认不展示全部提交，这一点修正了本研究早先"泳道 = 完整血缘铺开"
   的假设。
2. **关联分支过滤（0:56-1:07）**：右键分支 → "Show selected and related branches"，
   只保留选中分支及其血缘相关分支（父泳道链 + 子泳道），无关路径整体隐藏。
3. **日期过滤（1:09-1:11）**：顶栏有日期范围选择器（截图中为
   "last 2 years (07/09/2015)" 下拉），按时间窗口筛选。

### 5.2 截图确认的图形词汇

- **节点字形**：圆形内嵌一条水平短杠（⊖ 形）；分支 head 节点有独特内图标（截图中
  紫分支 head 为实心圆点图标）；部分节点下半圆填充颜色（推测编码某种状态，待考）。
- **HEAD**：绿色 "HEAD" 文字标签 + 家形图标节点（compression-head 图中央）。
- **分支名标签**：彩色圆角矩形，出现在泳道右端/head 附近；同一泳道多个引用时
  **垂直堆叠**（如 origin/master 在上、master 在下两个蓝色标签）。
- **fork 线**：从父泳道节点向下 90° 垂落后水平延伸到子泳道首节点（直角折线风格，
  不是贝塞尔曲线）；**merge 线**：细浅色曲线从子泳道 tip 斜向上汇入主线 merge 节点。
- **面板布局**：左侧深蓝导航栏（Repositories / Commit / Branch Explorer /
  Open in Explorer）；顶部 repo 标签页 + Filters 按钮 + 分支 chips + 日期范围选择器；
  顶部时间标尺（如 "12/30/2016 … 12/31/2016"）。
- **选中提交**：右侧 Commit properties 面板（头像、SHA、日期、作者邮箱、comment）
  + Changed files 列表（带 +/- 数字）+ 底部 diff 区（含 Semantic Outline、
  Text diff / Semantic diff 切换）——查看详情是**内嵌三栏联动**，不是弹窗。
- 顶栏状态信息：当前提交 hash（绿色 "d6975e7 (detached)" 徽章）、内存占用等。

## 5.3 官方 tour 演示仓库（2026-08-17 从 fork 网络抢救）

原仓库 github.com/gmasterscm/tour（描述："A quick tour on the key gmaster
features. Just download this repo and open it with gmaster to see how it works"）
内容已被删除，但 fork 网络中存在完整副本（shops-myshopify-com/tour，
pushed_at 与原仓库最后推送一致：2019-10-25），已克隆存档至
`docs/reference/gmaster-tour/`。

**这是 gmaster 官方为演示 Branch Explorer 精心构造的仓库，也是视频里那个图的真身**
（视频中的 "nodatime" 标签页、红色 "Moved Method" 分支标签均与此仓库吻合）。
14 个提交、master + 6 条分支、无 tag，提交信息直接写着意图
（"Merge to master, to create a beautiful Branch Explorer"）：

```
master:               4a83ed3 → 6d3b429 → 9693351(merge) → 5f36bee(merge) → 2ae6485(tip)
ImageDiff:            从 4a83ed3 分出 → e3d7642，合并于 9693351      ✓ 已合并
Xdiff:                从 4a83ed3 分出 → 0b9acdc → 914dbf0，被 9693351 一并合并
MoveMethod:           从 Xdiff 线分出 → 5a91a10 → acf2461，合并于 5f36bee  ✓ 已合并（分支套分支）
MoveToDifferentFile:  从 master 分出 → dbefb6e                        ✗ 未合并
ChangeGetTimeBetween: 从 master 分出 → 3c6330a → bc3d3b4              ✗ 未合并
ChangeImagenDst:      从根部分出 → 98a31d9（art/ 图片，演示 ImageDiff）✗ 未合并
```

对 gtv 的价值：**ground-truth 测试基准**。同一个仓库，gmaster 的渲染结果就在视频
截图里——gtv 的泳道算法跑在这个 repo 上，输出应与截图逐节点比对一致。
它天然覆盖设计文档 §3.5 的多个边界：已合并/未合并分支、分支套分支、跨分支 merge。

注：仓库里 art/ 目录是 IronMan 战甲图片（演示语义 ImageDiff 用），Fields/ 与
Period.cs 取自 nodatime 项目，代码移动/改名历史是为演示 Semantic Diff/Merge
构造的——对 gtv 的时间线可视化无直接关系，但可作为 CommitDetails 文件变更
（含 R 状态 rename）的测试素材。

## 6. Wayback 官网快照（2026-08-18 补齐）

官网快照与图片已全部入库：`docs/reference/gmaster-io/`（索引见该目录 README）。
新增确认点：

- **过滤栏形态**（branch-explorer-full.png）：`only relevant ✓`（智能压缩开关）、
  `remotes ✓`（远程引用开关）、日期范围下拉（"last 2 years"）、Search 框——
  与视频三层过滤互证，且给出控件级参照。
- **泳道双线绘制**：分支横杠是两条平行细线（非单线），未激活段虚线；节点为大
  空心圆。gtv 目前是单虚线 + 实心圆点，视觉密度可再向原作靠。
- **吸顶时间标尺**：官网截图确认日期标尺固定在视口顶缘——gtv 已实现同款
  （commit 2e8316d）。
- **分支右键菜单全量项**：建分支/merge/checkout/fetch/pull/push/filter/rename/
  delete——Branch Explorer 是操作入口而非只读视图，印证 §2.4。
- **tour 视频清单核实**：8 集标题经 YouTube oEmbed 确认，Branch Explorer 为第 3 集
  （KHb2ZF402CY），其余 7 集均为 diff/merge/语义化主题——可视化历史只是 gmaster
  三分之一支柱，但是官网首屏卖点。

遗留：StackOverflow Q45573184 正文仍未取到（价值低，仅作历史佐证）；节点"下半圆
填色"语义仍未确认（在 branch-explorer-full.png 中同样可见，疑为"该提交有未推送/
已推送状态"或压缩占位，待视频逐帧确认）。

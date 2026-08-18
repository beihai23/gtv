# gmaster.io Wayback Machine 存档

> 收集时间：2026-08-18。来源：web.archive.org 对 gmaster.io / blog.gmaster.io 的快照。
> 用途：gtv 重设计的一手参照（gmaster 官网已下线，此为官方资料的本地副本）。

## pages/ — 页面快照（原始 HTML，含 Wayback 注入的 toolbar 代码）

| 文件 | 原始 URL | 快照时间 | 内容 |
|---|---|---|---|
| `tour.html` | gmaster.io/tour | 2018-10-15 | 8 集功能视频 tour（见下） |
| `index-2020.html` | gmaster.io/ | 2020-08-17 | 首页：功能清单、与 Tower/GitKraken 的对比表 |
| `features-2019.html` | gmaster.io/Features | 2019-11-11 | 功能页：Branch Explorer 定位的官方表述 |
| `releasenotes-2021.html` | gmaster.io/releasenotes | 2021-08-01 | 版本史：**1.0.663，2020-10-14 发布** |
| `releasenotes-1.0.663.0.html` | gmaster.io/releasenotes/1.0.663.0/0 | 2021-10-16 | 1.0.663 详情（Excel 外部 diff） |
| `pricing-2019.html` | gmaster.io/pricing | 2019-12-14 | 定价页 |

## images/ — 图片资产

| 文件 | 说明 |
|---|---|
| `branch-explorer-full.png` | **Branch Explorer 全界面截图（1306×676，2021 快照）**——含过滤器栏、右键菜单、双线泳道，详见下方解读 |
| `screenshot-dark-theme.png` | 深色主题整窗截图（1549×877） |
| `hero-2017.png` | 2017 年首版 hero 图（1267×600，早期 UI 形态） |
| `merge.png` | 三路 merge 界面（1890×1617） |
| `tour-*.png`（8 张） | tour 页 8 集视频缩略图（574×266） |
| `logo-gmaster-dark.svg` | 官方 logo |

## Tour 八集视频（标题经 YouTube oEmbed 核实，2026-08-18）

| # | 主题 | 时长 | YouTube ID |
|---|---|---|---|
| 1 | Commit view | 0:44 | `Cz_h_32HKqI` |
| 2 | Semantic commit view | 0:26 | `2uhbx5UnQlE` |
| 3 | **Branch Explorer** | 1:15 | `KHb2ZF402CY` |
| 4 | Image diff | 0:31 | `7BGPrP09yeQ` |
| 5 | Side-by-side diff | 1:14 | `FfpA1jwsQaM` |
| 6 | Semantic diff | 1:15 | `gYBU4X7yi2s` |
| 7 | Refactor detection | 1:29 | `5Omvx5PQ5kk` |
| 8 | Multifile semantic merge | 3:01 | `n5cnpyjRerQ` |

频道：YouTube `@gmaster`（UCrgVxeJagC6852-9fKEtgIQ）。与 gtv 直接相关的只有第 3 集。

## branch-explorer-full.png 界面解读（对 gtv 最重要的一张图）

- **顶部过滤栏**：`Filters: [only relevant ✓] [remotes ✓] [last 2 years (01/11/2017) ▾]` +
  右侧 Search 框——"only relevant" 即智能压缩的开关形态，"remotes" 是远程引用开关，
  日期范围是下拉预设。
- **时间标尺吸顶**：日期（10/8/2018 … 1/11/2019）固定在视口顶缘，不随垂直滚动离开。
- **泳道绘制**：分支泳道是**双线横杠**（两条平行细线），未激活段为虚线双线；
  节点为大空心圆，部分节点下半圆填色（如 master 泳道 12/21 处两枚）。
- **HEAD**：家形图标节点（🏠），位于 master 泳道最右。
- **分支标签**：彩色 pill 置于泳道线上方、tip 附近；本地+远程同名时垂直堆叠
  （origin/master 在上、master 在下）。
- **右键菜单**（泳道/分支级）：Create branch from head commit… / Merge from this
  branch… / Checkout this branch / Fetch this branch / Pull this branch /
  Push this branch / Fetch all / Filter ▸ / Rename this branch / Delete this branch。
- **右缘浮动按钮**：home（回到 HEAD）、＋、－（缩放）。

## 官网自述中的关键表述（features-2019 / index-2020）

- "Use the Branch Explorer to navigate your repository, **left to right, as you would
  do in a blackboard**. Checkout branches, diff and merge from here. And, **identify
  the commits with more changes at a glance** too."
- "Most tools are just a wrapper around the command line. We take a visual approach
  instead: Branch Explorer as a comprehensive repo visualization…"
- 对比表自嘲竞争对手："Eats all RAM thanks to Electron"（指 GitKraken 一类）——
  gtv 选 Tauri 而非 Electron，与这个价值取向一致。
- 版本史修正：gmaster **发布过 1.0**（1.0.663，2020-10-14），并非停在 0.9.x；
  Unity 2020 年 8 月收购 Codice 后，gmaster 更新停滞，Plastic SCM 演变为 UVCS。

---
arc: head-home-shortcut
started: c616820812955a96ee073a9ff586b7fd4b8bc38c
status: resolved
commits: [fa6b5f7]
---

# 回到 HEAD：快捷键 + 按钮，帝国时代的「回家」体验

## Intent

用户要求：应用内加快捷键快速定位回 HEAD 所在位置，界面加一个按钮，
体验对标《帝国时代》按 H 回城镇中心——镜头直接 snap 过去（不滑行）、
落点闪「你在这里」的选中环、小地图 ping 一下。

## Process

- 体验基准逐条对应 AoE：镜头瞬移（不做 250ms 滑行，AoE 的 H 是瞬时
  snap）；落点 HEAD 节点闪双脉冲环（一个像噪音，两个才像 flare，颜色用
  既有的「你在这里」绿 `--head-lane-rgb`，与 HEAD ring/小地图点/泳道带
  同一语义）；小地图以落点为圆心扩一个渐隐 ping（AoE 小地图 flare）。
- 位置语义取舍：AoE 的 H 会「选中」城镇中心；gtv 里对应动作是打开
  Commit 详情面板——那是用户自己的状态，不该被导航键改写。故只动镜头
  + 反馈，不动 selectedCommit。
- 缩放规则沿用搜索跳转的先例：`k = max(当前k, 1)`——从缩略图状态回
  家时至少 1x 保证落点上下文可读；用户刻意放大过则保留其缩放（纯
  平移，AoE 语义）。
- 复用既有机制：signal-increment 模式（fitSignal 同款）；镜头数学与
  focusCommit 相同（zoomIdentity.translate 居中）；脉冲/ ping 挂在
  svg 根/小地图根上用屏幕坐标（在 zoom 组外，snap 不拖动它们），
  d3 transition 结束自动 remove，下次 draw 全清。
- 快捷键 H：无修饰键（Cmd+H 是 macOS 隐藏窗口，Ctrl+H 是部分编辑器
  的历史）；INPUT/TEXTAREA bail——定位框里打字不跳，终端 xterm 持有
  TEXTAREA，发给 shell 的 h 不会触发镜头。Active tab only（keep-alive
  多标签互不串扰），与既有 Esc/箭头键处理器同一套守卫风格。
- 按钮：放在 header 右侧「适配」旁边（定位对 orientation pair），文案
  `⌖ HEAD`，tooltip 带快捷键提示；i18n en/zh 各两条。

## Decisions

- 不选中、只定位：导航键不改写用户的选择状态（与 AoE 的差异点，理由如上）。
- 瞬移不滑行：忠实 AoE；脉冲与 ping 承担反馈。
- H 无修饰键 + 输入焦点守卫：与既有快捷键互不冲突，终端/输入框安全。

## Lessons

- 「像某款游戏的体验」要拆成可实现的感官清单（镜头行为/反馈动画/声音），
  逐条决定忠实还是适配本地语义——本项目里「选中 TC」被适配为「不改详情面板」。
- svg 根上挂临时动画元素 + transition 自移除，是 d3 画布里做一次性
  特效的最低摩擦路径；坐标必须手动过 zoom transform（在 zoom 组外）。

## Related

- `src/components/Timeline.tsx`（headSignal effect：snap + 双脉冲 + ping）
- `src/RepoView.tsx`（headSignal 状态、H 键监听、⌖ HEAD 按钮）
- `src/settings.tsx`（headHome / headHomeTip 双语词条）
- 姊妹 arc：transfi-lane-misattribution（同一批部署）

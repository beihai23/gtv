---
arc: graph-locate-and-select
started: 5f57aa6
status: resolved
commits: [848bbcd]
---

# 图内搜索定位、方向键导航与选中高亮

## Intent

三个连续的图交互需求：(1) 图内支持按 commit hash / 分支名搜索定位；(2) 选中
commit（右侧详情面板打开）后用 ←/→ 切换上一个/下一个；(3) 选中高亮和背景的
反差不够。

## Process

- 搜索框最初放在 header 工具栏，用户要求改为 Cmd+F 呼出的主图浮窗。最终形态：
  顶部居中浮窗（`.locate-float`），Cmd/Ctrl+F 开关、自动聚焦、Esc 关闭、
  选中结果后自动关闭。
- 匹配规则：分支名子串匹配（车道名 + commit 上的 branch ref，不含 tag），优先
  跳到 ref 实际指向的 commit，否则跳到车道在视图内的最新 commit；hash 前缀匹配
  要求 ≥4 位 hex 才触发，避免输入噪声。只搜当前已加载范围，`has_more` 时下拉
  底部有提示。
- 定位机制：App 给 Timeline 传 `focusCommit: {id, seq}`（seq 递增触发，仿照
  fitSignal 模式）。Timeline 的 effect 负责居中（概览缩放下自动提到 ≥1x 保证
  可读）；**跳到压缩模式下隐藏的非 key commit 时自动展开其车道**——x/y 由后端
  布局决定、展开不变，所以先居中再重绘坐标依然正确。
- 方向键导航：沿同一车道按索引 ±1（commits 已是时间+拓扑升序 = 视觉左→右）。
  焦点在 INPUT/TEXTAREA（如搜索浮窗）时不劫持左右键。
- 选中高亮：原来是节点上的白色 3px 描边——浅色主题白底不可见、浅色车道上也
  洗白。改为主题 accent 色双层光环（r+4 实心环 + r+8 的 30% 透明度光晕），
  5 套预设主题的 accent 都是红/品红系，与车道色和深浅背景均有反差。
- 验证方法复用既有流程：mock.html + playwright。注意 mock 的 `get_commit_detail`
  返回 null，验证选中态需临时 patch 返回最小对象（用完恢复）；端口 1420 的
  vite 有时是用户自己的 dev server，启动前先 curl 探测，是用户的就不要动。
- 调试插曲：截图定位选中节点时一度以为居中偏了 188px，实际是右侧详情面板
  占位使 timeline 容器比窗口窄——节点本来就居中于"容器"而非窗口，虚惊。

## Decisions

- 方向键的"上一个/下一个"定义为同车道视觉邻居（= first-parent 链方向），
  而非全局时间序：与图的视觉左右一致，跨车道跳转用搜索或点击。
- 搜索不搜未加载的历史（分页之外）：保持前端纯客户端匹配，零后端改动；
  范围限制用下拉提示显式告知。

## Lessons

- Timeline 的外部触发信号统一用"递增计数器 prop + ref 去重"模式（fitSignal、
  focusCommit 都是），避免布尔 prop 的重复触发问题。
- mock.html 的 invoke mock 是按 cmd 名硬编码的，新验证场景需要哪个命令就临时
  补哪个，验证完务必恢复 mock.html 和 public/mock-data.json。

## Related

- `src/App.tsx`（搜索状态/匹配/浮窗/方向键）、`src/components/Timeline.tsx`
  （focusCommit effect、选中光环）、`src/settings.tsx`（locate* 词条）、`src/App.css`
- 姊妹 arc: docs/work-backstory/same-second-topo-order.md

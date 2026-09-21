---
arc: minimap-viewport-rect-vanish
started: f5be16b
status: resolved
commits: []
---

# 修复小地图视口框在容器瞬态 0 尺寸 draw 后永久消失

## Intent

用户报告：小地图（minimap）里的视口框（`.mm-viewport`，"你在这里"的蓝框）不见了，
而小地图的其余内容（lane bar、关键 commit 点、月份标签、HEAD 点）全部正常。
截图来自 macOS Tauri 真机（WKWebView）、浅色主题、压缩模式（已折叠 24）、
深度缩放到最新提交端。

初始预期（应然）：视口框的位置数学有 tier-1 纯函数测试保证（≥6px 可见下限 +
钳位在框内），所以怀疑方向先是"某个交互把 rect 弄丢"。

## Process

- **纯数学层排除**：`minimap.ts` 的 `viewportRect` 对正窗口必然返回框内 ≥6px
  的矩形（minimap.test.ts + verify_tier1 覆盖）。rect 元素在 minimap 段落里
  创建时**不带任何几何属性**，属性只能由 draw 末尾的 `minimapViewport()` 写入
  ——所以"消失"只有三种可能：元素不存在（与月份标签同段渲染，标签在即排除）、
  draw 中途抛异常（逐行审计 zoom handler/cull/updateRuler 无 throw 点，排除）、
  **F2 零窗口守卫把属性写成 0×0**。
- **黑盒复现失败（教训堆）**：用 esbuild 把 src 打成静态 bundle + 页面内合成
  事件自驱动（无 CDP），跑了 open→深缩放→H 键→适配→minimap 拖拽→resize→
  压缩开关 全序列 + ~120 次随机 op，rect 每一步都健在。期间踩了四个坑：
  1. 企业终端管控（云枢）会**静默关闭 Chrome 的 DevTools 通道**——
     playwright 的 `--remote-debugging-pipe` 浏览器在启动后 ~5-9s 被杀
     （`<kill>` 日志），手起 9222 端口也被关。表现为"页面随机死亡"，与
     应用无关。放弃 CDP，改为页面自驱动 + `POST /report` 回传。
  2. wheel 监听注册在 `svgRef` 上而不是 containerRef 上，合成事件派发给
     container 无效——用 `svg.__zoom` 前后对照才定位。
  3. `build.mjs` 重新生成 index.html 时会冲掉手工注入的 selfdrive script
     标签，导致两次"无声无息"的空跑。
  4. `getBoundingClientRect().width` 被写成 `.w` 得到 NaN，第一版序列卡死。
- **像素取证**：对用户截图扫描 `#8ec6ff` 描边色与 16% 蓝色填充混色——
  只有主 lane 蓝条的抗锯齿边缘误报，背景纯白 (255,255,255)，排除"适配
  模式下 rect 覆盖全图"的退化形态，确认 rect 真不存在。
- **假设收敛**：rect 依赖的输入只有 (k, tx, ty, 容器宽高, 场景边界)。
  容器宽高在 draw 时捕获进闭包；**若某次 draw 在容器瞬态 0 尺寸时运行，
  F2 守卫把 rect 写成 0×0，且后续 pan/zoom 走的还是这个中毒闭包**，
  永不自愈——因为容器自身尺寸变化不触发 window resize，也没有任何
  dep 变化触发全量重绘。macOS WKWebView 在**窗口 live 拖拽期间会瞬时
  上报 0×0 clientWidth/Height**（WebKit 已知怪癖），resize 事件风暴里
  恰好夹一次 0 尺寸 draw 即中毒。主画布不受影响的原因：
  `.timeline-container > svg` 的 CSS 是 100%/100%（覆盖 0 尺寸 attr），
  场景内容用场景坐标绘制——只有 ruler 背板、lane band、cull 窗口和
  minimap rect 这些**依赖捕获宽高**的东西会静默坏掉。
- **端到端验证**：harness 里 `container.style.height='0px'` → 压缩开关
  触发 draw → 恢复容器 → pan/深缩放：修复前 rect 停在 0×0（与用户截图
  状态一致，mm 子元素 714 全程健在）；修复后恢复即自愈。
- **修复（Timeline.tsx 两处，最小化）**：
  1. `minimapViewport` 改读**实时** `containerRef.clientWidth/Height`
     （0 时回退捕获值，语义："量不到就用最后已知窗口"）；
  2. draw effect 之后挂一个 `ResizeObserver(container)` → 任何容器尺寸
     变化（含从 0 恢复）重跑 draw。`draw()` 只写被 CSS 覆盖的 svg
     width/height 属性，观察不到布局回流，无反馈环。
- **验证**：tsc 0 错；vitest 106/106；中毒序列自愈；健康全序列
  （深缩放/H/适配/minimap 拖拽/面板开合）无回归。

## Decisions

- **用 ResizeObserver 观察容器而不是只在 minimapViewport 里读实时尺寸**：
  后者只救 rect 本身，且若用户恢复尺寸后不再交互，框依旧缺席；前者把
  "容器尺寸变化 ⇒ 全量重绘"变成显式契约，一次修掉整类 stale-closure
  问题（ruler 背板、lane band、cull 窗口同病同源）。
- **F2 守卫保留原语义**（当前窗口 ≤0 ⇒ rect 0×0）：那一瞬确实没有可见
  窗口，0×0 是真实值；错的是"之后永远停在真实值上"。自愈交给 RO。
- **不在 RO 回调里做防抖**：窗口拖拽时的 window resize 路径本来就是
  每事件全量重绘，RO 保持同等成本，避免引入第二套节流节奏。

## Lessons

- **"CSS 撑住的 svg"会掩盖 0 尺寸 draw**：`.timeline-container > svg`
  的 100%/100% 让坏 draw 的主画布看起来一切正常，只有依赖捕获宽高的
  派生物（rect/背板/cull）暴露症状——定位时不能假设"主画布正常 ⇒
  上一次 draw 维度正常"。
- **keep-alive 多 tab 架构下，容器尺寸是独立于 window 的状态源**：
  window resize 监听只是容器尺寸变化的子集。凡是"draw 时捕获容器尺寸进
  闭包"的代码，都要么读实时值，要么订阅 ResizeObserver。
- **企业管控环境做浏览器自动化**：CDP（pipe/port 都算）随时被静默杀，
  症状是"页面随机消失"；可靠路径是静态 bundle + 页面内合成事件 +
  HTTP 回传，全程零调试协议。构建脚本会重写 index.html，注入的探针
  标签要写进构建脚本本身。

## Related

- 前置弧：`large-repo-pagination.md`（F2 守卫与 6px 下限的由来，
  commit f73cf3c / ae68a22）、`multi-repo-tabs.md`（keep-alive tab 与
  `active` 早退）。
- 本次改动：`src/components/Timeline.tsx`（minimapViewport 实时尺寸 +
  ResizeObserver effect）。
- 验证工具（repo 外）：`/Users/lance.wang/workspace/tmp/gtv-e2e/`
  （esbuild bundle + selfdrive harness + reports.log）。

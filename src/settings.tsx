import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Settings: language (zh/en) + preset themes, persisted in localStorage.
// One small context shared by every component; Timeline also reads the theme
// so the D3 canvas repaints structural colors on theme switch.
// ---------------------------------------------------------------------------

export type Lang = 'zh' | 'en';

const LANG_KEY = 'gtv_lang';
const THEME_KEY = 'gtv_theme';
const STALE_KEY = 'gtv_show_stale';
const HIDE_REMOTES_KEY = 'gtv_hide_remotes';
const INACTIVE_DAYS_KEY = 'gtv_inactive_days';
const AUTOFETCH_KEY = 'gtv_autofetch';

const en: Record<string, string> = {
  openRepo: 'Open Repository',
  repoOpenFailed: 'Failed to open repository',
  retry: 'Retry',
  loading: 'Loading...',
  commitCount: '{n} commits',
  branchCountTip: 'Full history reachable from this branch (not limited to the loaded window)',
  filterStatusCount: '{n} / {m} lanes',
  filterStatusTip: 'Showing {n} of {m} lanes. Click the count to open the picker; the x shows all lanes again.',
  filterStatusClear: 'Show all lanes',
  compress: 'Compress',
  compressTip: 'Smart compression: show only lane births, tips, merges, tags, HEAD',
  mergeLinks: 'Merge links',
  mergeLinksTip: 'Draw dashed links for merge commits',
  labels: 'Labels',
  labelsTip: 'Show branch/tag badges on the graph',
  copies: 'Copies',
  copiesLoading: 'Copies…',
  copiesTip: 'Detect cherry-picked / rebased commits (same patch, different commit)',
  fit: 'Fit',
  fitTip: 'Fit whole graph into view',
  headHome: 'HEAD',
  headHomeTip: 'Snap the view back to HEAD (H) — the Age of Empires "go home" key',
  filterRefs: 'Filter branches/tags...',
  filterShort: 'Filter ( / )',
  filterTip: 'Filter lanes (press /)',
  copyName: 'Copy name',
  copied: 'Copied {name}',
  copyRefFailed: 'Copy failed',
  locatePlaceholder: 'Search commits / branches / hash…',
  locateNoResults: 'No match',
  locateSearching: 'Searching full history…',
  locateHitsCapped: '{n}+ matches in full history',
  locateHint: '↑↓ / hover / click to preview · double-click or Enter to locate',
  tags: 'Tags',
  tagsTip: 'Show/hide tag chips (e.g. version tags)',
  zoneCandidates: 'Unselected ({n})',
  zoneSelected: 'Selected ({n})',
  zoneAllSelected: 'All selected',
  zoneNoneSelected: 'No refs selected',
  zoneSelectAll: 'Select all listed (respects the filter)',
  zoneClearAll: 'Clear all listed (respects the filter)',
  chipHint: 'click or drag to toggle · right-click copies',
  lanesOnCanvas: '{n} lanes shown',
  remotes: 'Remotes',
  remotesTip: 'Show/hide origin/* remote badges (lane labels stay)',
  dateAll: 'All time',
  dateWeek: 'Last week',
  dateMonth: 'This month',
  date3m: 'Last 3 months',
  dateYear: 'Last year',
  dateCustom: 'Custom',
  dateFrom: 'From',
  dateTo: 'To',
  onlyThis: 'Only this ref',
  pin: 'Pin this branch',
  unpin: 'Unpin',
  lensGroup: 'Lane lenses',
  lensRecent: 'Recent',
  lensRecentTip: 'Show only the 5 most recently active lanes (full history kept)',
  lensPinned: 'Pinned',
  lensPinnedTip: 'Show only pinned branches',
  lensAll: 'All',
  lensAllTip: 'Show every lane',
  noRefsMatch: 'No refs match the filter',
  close: 'Close',
  closeTab: 'Close tab',
  switchWorktree: 'Switch worktree member',
  checkedOutIn: 'Checked out in worktree {name}',
  mainWorktree: 'Main worktree',
  linkedWorktree: 'Linked worktree',
  worktrees: 'Worktrees',
  jumpToHead: 'Jump to HEAD',
  cancel: 'Cancel',
  panelFooter: 'Right-zone chips keep their lanes on the canvas. Hover a chip for pin / "only this"; right-click copies. Archived/Dormant rows toggle lane visibility.',
  welcomeTitle: 'Welcome to Git Timeline Viewer',
  welcomeSubtitle: 'Click "Open Repository" to select a Git repository',
  welcomeHint: 'Only reads data - no modifications will be made',
  welcomeDropHint: 'Or drop a repository folder anywhere in the window',
  dropToOpen: 'Release to open repository',
  focusLane: 'Focus this lane',
  unfocusLane: 'Unfocus lane',
  expandAll: 'Expand all commits',
  viewFromBranch: 'View from this branch',
  relatedOnly: 'Only related branches',
  edgeTip: 'Click: highlight endpoints\nCtrl+Click: go to parent\nShift+Click: go to child',
  details: 'Commit Details',
  hash: 'Hash:',
  author: 'Author:',
  email: 'Email:',
  date: 'Date:',
  branches: 'Branches:',
  message: 'Message:',
  changedFiles: 'Changed Files ({n})',
  loadingDiff: 'Loading diff…',
  agoSeconds: '{n} seconds ago',
  agoMinutes: '{n} minutes ago',
  agoHours: '{n} hours ago',
  agoDays: '{n} days ago',
  agoMonths: '{n} months ago',
  agoYears: '{n} years ago',
  settings: 'Settings',
  viewOptions: 'View',
  terminal: 'Terminal',
  terminalTip: 'Toggle integrated terminal (Ctrl+`)',
  terminalRestart: 'Restart',
  terminalRestartTip: 'Restart the shell in the currently open repository',
  terminalExited: 'Shell session ended',
  language: 'Language',
  theme: 'Theme',
  about: 'About',
  version: 'Version',
  aboutAuthor: 'Author',
  viewSource: 'Source on GitHub',
  themeMidnight: 'Midnight',
  themeNord: 'Nord',
  themeDracula: 'Dracula',
  themeSolarized: 'Solarized Dark',
  themeGithubLight: 'GitHub Light',
  reportIssue: 'Report Issue',
  issueContextNote: 'Please review the context below before sending — logs may contain local file paths or other private information. Feel free to edit or delete anything sensitive, then copy.',
  copyContext: 'Copy',
  copyAndReport: 'Copy & Open Issue Page',
  copiedTip: 'Context copied to clipboard — opening the issue page, paste there directly.',
  copyFailed: 'Copy failed — select the text and copy manually.',
  showStale: 'Show stale branches',
  showStaleTip: 'Process and show branches whose tip lies outside the loaded history window. Turn off to reduce work on huge repos.',
  autoFetch: 'Auto-fetch active tab',
  autoFetchTip: 'Fetch the active tab\'s remotes every 60s in the background (writes refs/remotes and objects only)',
  collapseInactive: 'Collapse inactive lanes',
  collapseInactiveTip: 'Lanes with no activity for this long collapse out of the graph into sediment rows: merged ones under "Archived", never-merged ones under "Dormant". Base branches like main/dev/uat and ancestors of active lanes always stay.',
  inactiveOff: 'Off',
  daysUnit: '{n}d',
  archivedLanes: 'Archived ({n})',
  dormantLanes: 'Dormant ({n})',
  expandGroup: 'Expand',
  collapseGroup: 'Collapse',
  loadingOlder: 'Loading older history…',
  checkoutThisBranch: 'Check out this branch',
  confirmCheckoutTitle: 'Switch branch?',
  // Three-state body copy (final review L1): "0 modified, N untracked"
  // reads badly for untracked-only users, and for them the carry note is
  // the wrong promise -- untracked files are NOT carried, they simply stay
  // untracked. Only the untracked-only key needs to say where files go.
  confirmCheckoutBodyBoth: '{modified} modified, {untracked} untracked files',
  confirmCheckoutBodyModified: '{modified} modified files',
  confirmCheckoutBodyUntracked: '{untracked} untracked files stay as they are (still untracked); the switch fails only if the target branch tracks a file at the same path',
  carryNote: 'Compatible uncommitted changes will be carried over; the switch fails cleanly if they conflict with the target.',
  terminalNote: 'This rewrites worktree files, including under your open terminal.',
  switchedTo: 'Switched to {branch}',
  mergeInProgress: 'A merge, cherry-pick, or revert is in progress',
  compareWithHead: 'Compare with HEAD',
  compareBase: 'Base',
  compareTarget: 'Target',
  currentBranchTip: 'Current branch',
  nodeCompareTip: 'Ctrl+click another commit to compare',
  fetch: 'Fetch',
  fetchTip: 'Fetch this repo\'s remotes now and refresh the view (writes refs/remotes and objects only)',
  fetching: 'Fetching…',
  fetchDone: 'Fetched — view is up to date',
  fetchFailed: 'Fetch failed: {summary}',
  expandViewTip: 'Read file changes in the full-width split view',
  collapseViewTip: 'Back to the graph',
  selectFileHint: 'Select a file on the left to read its changes',
  fileModeToggle: 'File list layout',
  fileModeFlat: 'Flat list',
  fileModeTree: 'Tree view',
};

const zh: Record<string, string> = {
  openRepo: '打开仓库',
  repoOpenFailed: '打开仓库失败',
  retry: '重试',
  loading: '加载中…',
  commitCount: '{n} 个提交',
  branchCountTip: '当前分支可达的完整提交历史（不受加载窗口限制）',
  filterStatusCount: '{n} / {m} 条泳道',
  filterStatusTip: '当前显示 {n}/{m} 条泳道。点击计数打开选择器；点 × 恢复全部泳道。',
  filterStatusClear: '显示全部泳道',
  compress: '压缩',
  compressTip: '智能压缩：只显示泳道起点、分支顶端、合并、标签和 HEAD',
  mergeLinks: '合并连线',
  mergeLinksTip: '为合并提交绘制虚线连线',
  labels: '标签',
  labelsTip: '在图上显示分支/标签 badge',
  copies: '副本',
  copiesLoading: '副本…',
  copiesTip: '检测 cherry-pick / rebase 产生的相同补丁提交',
  fit: '适配',
  fitTip: '将整个图形缩放到视野内',
  headHome: 'HEAD',
  headHomeTip: '镜头回到 HEAD（H）——帝国时代的回家键',
  filterRefs: '筛选分支/标签…',
  filterShort: '过滤 ( / )',
  filterTip: '过滤泳道（按 / 键）',
  copyName: '复制名称',
  copied: '已复制 {name}',
  copyRefFailed: '复制失败',
  locatePlaceholder: '搜索提交 / 分支 / hash…',
  locateNoResults: '无匹配',
  locateSearching: '正在搜索全部历史…',
  locateHitsCapped: '全历史命中 {n}+ 条',
  locateHint: '↑↓ / 悬停 / 单击 预览 · 双击或 Enter 定位',
  tags: '标签',
  tagsTip: '显示/隐藏标签 chip（如版本号标签）',
  zoneCandidates: '未选 ({n})',
  zoneSelected: '已选 ({n})',
  zoneAllSelected: '全部已选',
  zoneNoneSelected: '尚未选择',
  zoneSelectAll: '选入当前列出的全部（跟随过滤）',
  zoneClearAll: '移出当前列出的全部（跟随过滤）',
  chipHint: '点击或拖动切换 · 右键复制',
  lanesOnCanvas: '显示 {n} 条泳道',
  remotes: '远程',
  remotesTip: '显示/隐藏 origin/* 远程 badge（泳道标签不受影响）',
  dateAll: '全部',
  dateWeek: '本周',
  dateMonth: '本月',
  date3m: '近3月',
  dateYear: '近1年',
  dateCustom: '自定义',
  dateFrom: '起',
  dateTo: '止',
  onlyThis: '只看此引用',
  pin: '钉住此分支',
  unpin: '取消钉住',
  lensGroup: '泳道镜头',
  lensRecent: '活跃',
  lensRecentTip: '只看最近活跃的 5 条泳道（保留完整历史）',
  lensPinned: '钉住',
  lensPinnedTip: '只看钉住的分支',
  lensAll: '全部',
  lensAllTip: '显示全部泳道',
  noRefsMatch: '没有符合筛选的引用',
  close: '关闭',
  closeTab: '关闭标签页',
  switchWorktree: '切换 worktree 成员',
  checkedOutIn: '已检出到 worktree {name}',
  mainWorktree: '主工作树',
  linkedWorktree: '链接工作树',
  worktrees: '工作树',
  jumpToHead: '跳转到 HEAD',
  cancel: '取消',
  panelFooter: '右侧 chip 的泳道保留在画布上；悬停可钉住/"只看此引用"，右键复制；归档/休眠行控制泳道可见性。',
  welcomeTitle: '欢迎使用 Git Timeline Viewer',
  welcomeSubtitle: '点击"打开仓库"选择一个 Git 仓库',
  welcomeHint: '只读取数据，不会做任何修改',
  welcomeDropHint: '也可以将仓库文件夹拖到窗口任意位置打开',
  dropToOpen: '松开鼠标以打开仓库',
  focusLane: '聚焦此泳道',
  unfocusLane: '取消聚焦',
  expandAll: '展开全部提交',
  viewFromBranch: '从此分支查看',
  relatedOnly: '只显示相关分支',
  edgeTip: '单击：高亮两端节点\nCtrl+单击：跳到父节点\nShift+单击：跳到子节点',
  details: '提交详情',
  hash: '哈希：',
  author: '作者：',
  email: '邮箱：',
  date: '日期：',
  branches: '分支：',
  message: '提交信息：',
  changedFiles: '变更文件 ({n})',
  loadingDiff: '正在加载差异…',
  agoSeconds: '{n} 秒前',
  agoMinutes: '{n} 分钟前',
  agoHours: '{n} 小时前',
  agoDays: '{n} 天前',
  agoMonths: '{n} 个月前',
  agoYears: '{n} 年前',
  settings: '设置',
  viewOptions: '视图',
  terminal: '终端',
  terminalTip: '打开/关闭集成终端 (Ctrl+`)',
  terminalRestart: '重启',
  terminalRestartTip: '在当前打开的仓库重启 shell',
  terminalExited: 'Shell 会话已结束',
  language: '语言',
  theme: '主题',
  about: '关于',
  version: '版本',
  aboutAuthor: '作者',
  viewSource: 'GitHub 源码',
  themeMidnight: '午夜蓝',
  themeNord: 'Nord',
  themeDracula: 'Dracula',
  themeSolarized: 'Solarized 暗色',
  themeGithubLight: 'GitHub 浅色',
  reportIssue: '反馈问题',
  issueContextNote: '提交前请先检查下方将要收集的上下文——日志中可能包含本地文件路径等隐私信息，可先删改敏感内容再复制。',
  copyContext: '复制',
  copyAndReport: '复制并打开 issue 页面',
  copiedTip: '上下文已复制到剪贴板，即将打开 issue 创建页面，可直接粘贴快速完成提交',
  copyFailed: '复制失败，请手动全选复制',
  showStale: '显示窗口外分支',
  showStaleTip: '处理并显示 tip 在已加载历史窗口之外的分支。超大仓库可关闭以减少加载量。',
  autoFetch: '自动获取活动标签页',
  autoFetchTip: '每 60 秒在后台获取活动标签页的远端更新（仅写入 refs/remotes 与 objects）',
  collapseInactive: '收拢不活跃泳道',
  collapseInactiveTip: '超过该时长无活动的泳道默认收拢出画布，沉入痕迹行：已合并的进「已归档」，未合并的进「休眠」。main/dev/uat 等基座分支和活跃分支的祖先泳道始终保留。',
  inactiveOff: '不收拢',
  daysUnit: '{n} 天',
  archivedLanes: '已归档 ({n})',
  dormantLanes: '休眠 ({n})',
  expandGroup: '展开',
  collapseGroup: '收拢',
  loadingOlder: '正在加载更早的历史…',
  checkoutThisBranch: '切换到此分支',
  confirmCheckoutTitle: '切换分支？',
  confirmCheckoutBodyBoth: '{modified} 处已修改、{untracked} 个未跟踪文件',
  confirmCheckoutBodyModified: '{modified} 处已修改',
  confirmCheckoutBodyUntracked: '{untracked} 个未跟踪文件将原样保留（仍为未跟踪）；仅当目标分支跟踪同路径文件时切换失败',
  carryNote: '兼容的未提交变更将随行携带；与目标冲突时切换会干净失败。',
  terminalNote: '切换会重写工作区文件（含你开着的终端下的文件）。',
  switchedTo: '已切换到 {branch}',
  mergeInProgress: '合并/拣选/还原进行中',
  compareWithHead: '与 HEAD 对比',
  compareBase: '基准',
  compareTarget: '目标',
  currentBranchTip: '当前分支',
  nodeCompareTip: 'Ctrl+点击另一提交进行对比',
  fetch: '获取',
  fetchTip: '立即获取此仓库的远端更新并刷新视图（仅写入 refs/remotes 与 objects）',
  fetching: '正在获取…',
  fetchDone: '已获取，视图已是最新',
  fetchFailed: '获取失败：{summary}',
  expandViewTip: '在全宽分栏视图中阅读文件变更',
  collapseViewTip: '返回分支图',
  selectFileHint: '在左侧选择文件以查看变更内容',
  fileModeToggle: '文件列表排布方式',
  fileModeFlat: '平铺列表',
  fileModeTree: '树状展开',
};

const DICTS: Record<Lang, Record<string, string>> = { en, zh };

// ---------------------------------------------------------------------------
// Themes. Each theme is a flat map of CSS custom properties applied to :root;
// App.css consumes them via var(--x). --bg-canvas-rgb / --link-rgb feed the
// rgba() usages (frosted rail, active toggles).
// ---------------------------------------------------------------------------

export interface ThemeDef {
  id: string;
  nameKey: string;
  vars: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  {
    id: 'midnight',
    nameKey: 'themeMidnight',
    vars: {
      '--bg': '#1a1a2e', '--bg-header': '#16213e', '--bg-panel': '#16213e',
      '--bg-input': '#0f3460', '--bg-canvas': '#1a1a2e',
      '--bg-canvas-rgb': '26, 26, 46', '--bg-tooltip': 'rgba(22, 33, 62, 0.95)',
      '--border': '#0f3460', '--text': '#e0e0e0', '--text-dim': '#888888',
      '--text-faint': '#666666', '--accent': '#e94560', '--accent-hover': '#d13650',
      '--link': '#4A90D9', '--link-rgb': '74, 144, 217',
      '--ruler-line': '#2c2c3e', '--tick-line': '#555555',
      '--compare-ring': '#b388ff',
      '--accent-rgb': '233, 69, 96', '--head-lane-rgb': '63, 185, 80',
      '--success': '#3fb950', '--danger': '#f85149', '--warning': '#d29922',
      '--on-link': '#ffffff',
      '--diff-add-fg': '#7ee787', '--diff-add-bg': 'rgba(46, 160, 67, 0.18)',
      '--diff-del-fg': '#ff7b72', '--diff-del-bg': 'rgba(248, 81, 73, 0.15)',
      '--diff-hunk-fg': '#79c0ff',
      '--tag-pill': '#b388ff',
      '--edge-hot': '#FFD166', '--edge-flow': '#FFF3C4',
      '--patch-rebase': '#26C6DA', '--patch-cherry': '#FFA726',
      '--gap-break': '#a06a3a',
      '--shadow': 'rgba(0, 0, 0, 0.5)', '--focus-ring': '#4A90D9',
    },
  },
  {
    id: 'nord',
    nameKey: 'themeNord',
    vars: {
      '--bg': '#2e3440', '--bg-header': '#3b4252', '--bg-panel': '#3b4252',
      '--bg-input': '#434c5e', '--bg-canvas': '#2e3440',
      '--bg-canvas-rgb': '46, 52, 64', '--bg-tooltip': 'rgba(46, 52, 64, 0.95)',
      '--border': '#4c566a', '--text': '#eceff4', '--text-dim': '#8b95a5',
      '--text-faint': '#66707f', '--accent': '#bf616a', '--accent-hover': '#a94e57',
      '--link': '#88c0d0', '--link-rgb': '136, 192, 208',
      '--ruler-line': '#434c5e', '--tick-line': '#4c566a',
      '--compare-ring': '#b48ead',
      '--accent-rgb': '191, 97, 106', '--head-lane-rgb': '163, 190, 140',
      '--success': '#a3be8c', '--danger': '#bf616a', '--warning': '#ebcb8b',
      '--on-link': '#2e3440',
      '--diff-add-fg': '#a3be8c', '--diff-add-bg': 'rgba(163, 190, 140, 0.15)',
      '--diff-del-fg': '#bf616a', '--diff-del-bg': 'rgba(191, 97, 106, 0.15)',
      '--diff-hunk-fg': '#88c0d0',
      '--tag-pill': '#b48ead',
      '--edge-hot': '#ebcb8b', '--edge-flow': '#eceff4',
      '--patch-rebase': '#88c0d0', '--patch-cherry': '#d08770',
      '--gap-break': '#a06a3a',
      '--shadow': 'rgba(0, 0, 0, 0.5)', '--focus-ring': '#88c0d0',
    },
  },
  {
    id: 'dracula',
    nameKey: 'themeDracula',
    vars: {
      '--bg': '#282a36', '--bg-header': '#343746', '--bg-panel': '#343746',
      '--bg-input': '#44475a', '--bg-canvas': '#282a36',
      '--bg-canvas-rgb': '40, 42, 54', '--bg-tooltip': 'rgba(40, 42, 54, 0.95)',
      '--border': '#44475a', '--text': '#f8f8f2', '--text-dim': '#8d93a8',
      '--text-faint': '#6272a4', '--accent': '#ff5555', '--accent-hover': '#e04848',
      '--link': '#8be9fd', '--link-rgb': '139, 233, 253',
      '--ruler-line': '#44475a', '--tick-line': '#44475a',
      '--compare-ring': '#bd93f9',
      '--accent-rgb': '255, 85, 85', '--head-lane-rgb': '80, 250, 123',
      '--success': '#50fa7b', '--danger': '#ff5555', '--warning': '#ffb86c',
      '--on-link': '#282a36',
      '--diff-add-fg': '#50fa7b', '--diff-add-bg': 'rgba(80, 250, 123, 0.13)',
      '--diff-del-fg': '#ff5555', '--diff-del-bg': 'rgba(255, 85, 85, 0.13)',
      '--diff-hunk-fg': '#8be9fd',
      '--tag-pill': '#bd93f9',
      '--edge-hot': '#f1fa8c', '--edge-flow': '#f8f8f2',
      '--patch-rebase': '#8be9fd', '--patch-cherry': '#ffb86c',
      '--gap-break': '#a06a3a',
      '--shadow': 'rgba(0, 0, 0, 0.55)', '--focus-ring': '#8be9fd',
    },
  },
  {
    id: 'solarized',
    nameKey: 'themeSolarized',
    vars: {
      '--bg': '#002b36', '--bg-header': '#073642', '--bg-panel': '#073642',
      '--bg-input': '#0a3d4b', '--bg-canvas': '#002b36',
      '--bg-canvas-rgb': '0, 43, 54', '--bg-tooltip': 'rgba(0, 43, 54, 0.95)',
      '--border': '#0f4b5c', '--text': '#93a1a1', '--text-dim': '#839496',
      '--text-faint': '#586e75', '--accent': '#dc322f', '--accent-hover': '#c22b28',
      '--link': '#268bd2', '--link-rgb': '38, 139, 210',
      '--ruler-line': '#0a3d4b', '--tick-line': '#0f4b5c',
      '--compare-ring': '#6c71c4',
      '--accent-rgb': '220, 50, 47', '--head-lane-rgb': '133, 153, 0',
      '--success': '#859900', '--danger': '#dc322f', '--warning': '#b58900',
      '--on-link': '#002b36',
      '--diff-add-fg': '#859900', '--diff-add-bg': 'rgba(133, 153, 0, 0.15)',
      '--diff-del-fg': '#dc322f', '--diff-del-bg': 'rgba(220, 50, 47, 0.15)',
      '--diff-hunk-fg': '#268bd2',
      '--tag-pill': '#6c71c4',
      '--edge-hot': '#b58900', '--edge-flow': '#fdf6e3',
      '--patch-rebase': '#2aa198', '--patch-cherry': '#cb4b16',
      '--gap-break': '#a06a3a',
      '--shadow': 'rgba(0, 0, 0, 0.55)', '--focus-ring': '#268bd2',
    },
  },
  {
    id: 'github-light',
    nameKey: 'themeGithubLight',
    vars: {
      '--bg': '#ffffff', '--bg-header': '#f6f8fa', '--bg-panel': '#ffffff',
      '--bg-input': '#f6f8fa', '--bg-canvas': '#ffffff',
      '--bg-canvas-rgb': '255, 255, 255', '--bg-tooltip': 'rgba(255, 255, 255, 0.97)',
      '--border': '#d0d7de', '--text': '#1f2328', '--text-dim': '#57606a',
      '--text-faint': '#8c959f', '--accent': '#cf222e', '--accent-hover': '#a40e26',
      '--link': '#0969da', '--link-rgb': '9, 105, 218',
      '--ruler-line': '#d0d7de', '--tick-line': '#8c959f',
      '--compare-ring': '#8250df',
      '--accent-rgb': '207, 34, 46', '--head-lane-rgb': '26, 127, 55',
      '--success': '#1a7f37', '--danger': '#cf222e', '--warning': '#9a6700',
      '--on-link': '#ffffff',
      '--diff-add-fg': '#1a7f37', '--diff-add-bg': '#dafbe1',
      '--diff-del-fg': '#cf222e', '--diff-del-bg': '#ffebe9',
      '--diff-hunk-fg': '#0550ae',
      '--tag-pill': '#8250df',
      '--edge-hot': '#9a6700', '--edge-flow': '#e3a008',
      '--patch-rebase': '#0891b2', '--patch-cherry': '#bc4c00',
      '--gap-break': '#8a5a2a',
      '--shadow': 'rgba(31, 35, 40, 0.15)', '--focus-ring': '#0969da',
    },
  },
];

export function applyTheme(themeId: string) {
  const def = THEMES.find(t => t.id === themeId) ?? THEMES[0];
  const root = document.documentElement;
  for (const [k, v] of Object.entries(def.vars)) {
    root.style.setProperty(k, v);
  }
  root.dataset.theme = def.id;
}

/** Read a CSS custom property at draw time (D3 canvas colors). */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Open a URL in the system browser (Tauri opener plugin, window.open fallback). */
export async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank');
  }
}

// ---------------------------------------------------------------------------

interface SettingsCtx {
  lang: Lang;
  theme: string;
  /** Whether stale branches (tips outside the loaded window) are processed
   *  and shown; persisted as gtv_show_stale. */
  showStaleBranches: boolean;
  /** Hide remote-tracking refs (origin/*) from badge/tooltip/detail layers;
   *  persisted as gtv_hide_remotes. */
  hideRemotes: boolean;
  /** Lane-inactivity threshold in days; 0 disables collapsing.
   *  Persisted as gtv_inactive_days. */
  inactiveDays: number;
  setInactiveDays: (d: number) => void;
  /** Background 60s fetch of the active tab's remotes (spec 4.3); persisted
   *  as gtv_autofetch. App mirrors this into the backend toggle at startup
   *  AND on every change: the backend AppState defaults to TRUE
   *  (commands.rs), so the sync effect's startup job is the OFF direction
   *  -- a user who disabled auto-fetch must not be silently re-enabled on
   *  relaunch (fc39526 wording; final-review FR-L3). */
  autoFetch: boolean;
  setAutoFetch: (v: boolean) => void;
  setLang: (l: Lang) => void;
  setTheme: (t: string) => void;
  setShowStaleBranches: (v: boolean) => void;
  setHideRemotes: (v: boolean) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<SettingsCtx | null>(null);

function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  // Apply the persisted theme synchronously in the initializer: the Timeline
  // canvas reads CSS vars at draw time (child effect), so they must be on
  // :root before the first paint, not in a provider effect.
  const [theme, setThemeState] = useState<string>(() => {
    const id = localStorage.getItem(THEME_KEY) ?? 'midnight';
    applyTheme(id);
    return id;
  });

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  }, [lang]);

  const setLang = (l: Lang) => {
    localStorage.setItem(LANG_KEY, l);
    setLangState(l);
  };
  const setTheme = (id: string) => {
    localStorage.setItem(THEME_KEY, id);
    applyTheme(id);
    setThemeState(id);
  };
  // Default on: preserve the long-standing "all branches" behavior.
  const [showStaleBranches, setShowStaleBranchesState] = useState(
    () => localStorage.getItem(STALE_KEY) !== '0',
  );
  const setShowStaleBranches = (v: boolean) => {
    localStorage.setItem(STALE_KEY, v ? '1' : '0');
    setShowStaleBranchesState(v);
  };

  // Default off: preserve the long-standing "remote refs shown" behavior.
  const [hideRemotes, setHideRemotesState] = useState(
    () => localStorage.getItem(HIDE_REMOTES_KEY) === '1',
  );
  const setHideRemotes = (v: boolean) => {
    localStorage.setItem(HIDE_REMOTES_KEY, v ? '1' : '0');
    setHideRemotesState(v);
  };

  const [inactiveDays, setInactiveDaysState] = useState<number>(() => {
    const v = parseInt(localStorage.getItem(INACTIVE_DAYS_KEY) ?? '90', 10);
    return Number.isFinite(v) && v >= 0 ? v : 90;
  });
  const setInactiveDays = (d: number) => {
    localStorage.setItem(INACTIVE_DAYS_KEY, String(d));
    setInactiveDaysState(d);
  };

  // Default on (spec 4.3): "the active tab refreshes live" is the headline
  // feature of the request -- shipping it behind an opt-in would hide it.
  // A fetch only writes refs/remotes and objects (whitelist item 2) and
  // fails silently, so on-by-default disturbs nobody.
  const [autoFetch, setAutoFetchState] = useState(
    () => localStorage.getItem(AUTOFETCH_KEY) !== '0',
  );
  const setAutoFetch = (v: boolean) => {
    localStorage.setItem(AUTOFETCH_KEY, v ? '1' : '0');
    setAutoFetchState(v);
  };

  const t = (key: string, vars?: Record<string, string | number>): string => {
    let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    }
    return s;
  };

  return <Ctx.Provider value={{ lang, theme, showStaleBranches, hideRemotes, inactiveDays, autoFetch, setLang, setTheme, setShowStaleBranches, setHideRemotes, setInactiveDays, setAutoFetch, t }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
}

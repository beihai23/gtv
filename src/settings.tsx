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

const en: Record<string, string> = {
  openRepo: 'Open Repository',
  loading: 'Loading...',
  commitCount: '{n} commits',
  more: '+{n} more ▾',
  closeUp: 'Close ▴',
  compress: 'Compress',
  compressTip: 'Smart compression: show only lane births, tips, merges, tags, HEAD',
  mergeLinks: 'Merge links',
  labels: 'Labels',
  copies: 'Copies',
  copiesLoading: 'Copies…',
  copiesTip: 'Detect cherry-picked / rebased commits (same patch, different commit)',
  fit: 'Fit',
  fitTip: 'Fit whole graph into view',
  filterRefs: 'Filter branches/tags...',
  refsShown: '{n} refs ({m} shown)',
  tags: 'Tags',
  tagsTip: 'Show/hide tag chips (e.g. version tags)',
  all: 'All',
  none: 'None',
  close: 'Close',
  enabled: 'Enabled ({n})',
  disabled: 'Disabled ({n})',
  panelFooter: 'Double-click a chip to solo it — for daily work: None, then double-click the 2-3 branches you care about.',
  welcomeTitle: 'Welcome to Git Timeline Viewer',
  welcomeSubtitle: 'Click "Open Repository" to select a Git repository',
  welcomeHint: 'Only reads data - no modifications will be made',
  openLatest: 'Open Latest: {name}',
  chipTip: 'Click: toggle · Double-click: only this one',
  focusLane: 'Focus this lane',
  unfocusLane: 'Unfocus lane',
  expandAll: 'Expand all commits',
  viewFromBranch: 'View from this branch',
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
};

const zh: Record<string, string> = {
  openRepo: '打开仓库',
  loading: '加载中…',
  commitCount: '{n} 个提交',
  more: '+{n} 更多 ▾',
  closeUp: '收起 ▴',
  compress: '压缩',
  compressTip: '智能压缩：只显示泳道起点、分支顶端、合并、标签和 HEAD',
  mergeLinks: '合并连线',
  labels: '标签',
  copies: '副本',
  copiesLoading: '副本…',
  copiesTip: '检测 cherry-pick / rebase 产生的相同补丁提交',
  fit: '适配',
  fitTip: '将整个图形缩放到视野内',
  filterRefs: '筛选分支/标签…',
  refsShown: '{n} 个引用（显示 {m} 个）',
  tags: '标签',
  tagsTip: '显示/隐藏标签 chip（如版本号标签）',
  all: '全选',
  none: '全不选',
  close: '关闭',
  enabled: '已启用 ({n})',
  disabled: '未启用 ({n})',
  panelFooter: '双击 chip 可只看该分支——日常使用：先"全不选"，再双击你关心的 2-3 个分支。',
  welcomeTitle: '欢迎使用 Git Timeline Viewer',
  welcomeSubtitle: '点击"打开仓库"选择一个 Git 仓库',
  welcomeHint: '只读取数据，不会做任何修改',
  openLatest: '打开最近：{name}',
  chipTip: '单击：切换 · 双击：只看这一个',
  focusLane: '聚焦此泳道',
  unfocusLane: '取消聚焦',
  expandAll: '展开全部提交',
  viewFromBranch: '从此分支查看',
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
    },
  },
  {
    id: 'dracula',
    nameKey: 'themeDracula',
    vars: {
      '--bg': '#282a36', '--bg-header': '#21222c', '--bg-panel': '#21222c',
      '--bg-input': '#44475a', '--bg-canvas': '#282a36',
      '--bg-canvas-rgb': '40, 42, 54', '--bg-tooltip': 'rgba(40, 42, 54, 0.95)',
      '--border': '#44475a', '--text': '#f8f8f2', '--text-dim': '#8d93a8',
      '--text-faint': '#6272a4', '--accent': '#ff5555', '--accent-hover': '#e04848',
      '--link': '#8be9fd', '--link-rgb': '139, 233, 253',
      '--ruler-line': '#44475a', '--tick-line': '#44475a',
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
  setLang: (l: Lang) => void;
  setTheme: (t: string) => void;
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

  const t = (key: string, vars?: Record<string, string | number>): string => {
    let s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    }
    return s;
  };

  return <Ctx.Provider value={{ lang, theme, setLang, setTheme, t }}>{children}</Ctx.Provider>;
}

export function useSettings(): SettingsCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSettings outside SettingsProvider');
  return ctx;
}

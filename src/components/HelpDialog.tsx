// Help: quick-start + canvas legend. The content is long-form reference
// material, so it lives here as per-language structures instead of the
// flat settings dictionaries.
import type { ReactNode } from 'react';
import { useSettings } from '../settings';

interface HelpItem {
  /** Small visual sample for legend rows; usage rows leave it undefined. */
  art?: ReactNode;
  zh: string;
  en: string;
}
interface HelpSection {
  zh: string;
  en: string;
  items: HelpItem[];
}

const sw = (children: ReactNode) => (
  <svg className="help-art" viewBox="0 0 72 22" aria-hidden="true">{children}</svg>
);

const USAGE: HelpSection = {
  zh: '快速上手',
  en: 'Quick start',
  items: [
    {
      zh: '打开仓库:点标签栏的 + 或按 ⌘/Ctrl+T 选择文件夹,也可以把文件夹直接拖进窗口。每个仓库一个标签页;同一 worktree 家族的成员共享标签页,用头部「工作树」菜单切换成员。',
      en: 'Open a repo: the + in the tab bar or ⌘/Ctrl+T, or drag a folder onto the window. One tab per repo; members of a worktree family share one tab — switch via the "Worktrees" menu in the header.',
    },
    {
      zh: '画布导航:拖动平移;滚轮/触控板滚动平移,捏合或 Ctrl+滚轮缩放;右下角小地图是全局缩略;「适配」把全图收进视野;点「⌖ HEAD」或按 H 回到当前提交。',
      en: 'Navigate: drag to pan; wheel/trackpad scrolls, pinch or Ctrl+wheel zooms; the minimap (bottom right) is the overview; "Fit" frames everything; "⌖ HEAD" or H snaps back to the current commit.',
    },
    {
      zh: '提交:点击节点查看详情(作者、时间、文件 +/−、逐行 diff);选中后用 ←/→ 沿泳道逐个走;Ctrl/⌘+点击两个节点进行两点对比。',
      en: 'Commits: click a node for details (author, time, per-file +/−, line diff); with one selected, ←/→ steps along its lane; Ctrl/⌘-click two nodes to compare them.',
    },
    {
      zh: '泳道:左栏是分支名,点击聚焦该泳道(其余淡出),右键打开菜单——复制名称、聚焦、展开全部、从此分支查看、仅相关分支、切换到该分支(checkout)、与 HEAD 对比。',
      en: 'Lanes: the left rail names each branch — click to focus it (others fade), right-click for the menu: copy name, focus, expand all, view from this branch, related only, check out, compare with HEAD.',
    },
    {
      zh: '过滤:顶部分支面板支持搜索和勾选;📌 固定常用分支后,用镜头一键只看它们;时间范围可限定展示窗口;不活跃的泳道自动收拢为「已归档/休眠」沉积行,点击可展开。',
      en: 'Filter: the branch panel searches and checks; 📌 pin the branches you care about and the lens shows just them; a date range crops the window; inactive lanes fold into Archived/Dormant rows — click to expand.',
    },
    {
      zh: '更早的历史:把画布拖过左缘会自动分页加载。仓库在磁盘上的变化(提交、合并、fetch)会自动刷新到图上;「获取」按钮手动 fetch 远端。',
      en: 'Older history: drag past the left edge to page it in. On-disk repo changes (commit, merge, fetch) refresh the graph automatically; the Fetch button fetches remotes on demand.',
    },
    {
      zh: '终端:桌面版按 Ctrl+` 或点终端按钮打开内嵌终端;VS Code 版则打开 VS Code 自己的集成终端,cwd 定位到当前 worktree。',
      en: 'Terminal: on desktop, Ctrl+` or the terminal button opens the embedded terminal; in VS Code it opens VS Code\'s own integrated terminal, cwd set to the current worktree.',
    },
  ],
};

const LEGEND: HelpSection = {
  zh: '图例',
  en: 'Legend',
  items: [
    {
      art: sw(<><line x1="2" y1="11" x2="70" y2="11" stroke="#4A90D9" stroke-width="2.5" /><circle cx="24" cy="11" r="4.5" fill="#4A90D9" /><circle cx="48" cy="11" r="7" fill="#4A90D9" /></>),
      zh: '泳道 + 圆点 = 分支轨道与其上的提交;点越大,这次提交改动的行数越多。主分支(main)固定蓝色,永远在最上方。',
      en: 'Lane + dots = a branch track and its commits; bigger dot, bigger diff. The trunk (main) is always the top, blue lane.',
    },
    {
      art: sw(<><line x1="2" y1="11" x2="44" y2="11" stroke="#4A90D9" stroke-width="2.5" /><circle cx="14" cy="11" r="4.5" fill="#4A90D9" /><rect x="34" y="4" width="30" height="14" rx="7" fill="#666" /><text x="49" y="14.5" font-size="9" fill="#fff" text-anchor="middle">+7</text></>),
      zh: '智能压缩只显示关键节点(分叉、合并、标签、顶端、HEAD):"+N" 是被折叠的提交数;泳道右键「展开全部」可展开该泳道的完整历史。',
      en: 'Smart compression shows only key commits (forks, merges, tags, tips, HEAD); "+N" counts the collapsed ones — the lane menu\'s "Expand all" reveals the full history.',
    },
    {
      art: sw(<><rect x="2" y="4" width="34" height="14" rx="7" fill="#E91E63" /><text x="19" y="14.5" font-size="9" fill="#fff" text-anchor="middle">feat/x</text><rect x="40" y="4" width="30" height="14" rx="7" fill="none" stroke="#009688" /><text x="55" y="14.5" font-size="8" fill="#009688" text-anchor="middle">origin/x</text></>),
      zh: '节点上的彩色标签 = 指向该提交的引用:实心 = 本地分支;描边 = 仅远端存在的分支(origin/x)。',
      en: 'A colored pill on a node = a ref pointing at that commit: solid = local branch; outline = remote-only branch (origin/x).',
    },
    {
      art: sw(<><rect x="2" y="4" width="42" height="14" rx="7" fill="#FF9800" /><text x="23" y="14.5" font-size="9" fill="#fff" text-anchor="middle">feat/x ⤒</text><rect x="48" y="4" width="22" height="14" rx="7" fill="#9C27B0" /><text x="59" y="14.5" font-size="9" fill="#fff" text-anchor="middle">v1.2</text></>),
      zh: '标签名带 ⤒ = 本地与远端同步(指向同一提交);紫色 = tag;同节点还有第三个以上引用时折叠为「+N」。',
      en: 'A ⤒ suffix = local and remote are in sync (same commit); purple = tag; a node with more refs folds the rest into "+N".',
    },
    {
      art: sw(<><rect x="2" y="2" width="68" height="18" rx="4" fill="rgba(63,185,80,0.18)" /><line x1="2" y1="11" x2="70" y2="11" stroke="#4A90D9" stroke-width="2.5" /><circle cx="36" cy="11" r="5" fill="#1a1a2e" stroke="#3fb950" stroke-width="2" /></>),
      zh: '绿色圆环 + 绿色光带 = HEAD,你当前检出的位置(左栏分支名、小地图上的绿点同义)。',
      en: 'Green ring + green band = HEAD, where you are checked out (same green on the rail chip and the minimap dot).',
    },
    {
      art: sw(<><line x1="2" y1="6" x2="40" y2="6" stroke="#4A90D9" stroke-width="2.5" /><circle cx="40" cy="6" r="4" fill="#4A90D9" /><polyline points="40,6 40,14 48,17" fill="none" stroke="#E91E63" stroke-width="2" /><line x1="48" y1="17" x2="70" y2="17" stroke="#E91E63" stroke-width="2.5" /></>),
      zh: '直角折线 = 一条分支在这里诞生(分叉点);子泳道的首提交通过它连回父泳道。',
      en: 'A right-angle polyline = a branch is born here (fork point), connecting the child lane\'s first commit back to its parent lane.',
    },
    {
      art: sw(<><line x1="2" y1="17" x2="40" y2="17" stroke="#E91E63" stroke-width="2.5" /><path d="M 40 17 Q 52 17 56 8" fill="none" stroke="#E91E63" stroke-width="1.8" stroke-dasharray="3 3" /><line x1="56" y1="6" x2="70" y2="6" stroke="#4A90D9" stroke-width="2.5" /><circle cx="56" cy="6" r="4" fill="#4A90D9" /></>),
      zh: '虚线曲线 = 合并:该泳道的顶端被合入上方的目标泳道。',
      en: 'A dashed curve = a merge: this lane\'s tip was merged into the target lane above.',
    },
    {
      art: sw(<><line x1="8" y1="2" x2="8" y2="20" stroke="#a06a3a" stroke-dasharray="3 3" /><text x="14" y="15" font-size="9" fill="#a06a3a">// 45d</text><line x1="52" y1="2" x2="52" y2="20" stroke="#a06a3a" stroke-dasharray="3 3" /></>),
      zh: '"// 45d" = 时间断轴:这段空档里没有任何提交,被折叠起来以保持可读。',
      en: '"// 45d" = a folded time gap: nothing was committed in that span, so it is collapsed to keep the axis readable.',
    },
    {
      art: sw(<><rect x="2" y="3" width="46" height="16" rx="5" fill="none" stroke="#009688" /><text x="25" y="14.5" font-size="9" fill="#009688" text-anchor="middle">feat/x</text><rect x="50" y="3" width="20" height="16" rx="5" fill="none" stroke="#666" /><text x="60" y="14.5" font-size="8" fill="#666" text-anchor="middle" font-style="italic">+9</text></>),
      zh: '左栏是泳道名(点击聚焦);斜体的「已归档/休眠」是收拢的不活跃泳道,点击展开。',
      en: 'The left rail names each lane (click to focus); italic Archived/Dormant rows are collapsed inactive lanes — click to expand.',
    },
    {
      art: sw(<><rect x="2" y="4" width="68" height="14" rx="2" fill="none" stroke="#888" /><line x1="6" y1="11" x2="66" y2="11" stroke="#4A90D9" stroke-width="1.5" /><circle cx="60" cy="11" r="2.5" fill="#3fb950" /><rect x="30" y="6" width="18" height="10" fill="none" stroke="#888" /></>),
      zh: '小地图 = 全部历史的缩略总览,绿点 = HEAD,线框 = 当前视野。',
      en: 'The minimap = the whole history in miniature; green dot = HEAD; the frame is your current viewport.',
    },
    {
      art: sw(<><circle cx="10" cy="11" r="4" fill="#3fb950" /><circle cx="28" cy="11" r="4" fill="#d29922" /><text x="35" y="14.5" font-size="9" fill="#d29922">3</text><circle cx="52" cy="11" r="4" fill="#f85149" /><text x="59" y="14.5" font-size="9" fill="#f85149">!</text></>),
      zh: '头部状态点:绿 = 工作区干净;橙+数字 = 未提交的更改数(悬停看明细);红 ! = 合并/拣选进行中。',
      en: 'Header status dot: green = clean worktree; amber + count = uncommitted changes (hover for details); red ! = merge in progress.',
    },
    {
      zh: '悬停任何节点:哈希、提交信息、作者、时间、该提交上的全部引用,以及(若它是分叉/合并点)相关的分支名。',
      en: 'Hover any node: hash, message, author, time, every ref on it, and — for fork/merge points — the branch names involved.',
    },
  ],
};

export function HelpDialog({ onClose }: { onClose: () => void }) {
  const { lang, t } = useSettings();
  const isZh = lang === 'zh';
  const renderSection = (s: HelpSection) => (
    <div className="settings-section" key={s.en}>
      <div className="settings-section-title">{isZh ? s.zh : s.en}</div>
      <div className="help-items">
        {s.items.map((item, i) => (
          <div className="help-item" key={i}>
            {item.art && <span className="help-item-art">{item.art}</span>}
            <span className="help-item-text">{isZh ? item.zh : item.en}</span>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-dialog help-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{t('help')}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
          {renderSection(USAGE)}
          {renderSection(LEGEND)}
        </div>
      </div>
    </div>
  );
}

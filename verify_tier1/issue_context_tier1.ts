import { buildIssueContext, osFromUserAgent, recordFrontendError, recentFrontendErrors, ISSUE_URL } from '../src/issueContext';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { console.log('ok   ' + name); return; }
  failures++;
  console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
};

// 1) 完整输入 → 报告包含全部小节与原文（用户看到的即所得）
const text = buildIssueContext({
  version: '1.2.3', os: 'macOS 14', lang: 'zh', theme: 'midnight',
  repoName: 'taskon-server', commitCount: 2000,
  currentError: 'failed to open repository: Not Found',
  frontendErrors: ['[2026-08-20 10:00:00] boom'],
  backendLogs: ['[2026-08-20 10:00:01 INFO  gtv_lib::commands] Opened repository with 5 commits'],
});
check('version in report', text.includes('1.2.3'));
check('os in report', text.includes('macOS 14'));
check('lang in report', text.includes('zh'));
check('theme in report', text.includes('midnight'));
check('repo name in report', text.includes('taskon-server'));
check('currentError verbatim', text.includes('failed to open repository: Not Found'));
check('frontend error verbatim', text.includes('[2026-08-20 10:00:00] boom'));
check('backend log verbatim', text.includes('Opened repository with 5 commits'));
check('user placeholder sections', text.toLowerCase().includes('what happened'));
check('logs fenced as code block', text.includes('```'));

// 2) 空输入 → 小节优雅省略，绝不泄漏 null/undefined
const minimal = buildIssueContext({
  version: '0.0.0', os: '', lang: 'en', theme: '',
  repoName: null, commitCount: null, currentError: null,
  frontendErrors: [], backendLogs: [],
});
check('minimal has no null/undefined leak', !/\b(null|undefined)\b/.test(minimal));
check('minimal still has placeholders', minimal.toLowerCase().includes('what happened'));

// 3) OS 解析契约
check('ua mac', osFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15') === 'macOS');
check('ua windows', osFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') === 'Windows');
check('ua linux', osFromUserAgent('Mozilla/5.0 (X11; Linux x86_64)') === 'Linux');
check('ua unknown', osFromUserAgent('curl/8.0') === 'Unknown');

// 4) 前端错误环形缓冲：上限 20、淘汰最旧、旧→新排序、带时间戳
for (let i = 1; i <= 25; i++) recordFrontendError('err-' + i);
const errs = recentFrontendErrors();
check('ring capped at 20', errs.length === 20, 'got ' + errs.length);
check('oldest evicted', !errs.some(e => e.includes('err-5')));
check('oldest kept is err-6', errs[0].includes('err-6'));
check('newest last', errs[errs.length - 1].includes('err-25'));
check('timestamped', errs.every(e => /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(e)));

// 5) 一键跳转目标固定为本仓库 issue 创建页
check('issue url', ISSUE_URL === 'https://github.com/beihai23/gtv/issues/new');

if (failures > 0) throw new Error(failures + ' check(s) failed');
console.log('all issue-context tier-1 checks passed');

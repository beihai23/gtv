// Pure helpers for the issue-report dialog (gtv #3). This module must not
// import anything else so the tier-1 verification script can compile and run
// it standalone.

export const ISSUE_URL = 'https://github.com/beihai23/gtv/issues/new';

export interface IssueContextInput {
  version: string;
  os: string;
  lang: string;
  theme: string;
  repoName: string | null;
  commitCount: number | null;
  currentError: string | null;
  frontendErrors: string[];
  backendLogs: string[];
}

/** `[YYYY-MM-DD HH:MM:SS]` in the user's local timezone. */
function formatTimestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Basename of a repo path, tolerating both '/' and '\' separators. */
function basename(path: string): string | null {
  const parts = path.split(/[\\/]/).filter(s => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * Build the markdown issue context the user reviews (and may redact) before
 * copying. Sections whose input is null/empty are omitted entirely — the
 * report must never contain the words "null" or "undefined".
 */
export function buildIssueContext(input: IssueContextInput): string {
  const lines: string[] = [];
  lines.push('# Git Timeline Viewer issue');
  lines.push('');
  lines.push('## App');
  lines.push(`- Version: ${input.version}`);
  if (input.os) lines.push(`- OS: ${input.os}`);
  if (input.lang) lines.push(`- UI Language: ${input.lang}`);
  if (input.theme) lines.push(`- Theme: ${input.theme}`);

  const repo = input.repoName ? basename(input.repoName) : null;
  if (repo || input.commitCount !== null) {
    lines.push('');
    lines.push('## Repository');
    if (repo) lines.push(`- Name: ${repo}`);
    if (input.commitCount !== null) lines.push(`- Commits loaded: ${input.commitCount}`);
  }

  if (input.currentError) {
    lines.push('');
    lines.push('## Error');
    lines.push('');
    lines.push('```');
    lines.push(input.currentError);
    lines.push('```');
  }

  if (input.frontendErrors.length > 0) {
    lines.push('');
    lines.push('## Recent frontend errors');
    lines.push('');
    lines.push('```');
    lines.push(...input.frontendErrors);
    lines.push('```');
  }

  if (input.backendLogs.length > 0) {
    lines.push('');
    lines.push('## Recent backend logs');
    lines.push('');
    lines.push('```');
    lines.push(...input.backendLogs);
    lines.push('```');
  }

  lines.push('');
  lines.push('## What happened?');
  lines.push('');
  lines.push('');
  lines.push('## What did you expect?');
  lines.push('');

  return lines.join('\n');
}

/** Best-effort OS name from the browser user agent. */
export function osFromUserAgent(ua: string): string {
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Windows')) return 'Windows';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown';
}

// --- Frontend error ring buffer -------------------------------------------
// Capped at 20 entries, oldest evicted, returned oldest-first. Filled by the
// App-level catch handlers and the window-level listeners in main.tsx.

const FRONTEND_ERROR_LIMIT = 20;
const frontendErrors: string[] = [];

export function recordFrontendError(msg: string): void {
  frontendErrors.push(`[${formatTimestamp(new Date())}] ${msg}`);
  if (frontendErrors.length > FRONTEND_ERROR_LIMIT) {
    frontendErrors.splice(0, frontendErrors.length - FRONTEND_ERROR_LIMIT);
  }
}

export function recentFrontendErrors(): string[] {
  return [...frontendErrors];
}

// --- Clipboard -------------------------------------------------------------

/**
 * Copy text via the async clipboard API, falling back to a hidden textarea +
 * execCommand (Tauri webview on older systems / non-secure contexts).
 * Resolves false when both paths fail — callers must then ask the user to
 * copy manually.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Off-screen but focusable: position:fixed + opacity 0 keeps the copy
    // working without scrolling the page or flashing the element.
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

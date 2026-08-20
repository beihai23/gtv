import { useEffect, useRef, useState } from 'react';
import pkg from '../../package.json';
import { useSettings, openExternal } from '../settings';
import { getCurrentPath, getRecentLogs } from '../api';
import {
  ISSUE_URL,
  buildIssueContext,
  copyToClipboard,
  osFromUserAgent,
  recentFrontendErrors,
} from '../issueContext';

interface IssueReportDialogProps {
  currentError: string | null;
  repoName?: string | null;
  commitCount?: number | null;
  onClose: () => void;
}

const TIP_MS = 6000;
const OPEN_DELAY_MS = 800;
const COPIED_MS = 2000;

/**
 * Report-issue dialog (gtv #3): shows exactly the context that would be
 * attached to a GitHub issue — the user can review, redact, then copy it
 * and jump straight to the issue creation page.
 */
export function IssueReportDialog({ currentError, repoName, commitCount, onClose }: IssueReportDialogProps) {
  const { lang, theme, t } = useSettings();
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [tip, setTip] = useState<{ kind: 'ok' | 'fail'; text: string } | null>(null);
  const timers = useRef<number[]>([]);

  // Collect-once on mount: the report reflects the state at the moment the
  // user asked to report, not later edits to settings/repo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let repo = repoName ?? null;
      if (repo === null) {
        try {
          const path = await getCurrentPath();
          repo = path ? path.split('/').pop() ?? null : null;
        } catch {
          repo = null;
        }
      }
      let backendLogs: string[] = [];
      try {
        backendLogs = await getRecentLogs();
      } catch {
        backendLogs = [];
      }
      if (cancelled) return;
      setText(buildIssueContext({
        version: pkg.version === '0.0.0' ? 'dev' : pkg.version,
        os: osFromUserAgent(navigator.userAgent),
        lang,
        theme,
        repoName: repo,
        commitCount: commitCount ?? null,
        currentError,
        frontendErrors: recentFrontendErrors(),
        backendLogs,
      }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear pending timers (tip auto-hide, delayed browser open) on unmount.
  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const showTip = (kind: 'ok' | 'fail', tipText: string) => {
    setTip({ kind, text: tipText });
    later(() => setTip(null), TIP_MS);
  };

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      later(() => setCopied(false), COPIED_MS);
    } else {
      showTip('fail', t('copyFailed'));
    }
  };

  const handleCopyAndReport = async () => {
    const ok = await copyToClipboard(text);
    if (!ok) {
      // No clipboard content -> no jump; the user must copy manually.
      showTip('fail', t('copyFailed'));
      return;
    }
    showTip('ok', t('copiedTip'));
    later(() => { openExternal(ISSUE_URL); }, OPEN_DELAY_MS);
  };

  return (
    // Nested usage (Settings -> About) means the click would otherwise bubble
    // into the parent backdrop and close it too — stop it after self-closing.
    <div className="settings-backdrop" onClick={e => { e.stopPropagation(); onClose(); }}>
      <div className="issue-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{t('reportIssue')}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="issue-body">
          <div className="issue-note">{t('issueContextNote')}</div>
          <textarea
            className="issue-textarea"
            value={text}
            onChange={e => setText(e.target.value)}
            spellCheck={false}
          />
          {tip && <div className={`issue-tip ${tip.kind}`}>{tip.text}</div>}
          <div className="issue-actions">
            <button className="view-btn" onClick={handleCopy}>
              {copied ? `✓ ${t('copyContext')}` : t('copyContext')}
            </button>
            <button className="open-btn issue-report-btn" onClick={handleCopyAndReport}>
              {t('copyAndReport')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

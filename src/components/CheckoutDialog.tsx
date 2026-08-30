import { useSettings } from '../settings';
import type { WorktreeStatus } from '../types';

interface CheckoutDialogProps {
  branch: string;
  status: WorktreeStatus;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Dirty-worktree confirmation for "check out this branch" (spec 4.2).
 * Opened only when the worktree preflight reports modified or untracked
 * files; a clean worktree checks out without asking. Confirming runs the
 * SAFE checkout (compatible uncommitted changes ride along, a conflict
 * aborts before writing anything); cancel or a backdrop click changes
 * nothing. No force/discard variants exist by design (arc invariant).
 * Overlay classes are reused from the Settings/IssueReport dialogs.
 */
export function CheckoutDialog({ branch, status, onConfirm, onClose }: CheckoutDialogProps) {
  const { t } = useSettings();
  return (
    // Backdrop click = cancel; the card stops the click (IssueReportDialog
    // overlay contract).
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-dialog" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h3>{t('confirmCheckoutTitle')}</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="settings-body">
          <div><strong>{branch}</strong></div>
          {/* Counts only -- no file-granularity promises: an untracked
              directory is a single porcelain record (Task 1 ruling). */}
          <div>{t('confirmCheckoutBody', { modified: status.modified, untracked: status.untracked })}</div>
          <div className="issue-note">{t('carryNote')}</div>
          <div className="issue-note">{t('terminalNote')}</div>
          <div className="issue-actions">
            <button className="view-btn" onClick={onClose}>{t('close')}</button>
            <button className="open-btn issue-report-btn" onClick={onConfirm}>{t('checkoutThisBranch')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

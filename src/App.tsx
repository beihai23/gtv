import { useState, useCallback, useEffect } from 'react';
import './App.css';
import { SettingsDialog } from './components/SettingsDialog';
import RepoView from './RepoView';

const SHOW_TAGS_KEY = 'gtv_show_tags';

function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [showIssueReport, setShowIssueReport] = useState(false);

  // Cmd/Ctrl + , toggles the settings dialog (macOS convention).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setShowSettings(s => !s);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Version-tag flood control: hides tag chips from the toolbar and panel.
  const [showTags, setShowTags] = useState(() => localStorage.getItem(SHOW_TAGS_KEY) !== '0');
  const toggleShowTags = useCallback(() => {
    setShowTags(v => {
      localStorage.setItem(SHOW_TAGS_KEY, v ? '0' : '1');
      return !v;
    });
  }, []);
  // View options live here so the header owns the whole toolbar row.
  const [compressed, setCompressed] = useState(true);
  const [showMergeLinks, setShowMergeLinks] = useState(true);
  const [showRefLabels, setShowRefLabels] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);

  return (
    <div className="app">
      {/* SettingsDialog stays BEFORE the repo body: it shares the z-80
          backdrop class with Checkout/IssueReport, and at equal z the
          paint order is DOM order -- the pre-extraction App rendered it
          first, so a Cmd+, pressed while another modal is open leaves
          that modal on top (first click closes it). Rendered after the
          body, the same keypress would flip the stacking instead. */}
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {/* Global shell (multi-repo-tabs Task 4): exactly ONE RepoView today;
          Task 5 mounts one per tab and moves gtv_latest_repo up into App. */}
      <RepoView
        showTags={showTags}
        toggleShowTags={toggleShowTags}
        compressed={compressed}
        setCompressed={setCompressed}
        showMergeLinks={showMergeLinks}
        setShowMergeLinks={setShowMergeLinks}
        showRefLabels={showRefLabels}
        setShowRefLabels={setShowRefLabels}
        fitSignal={fitSignal}
        setFitSignal={setFitSignal}
        showIssueReport={showIssueReport}
        setShowIssueReport={setShowIssueReport}
        setShowSettings={setShowSettings}
      />
    </div>
  );
}

export default App;

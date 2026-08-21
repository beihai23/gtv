import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { SettingsProvider } from "./settings";
import { recordFrontendError } from "./issueContext";

// Global safety net: uncaught exceptions also land in the issue-report
// error ring buffer. Registered before mount so early render crashes count.
window.addEventListener("error", (e) => {
  recordFrontendError(`[window.error] ${e.message}`);
});
window.addEventListener("unhandledrejection", (e) => {
  recordFrontendError(`[unhandledrejection] ${String(e.reason)}`);
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </React.StrictMode>,
);

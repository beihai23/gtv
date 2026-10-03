// gtv VS Code webview bridge: re-implements the sliver of Tauri runtime the
// frontend touches on top of acquireVsCodeApi(). Mirrors mock.html's mock
// layer (the living contract): __TAURI_INTERNALS__.invoke /
// transformCallback / unregisterCallback, the plugin:event listen/unlisten
// pair, and __TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener — matching
// @tauri-apps/api v2.10's own mockIPC({ shouldMockEvents }).
(function () {
  const vscode = acquireVsCodeApi();
  const callbacks = new Map();      // cbId -> fn
  const listeners = new Map();      // event name -> [cbId]
  const pending = new Map();        // reqId -> {resolve, reject}
  let cbSeq = 0, reqSeq = 0, evtSeq = 0;

  function registerCallback(cb) {
    const id = ++cbSeq;
    callbacks.set(id, (data) => cb(data));
    return id;
  }
  function dispatch(event, payload) {
    for (const id of [...(listeners.get(event) ?? [])]) {
      const cb = callbacks.get(id);
      if (cb) cb({ event, id: ++evtSeq, payload });
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'response') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error !== undefined && m.error !== null) {
        p.reject(new Error(typeof m.error === 'string' ? m.error : JSON.stringify(m.error)));
      } else {
        p.resolve(m.value);
      }
    } else if (m.type === 'event') {
      dispatch(m.event, m.payload);
    }
  });

  // Diagnostics: webview-side failures cross to the host's log file.
  window.addEventListener('error', (e) => {
    try { vscode.postMessage({ type: 'gtv-webview-error', text: String(e.message || e.error) }); } catch {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { vscode.postMessage({ type: 'gtv-webview-error', text: 'unhandledrejection: ' + String(e.reason) }); } catch {}
  });

  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      return new Promise((resolve, reject) => {
        const id = ++reqSeq;
        pending.set(id, { resolve, reject });
        vscode.postMessage({ type: 'invoke', id, cmd, args: args ?? {} });
      });
    },
    transformCallback: registerCallback,
    unregisterCallback: (id) => callbacks.delete(id),
    registerCallback,
    unregister: (id) => callbacks.delete(id),
    convertFileSrc: (p) => p,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event, eventId) { callbacks.delete(eventId); },
  };

  // Host marker: the shared frontend branches on this for VS Code-only
  // behavior (the terminal button opens a VS Code integrated terminal
  // instead of the webview PTY panel, which this host does not provide).
  window.__GTV_HOST__ = 'vscode';

  // The invoke cases the bridge answers ITSELF (event plumbing is local);
  // everything else crosses to the extension host.
  const origInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = function (cmd, args) {
    if (cmd === 'plugin:event|listen') {
      const { event, handler } = args ?? {};
      const ids = listeners.get(event) ?? [];
      ids.push(handler);
      listeners.set(event, ids);
      return Promise.resolve(handler); // handler id doubles as the event id
    }
    if (cmd === 'plugin:event|unlisten') {
      const { event, eventId } = args ?? {};
      const ids = listeners.get(event) ?? [];
      const i = ids.indexOf(eventId);
      if (i >= 0) ids.splice(i, 1);
      return Promise.resolve(null);
    }
    return origInvoke(cmd, args);
  };
})();

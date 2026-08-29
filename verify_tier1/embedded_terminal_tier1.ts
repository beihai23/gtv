import { shouldToggleTerminal, normalizeSessionId } from '../src/terminalCore';

let failures = 0;
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) { console.log('ok   ' + name); return; }
  failures++;
  console.error('FAIL ' + name + (detail ? ' — ' + detail : ''));
};

check('ctrl+Backquote toggles', shouldToggleTerminal({ metaKey: false, ctrlKey: true, code: 'Backquote', repeat: false }));
check('meta+Backquote toggles (app convention)', shouldToggleTerminal({ metaKey: true, ctrlKey: false, code: 'Backquote', repeat: false }));
check('plain Backquote rejected', !shouldToggleTerminal({ metaKey: false, ctrlKey: false, code: 'Backquote', repeat: false }));
check('ctrl+other key rejected', !shouldToggleTerminal({ metaKey: false, ctrlKey: true, code: 'KeyA', repeat: false }));
check('auto-repeat ignored (no panel flicker)', !shouldToggleTerminal({ metaKey: false, ctrlKey: true, code: 'Backquote', repeat: true }));

check('normalizeSessionId(null) === null (mock.html contract)', normalizeSessionId(null) === null);
check('normalizeSessionId(7) === 7', normalizeSessionId(7) === 7);
check('normalizeSessionId("7") === null (strings rejected)', normalizeSessionId('7') === null);

if (failures > 0) throw new Error(failures + ' check(s) failed');
console.log('all embedded-terminal tier-1 checks passed');

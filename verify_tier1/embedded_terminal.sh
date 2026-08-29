#!/usr/bin/env bash
# Tier-1: Ctrl+` 内嵌终端 —— PTY 回环与 UTF-8 分块、git 目录监听（含 worktree）、
# 快捷键纯逻辑与 mock.html 降级契约。全部针对本任务新引入的实现，非通用烟雾测试。
set -euo pipefail
cd "$(dirname "$0")/.."

# A) Rust：PTY 生命周期 + UTF-8 分块 + repo watcher（真 fixture，非全仓套件）
(cd src-tauri && cargo test --test terminal_pty --test repo_watch_ext)

# B) TS 纯逻辑：快捷键匹配 + 会话 id 归一化（mock 下 ptySpawn 得 null 的契约）
mkdir -p verify_tier1
cat > verify_tier1/embedded_terminal_tier1.ts <<'EOF'
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
EOF
[ -d node_modules/typescript ] || npm ci --prefer-offline --no-audit --no-fund
rm -rf /tmp/gtv-terminal-tier1 && mkdir -p /tmp/gtv-terminal-tier1
./node_modules/.bin/tsc verify_tier1/embedded_terminal_tier1.ts src/terminalCore.ts \
  --outDir /tmp/gtv-terminal-tier1 --rootDir . --module commonjs --target es2020 \
  --lib es2020,dom --strict --skipLibCheck
node /tmp/gtv-terminal-tier1/verify_tier1/embedded_terminal_tier1.js

# C) 项目前端硬门：strict tsc + vite 集成（捕捉 api/types 漂移与未用局部）
npm run build

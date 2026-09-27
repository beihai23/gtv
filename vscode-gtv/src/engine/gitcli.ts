// Thin async wrapper over the system git CLI. The VS Code extension host
// has no git2 — all repository data comes from `git` subprocesses with the
// user's own environment (the same credential-fidelity decision as the
// desktop app's fetch path, 2026-09-18). Text decoding is UTF-8 with
// replacement; git speaks UTF-8 in practice and nothing here may crash on
// the odd latin-1 commit message.

import { spawn } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git without throwing. Callers that treat non-zero as data (rev-parse
 *  probes, checkouts with their own error text) use this directly. */
export function gitRaw(cwd: string, args: string[], timeoutMs = 30000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`git failed to spawn: ${e.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/** Run git expecting success: rejects with the stderr tail on non-zero. */
export async function git(cwd: string, args: string[], timeoutMs = 30000): Promise<string> {
  const r = await gitRaw(cwd, args, timeoutMs);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} exited ${r.code}${summarizeStderr(r.stderr)}`);
  }
  return r.stdout;
}

/** Same tail-collapse as the desktop's summarize_stderr: last few non-empty
 *  lines joined with " | ", capped keeping the END (git's decisive line is
 *  last). "" when stderr was empty. */
export function summarizeStderr(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
  if (lines.length === 0) return '';
  const tail = lines.slice(-3).join(' | ');
  const capped = tail.length > 200 ? '…' + tail.slice(-200) : tail;
  return `: ${capped}`;
}

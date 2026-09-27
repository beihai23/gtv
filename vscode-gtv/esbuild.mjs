// Build script for the gtv VS Code extension.
//   node esbuild.mjs            bundle the extension host (dist/extension.js)
//   node esbuild.mjs --sync-web also refresh media/ from the desktop app's
//                               vite build (runs `npm run build` at the repo
//                               root first, then copies dist/ + the icon)
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

if (process.argv.includes('--sync-web')) {
  execSync('npm run build', { cwd: path.join(here, '..'), stdio: 'inherit' });
  const dist = path.join(here, '..', 'dist');
  const media = path.join(here, 'media');
  for (const f of fs.readdirSync(media)) {
    if (f === 'bridge.js' || f === 'icon.png') continue; // extension-owned
    fs.rmSync(path.join(media, f), { recursive: true, force: true });
  }
  fs.cpSync(dist, media, { recursive: true, filter: (src) => {
    // the vite template's default public/ toys and the mock fixture are
    // dead weight in an extension bundle
    const base = path.basename(src);
    return base !== 'tauri.svg' && base !== 'vite.svg' && base !== 'mock-data.json';
  } });
  fs.copyFileSync(path.join(here, '..', 'docs', 'assets', 'logo.png'), path.join(media, 'icon.png'));
  console.log('media/ synced from ../dist + icon');
}

await build({
  entryPoints: [path.join(here, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(here, 'dist', 'extension.js'),
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  target: 'node20',
});
console.log('dist/extension.js built');

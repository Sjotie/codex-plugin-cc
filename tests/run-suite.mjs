// Give Unix sockets a short, fresh root even inside a deeply nested agent TMPDIR.
import fs from 'node:fs';
import { assertSocketPathBudget } from './socket-path-budget.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const inherited = { ...process.env };
if (process.platform === 'darwin') for (const key of ['TMPDIR', 'TMP', 'TEMP']) delete process.env[key];
const base = os.tmpdir();
Object.assign(process.env, inherited);
const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'cxc-')));
const here = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env, TMPDIR: root };
for (const key of ['CODEX_COMPANION_SESSION_ID', 'CLAUDE_PLUGIN_DATA']) delete env[key];
try {
  assertSocketPathBudget(root);
  const result = spawnSync(process.execPath, ['--import', path.join(here, 'generic-admission-setup.mjs'),
    '--test', ...(process.platform === 'darwin' ? ['--test-concurrency=2'] : []), ...process.argv.slice(2), ...fs.readdirSync(here).filter(name => name.endsWith('.test.mjs')).map(name => path.join(here, name))],
  { env, stdio: 'inherit', timeout: 15 * 60 * 1000 });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

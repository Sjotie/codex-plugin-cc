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
  const files = fs.readdirSync(here).filter(name => name.endsWith('.test.mjs'));
  let groups = [{ name: 'all', files, concurrency: null }];
  if (process.platform === 'darwin') {
    const requested = process.env.CODEX_TEST_FILE_CONCURRENCY;
    if (requested !== undefined && (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested)))) {
      throw new Error('CODEX_TEST_FILE_CONCURRENCY must be a positive integer');
    }
    const concurrency = requested === undefined ? Math.max(1, Math.floor(os.availableParallelism() / 2)) : Number(requested);
    const heavy = name => name.startsWith('state-lock-') || name === 'state-concurrency.test.mjs';
    groups = [
      { name: 'generic', files: files.filter(name => !heavy(name)), concurrency },
      { name: 'native-lock-stress', files: files.filter(heavy), concurrency: 1 }
    ];
  }
  for (const group of groups) {
    if (!group.files.length) continue;
    console.log(`TEST_GROUP ${group.name} files=${group.files.length} concurrency=${group.concurrency ?? 'node-default'}`);
    const result = spawnSync(process.execPath, ['--import', path.join(here, 'generic-admission-setup.mjs'),
      '--test', ...(group.concurrency === null ? [] : [`--test-concurrency=${group.concurrency}`]),
      ...process.argv.slice(2), ...group.files.map(name => path.join(here, name))],
    { env, stdio: 'inherit', timeout: 15 * 60 * 1000 });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { genericAdmission } from './generic-admission.mjs';
import { openFencedLock } from '../plugins/codex/scripts/lib/fenced-lock.mjs';
import { makeTempDir } from './helpers.mjs';

const fixture = new URL('./generic-admission.mjs', import.meta.url).href;
const core = new URL('../plugins/codex/scripts/lib/fenced-lock.mjs', import.meta.url).href;
test('prepared fixture admission is reusable while a real consumer holds the lock', t => {
  const dir = makeTempDir('fixture-admission-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fence = path.join(dir, 'state.lock');
  const options = { deadlineMs: 50, retryMs: 5 };
  const certificate = genericAdmission(fence, options);
  const lock = openFencedLock(fence, certificate);
  const handle = lock.acquire();
  try {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { genericAdmission } = await import(${JSON.stringify(fixture)});
      const { openFencedLock } = await import(${JSON.stringify(core)});
      const cert = genericAdmission(${JSON.stringify(fence)}, {deadlineMs:50,retryMs:5});
      const lock = openFencedLock(${JSON.stringify(fence)},cert);
      console.log(JSON.stringify({acquired:Boolean(lock.tryAcquire())}));
    `], { env: process.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { acquired: false }, 'certificate reuse must not bypass the held lock');
  } finally { lock.release(handle); }
});

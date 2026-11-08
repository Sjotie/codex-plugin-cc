import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrokerEndpoint, parseBrokerEndpoint } from '../plugins/codex/scripts/lib/broker-endpoint.mjs';
import { createBrokerSessionDir, ensureBrokerSession, sendBrokerShutdown, teardownBrokerSession } from '../plugins/codex/scripts/lib/broker-lifecycle.mjs';
import { removeBrokerSessionDir, sweepOrphanedBrokerSessionDirs } from '../plugins/codex/scripts/lib/broker-session-cleanup.mjs';
import { installFakeCodex, buildEnv } from './fake-codex-fixture.mjs';
import { makeTempDir } from './helpers.mjs';

for (const platform of ['darwin', 'linux']) {
  test(`${platform}: socket budget counts UTF-8 bytes and reports the path before listen`, () => {
    const dir = '/tmp/' + 'é'.repeat(60);
    assert.throws(() => createBrokerEndpoint(dir, platform), error =>
      error.code === 'EBROKERSOCKETPATH' && error.message.includes(dir) && error.message.includes(String(Buffer.byteLength(path.join(dir, 'broker.sock')))));
  });
}

test('long TMPDIR selects a private short broker directory that binds and cleans up', { skip: process.platform === 'win32' }, async t => {
  const fallbackRoot = makeTempDir('short-');
  t.after(() => fs.rmSync(fallbackRoot, { recursive: true, force: true }));
  const long = path.join(makeTempDir(), 'long-'.repeat(30));
  fs.mkdirSync(long);
  t.mock.method(os, 'tmpdir', () => long);
  const dir = createBrokerSessionDir(undefined, { fallbackRoot });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.notEqual(path.dirname(dir), long);
  for (const p of [dir, path.dirname(dir)]) {
    const stat = fs.lstatSync(p);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.uid, process.getuid());
    assert.equal(stat.mode & 0o777, 0o700);
  }
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(parseBrokerEndpoint(createBrokerEndpoint(dir)).path, resolve); });
  await new Promise(resolve => server.close(resolve));
  assert.equal(removeBrokerSessionDir(dir, { root: path.dirname(dir) }), true);
  const orphan = createBrokerSessionDir(undefined, { fallbackRoot });
  t.after(() => fs.rmSync(orphan, { recursive: true, force: true }));
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(orphan, old, old);
  assert.deepEqual((await sweepOrphanedBrokerSessionDirs({ tmpdir: path.dirname(orphan) })).removed, [orphan]);
});

test('unavailable short fallback reports the original path, bytes and underlying error', { skip: process.platform === 'win32' }, t => {
  const fallbackRoot = makeTempDir('short-');
  t.after(() => fs.rmSync(fallbackRoot, { recursive: true, force: true }));
  const long = path.join(makeTempDir(), 'long-'.repeat(30));
  fs.mkdirSync(long);
  t.mock.method(os, 'tmpdir', () => long);
  const mkdir = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', (dir, ...args) => {
    if (String(dir) === fallbackRoot) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    return mkdir.call(fs, dir, ...args);
  });
  assert.throws(() => createBrokerSessionDir(undefined, { fallbackRoot }), error => error.code === 'EBROKERSOCKETPATH' && error.message.includes(long) && /bytes/.test(error.message) && /EACCES/.test(error.message));
});

test('unsafe fallback root is refused without following it or creating a session there', { skip: process.platform === 'win32' }, t => {
  const fallbackRoot = makeTempDir('short-');
  t.after(() => fs.rmSync(fallbackRoot, { recursive: true, force: true }));
  const long = path.join(makeTempDir(), 'long-'.repeat(30));
  fs.mkdirSync(long);
  t.mock.method(os, 'tmpdir', () => long);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, ...args) => String(p) === fallbackRoot
    ? { isDirectory: () => false, uid: process.getuid(), mode: 0o777 }
    : lstat.call(fs, p, ...args));
  assert.throws(() => createBrokerSessionDir(undefined, { fallbackRoot }), /Unsafe broker fallback directory/);
});

test('a broker starts under long TMPDIR and removes its fallback session on shutdown', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const fallbackRoot = makeTempDir('short-');
  t.after(() => fs.rmSync(fallbackRoot, { recursive: true, force: true }));
  const long = path.join(makeTempDir(), 'nested-'.repeat(25));
  fs.mkdirSync(long);
  const bin = makeTempDir();
  installFakeCodex(bin);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = path.join(long, 'plugin-data');
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA; else process.env.CLAUDE_PLUGIN_DATA = previous; });
  t.mock.method(os, 'tmpdir', () => long);
  const env = { ...buildEnv(bin), TMPDIR: long, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
  const session = await ensureBrokerSession(long, { env, fallbackRoot });
  assert.ok(session, 'broker became ready');
  t.after(() => teardownBrokerSession(session));
  assert.notEqual(path.dirname(session.sessionDir), long);
  let outcome;
  for (let i = 0; i < 20; i++) {
    outcome = await sendBrokerShutdown(session.endpoint);
    if (outcome === 'accepted') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(outcome, 'accepted');
  const deadline = Date.now() + 5000;
  while (fs.existsSync(session.sessionDir) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(session.sessionDir), false, 'normal broker shutdown cleaned the fallback');
});

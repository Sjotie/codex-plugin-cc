// Generic state/CLI tests model a sealed test-owned domain, not Claude's
// provider transport. The native and SessionStart suites prove that transport.
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openFencedLock, drainCheck, sleepSync } from '../plugins/codex/scripts/lib/fenced-lock.mjs';
export function genericLockOptions(options) {
  const domain = () => ({ verdict: 'initial', scope: 'test-owned', reason: 'generic suite fixture' });
  return { ...options, domain, scanner: (actual) => {
    const scan = drainCheck({ ...actual, scanner: undefined, domain });
    let allowed = [];
    if (process.env.FENCED_LOCK_SCAN_SCOPE) allowed = fs.readFileSync(process.env.FENCED_LOCK_SCAN_SCOPE, 'utf8').trim().split('\n').map(Number);
    return { self: scan.self, processes: scan.processes.filter(p => allowed.includes(p.pid)) };
  } };
}
export function genericAdmission(fence, options) {
  const root = fs.realpathSync(os.tmpdir());
  const requested = path.resolve(path.dirname(fence));
  if (![root, path.resolve(os.tmpdir())].some(base => requested.startsWith(base + path.sep))) throw new Error("Generic admission fixture refuses non-temporary paths");
  fs.mkdirSync(requested, { recursive: true });
  const parent = fs.realpathSync(requested);
  if (!parent.startsWith(root + path.sep)) throw new Error('Generic admission fixture refuses state outside temporary storage');
  if (process.argv[1]?.includes("state-lock-") || process.env.WRITER_STATE_MJS || process.env.ACTOR_WORKSPACE) return options;
  if (fs.existsSync(fence) && fs.lstatSync(fence).isFile()) return options;
  const lock = openFencedLock(fence, { ...options,
    domain: () => ({ verdict: 'initial', scope: 'test-owned', reason: 'generic suite fixture' }),
    scanner: () => ({ self: { pid: process.pid, start: 'test-owned', matched: true }, processes: [] })
  });
  // A fixture seal is immutable. Share its certificate across processes just as
  // provider consumers share one SessionStart export; never prepare on every write.
  const cache = path.join(fence, 'fixture-admission.json');
  const identity = file => { const s = fs.statSync(file, { bigint: true }); return `${s.dev}:${s.ino}`; };
  const readCached = () => {
    try {
      const admission = JSON.parse(fs.readFileSync(cache, 'utf8'));
      const hash = createHash('sha256').update(fs.readFileSync(path.join(fence, 'fence.json'))).digest('hex');
      if (admission.fenceId === identity(fence) && admission.authority === identity(`${fence}.db`) && admission.recordHash === hash) return admission;
    } catch { /* Not prepared yet, or the fixture fence was replaced. */ }
    return null;
  };
  const deadline = performance.now() + (options.deadlineMs ?? 10000);
  for (;;) {
    const cached = readCached();
    if (cached) return { consumeAdmission: cached };
    const result = lock.prepareAdmission({ deadlineMs: 0 });
    if (result.ok) {
      const temporary = `${cache}.${process.pid}.${randomBytes(8).toString('hex')}`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(result.admission));
        fs.renameSync(temporary, cache);
      } finally { fs.rmSync(temporary, { force: true }); }
      return { consumeAdmission: result.admission };
    }
    if (performance.now() >= deadline) throw new Error(`Generic admission preparation: ${result.reason}`);
    sleepSync(options.retryMs ?? 50);
  }
}

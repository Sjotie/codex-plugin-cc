// Generic state/CLI tests model a sealed test-owned domain, not Claude's
// provider transport. The native and SessionStart suites prove that transport.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openFencedLock, drainCheck } from '../plugins/codex/scripts/lib/fenced-lock.mjs';
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
  const result = lock.prepareAdmission();
  if (!result.ok) throw new Error(`Generic admission preparation: ${result.reason}`);
  return { consumeAdmission: result.admission };
}

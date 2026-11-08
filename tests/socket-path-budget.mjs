import path from 'node:path';
// Production adds cxc-XXXXXX/broker.sock directly to os.tmpdir() (81 bytes
// in the measured Factory session). Fixtures add another directory: 128 bytes.
// A longer production TMPDIR is tracked separately in Factory #5081.
export function assertSocketPathBudget(root, platform = process.platform) {
  const endpoint = path.join(root, 'codex-plugin-test-XXXXXX', 'cxc-XXXXXX', 'broker.sock');
  const bytes = Buffer.byteLength(endpoint);
  if (platform === 'darwin' && bytes >= 104) {
    throw new Error(`Test socket path needs ${bytes} bytes; macOS sun_path allows fewer than 104. Use the short temporary root from tests/run-suite.mjs.`);
  }
}

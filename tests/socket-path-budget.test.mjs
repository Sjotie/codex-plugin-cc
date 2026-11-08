import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSocketPathBudget } from './socket-path-budget.mjs';
test('long macOS fixture socket paths fail with a path-budget diagnostic before listen', () => {
  assert.throws(() => assertSocketPathBudget('/tmp/' + 'x'.repeat(100), 'darwin'), /needs \d+ bytes; macOS sun_path allows fewer than 104/);
  assert.doesNotThrow(() => assertSocketPathBudget('/tmp/cxc-XXXXXX', 'darwin'));
});

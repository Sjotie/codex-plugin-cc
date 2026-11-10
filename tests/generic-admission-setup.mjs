// Explicit preload for generic tests; product entrypoints never import it.
// Native/provider contract suites own their receipts and run without these seams.
import { registerHooks } from 'node:module';
import path from 'node:path';
const entry = path.basename(process.argv[1] ?? '');
const dedicated = ['state-lock-macos.test.mjs', 'state-lock-session-start.test.mjs', 'wire-v2-only.test.mjs'].includes(entry);
if (process.platform === 'darwin' && !dedicated) {
  const target = new URL('../plugins/codex/scripts/lib/state.mjs', import.meta.url).href;
  const fixture = new URL('./generic-admission.mjs', import.meta.url).href;
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== target) return result;
    let source = String(result.source);
    const seams = [
      ['...consumerSessionOptions(fence, cwd)', '...genericAdmission(fence, options)'],
      ['    argvMatch: matchPluginArgv,', '    ...genericLockOptions({ argvMatch: matchPluginArgv }),'],
      ['export function activateFixedHookAdmission(input, event) {', 'export function activateFixedHookAdmission(input, event) { return null;'],
      ['export function completeFixedSessionEndAdmission(envelope) {', 'export function completeFixedSessionEndAdmission(envelope) { return;']
    ];
    for (const [original, replacement] of seams) {
      if (source.split(original).length !== 2) throw new Error(`Generic admission fixture seam changed: ${original}`);
      source = source.replace(original, replacement);
    }
    return { ...result, source: `import { genericAdmission, genericLockOptions } from ${JSON.stringify(fixture)};\n` + source };
  } });
  const option = `--import=${import.meta.url}`;
  if (!(process.env.NODE_OPTIONS ?? '').includes(option)) process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${option}`.trim();
}

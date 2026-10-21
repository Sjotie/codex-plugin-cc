// Check expiry of this owned fixture's saved session admission.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDecipheriv, createHash } from "node:crypto";

const root = process.argv[2];
if (process.env.FENCED_LOCK_NATIVE_ROOT !== root) throw new Error("owned replay root required");
const cipherFile = process.argv[3];
if (!cipherFile || path.dirname(cipherFile) !== root) throw new Error("encrypted owned capture required");
let captured;
try {
  const encrypted = JSON.parse(fs.readFileSync(cipherFile, "utf8"));
  if (encrypted.version !== 1 || encrypted.algorithm !== "aes-256-gcm") throw new Error("unknown fixture capture format");
  const key = Buffer.from(process.env.FENCED_LOCK_NATIVE_CAPTURE_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("fixture capture key unavailable");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  captured = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8"));
} catch {
  console.log(JSON.stringify({ captureValid: false, inconclusive: true, acquired: null, rule: "encrypted-capture-unavailable-or-invalid" }));
  process.exit(0);
}
for (const name of ["CODEX_COMPANION_LOCK_ADMISSION", "CODEX_COMPANION_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CONFIG_DIR", "CLAUDE_PLUGIN_DATA"]) {
  if (typeof captured[name] === "string") process.env[name] = captured[name]; else delete process.env[name];
}
const state = await import(pathToFileURL(path.join(root, "plugin/scripts/lib/state.mjs")));
const file = state.resolveStateFile(root);
const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const envelope = JSON.parse(process.env.CODEX_COMPANION_LOCK_ADMISSION ?? "null");
const sha = (value) => createHash("sha256").update(String(value)).digest("hex");
const lock = state.openStateLock(root);
let handle = null, refusal = null;
try { handle = lock.acquire({ deadlineMs: 0 }); }
catch (error) {
  const reason = String(error.reason ?? "");
  const allowed = ["admission certificate missing or malformed", "session generation pending, revoked or foreign", "provider receipt token mismatch", "latest provider receipt not proven"];
  refusal = { name: error.name, code: error.code ?? null, rule: allowed.find((literal) => reason.includes(literal)) ?? "other-refusal", reasonSha256: createHash("sha256").update(reason).digest("hex") };
}
if (handle) lock.release(handle);
const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
const label = process.argv[4];
if (label && /^[A-Za-z0-9._-]+$/.test(label)) fs.writeFileSync(path.join(root, `${label}.diagnosis.json`), JSON.stringify({ identity: "captured-session-counterfactual", generation: envelope?.generation ?? null, source: envelope?.source ?? null, nativeSessionSha256: sha(process.env.CLAUDE_CODE_SESSION_ID ?? ""), fullEnvelopeSha256: sha(process.env.CODEX_COMPANION_LOCK_ADMISSION ?? ""), baseCertificateSha256: sha(JSON.stringify(envelope?.admission ?? null)), acquired: Boolean(handle), refusal, stateUnchanged: before === after, pid: process.pid }), { mode: 0o600 });
console.log(JSON.stringify({ captureValid: true, acquired: Boolean(handle), stateUnchanged: before === after, refusal }));

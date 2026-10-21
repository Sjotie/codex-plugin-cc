// Fixed SessionStart -> Bash/Stop/SessionEnd certificate transport. This file
// never scans processes or grants without the existing fenced-lock authority.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const STATE_LOCK_ADMISSION_ENV = "CODEX_COMPANION_LOCK_ADMISSION";
export const SESSION_START_COMMAND = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs" SessionStart';
// Wire version of the exported envelope. Version 2 carried a generation;
// version 3 carries the stable capability C and no source (#1916, LOW-6).
export const ENVELOPE_VERSION = 3;
const SOURCES = new Set(["startup", "resume", "compact", "clear"]);
const HEX64 = /^[a-f0-9]{64}$/;
const RECEIPT_ADAPTER = "session-start-hook-success-v1";
const PROVIDER = "claude-code";
const MANIFEST = new URL("./provider-receipts.json", import.meta.url);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const identity = (st) => `${st.dev}:${st.ino}:${st.birthtimeNs}`;
const fail = (message) => { throw new Error(`Session admission refused: ${message}`); };
// The receipt of the attempt being checked is not recorded yet. A refusal
// like any other; it only tells a waiting consumer that waiting may help.
const notYet = (message) => { throw Object.assign(new Error(`Session admission refused: ${message}`), { receiptPending: true }); };

// Proven provider versions are reviewed data, not code (LOW-7). Exactly one
// entry must match version, platform and process.arch; anything missing,
// corrupt or contradictory refuses.
let manifest = null;
function provenEntries() {
  if (manifest) return manifest;
  let data;
  try { data = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { fail("provider receipt manifest missing or corrupt"); }
  const text = (v) => typeof v === "string" && v.length > 0;
  if (data?.schema !== "codex-companion-provider-receipts-v1" || !Array.isArray(data.entries)) fail("provider receipt manifest malformed");
  const keys = new Set();
  for (const e of data.entries) {
    if (!e || e.provider !== PROVIDER || !/^\d+\.\d+\.\d+$/.test(e.version ?? "") || !text(e.platform) || !text(e.arch) ||
      !text(e.receiptAdapter) || !HEX64.test(e.binarySha256 ?? "") || !/^[a-f0-9]{40}$/.test(e.evidenceCommit ?? "") ||
      !text(e.evidenceSummary) || !HEX64.test(e.evidenceSummarySha256 ?? "") || !text(e.fixtures) || !HEX64.test(e.fixturesSha256 ?? "")) fail("provider receipt manifest entry malformed");
    const key = `${e.version}|${e.platform}|${e.arch}`;
    if (keys.has(key)) fail(`provider receipt manifest lists ${key} twice`);
    keys.add(key);
  }
  manifest = data.entries;
  return manifest;
}

export function providerVersionProven(version) {
  return provenEntries().some((e) => e.version === version && e.platform === process.platform && e.arch === process.arch && e.receiptAdapter === RECEIPT_ADAPTER);
}

function requireProvenVersion(version) {
  if (!providerVersionProven(version)) fail(`provider version unproven (${PROVIDER} ${typeof version === "string" ? version.slice(0, 32) : "unknown"} on ${process.platform}/${process.arch})`);
}

export function resolveAdmissionStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try { canonical = fs.realpathSync.native(workspaceRoot); } catch { /* same fallback as state resolution */ }
  const slug = (path.basename(workspaceRoot) || "workspace").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const stateRoot = process.env.CLAUDE_PLUGIN_DATA ? path.join(process.env.CLAUDE_PLUGIN_DATA, "state") : path.join(os.tmpdir(), "codex-companion");
  return path.join(stateRoot, `${slug}-${hash(canonical).slice(0, 16)}`);
}

function providerRoot(create = false) {
  const requested = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  if (!path.isAbsolute(requested)) fail("provider config root is not absolute");
  if (create) fs.mkdirSync(requested, { recursive: true });
  return fs.realpathSync(requested);
}

function locatorPath(sessionId, create = false) {
  if (typeof sessionId !== "string" || !sessionId) fail("native session id missing");
  const configRoot = providerRoot(create);
  const dir = path.join(configRoot, "codex-companion-session-admission");
  if (create) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { configRoot, file: path.join(dir, `${hash(sessionId)}.json`) };
}

// A fresh Claude session may not have created its transcript or project
// directory yet. Bind its one exact future path; only ENOENT permits walking
// to an existing ancestor. The hook never creates a transcript directory.
export function bindTranscriptPath(file) {
  if (!path.isAbsolute(file ?? "")) fail("transcript path is not absolute");
  let current = path.resolve(file);
  const missing = [];
  for (;;) {
    try {
      const existing = fs.realpathSync(current);
      const st = fs.statSync(existing);
      if (missing.length ? !st.isDirectory() : !st.isFile()) fail("transcript path has an unexpected object");
      return path.join(existing, ...missing);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function epochFor(locator) {
  return hash(JSON.stringify([locator.nonce, locator.locatorId, locator.configRoot, locator.sessionId, locator.root, locator.fence, locator.transcriptPath, locator.cwd]));
}

function sameLocator(a, b) {
  return ["version", "sessionId", "bindingEpoch", "locatorId", "configRoot", "root", "fence", "transcriptPath", "cwd", "nonce"].every((key) => a?.[key] === b?.[key]);
}

export function readSessionLocator(sessionId) {
  let configRoot, file;
  try { ({ configRoot, file } = locatorPath(sessionId)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile()) fail("locator is not a regular file");
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (value?.version !== 1 || value.sessionId !== sessionId || value.configRoot !== configRoot ||
      value.locatorId !== identity(st) || typeof value.nonce !== "string" || !/^[a-f0-9]{64}$/.test(value.nonce) ||
      !path.isAbsolute(value.root ?? "") || value.fence !== path.join(value.root, "state.lock") ||
      !path.isAbsolute(value.transcriptPath ?? "") || !path.isAbsolute(value.cwd ?? "") || value.bindingEpoch !== epochFor(value)) fail("locator corrupt or replaced");
    return value;
  } finally { fs.closeSync(fd); }
}

export function createSessionLocator(sessionId, fence, transcriptPath, cwd) {
  const { configRoot, file } = locatorPath(sessionId, true);
  fs.mkdirSync(path.dirname(fence), { recursive: true });
  const root = fs.realpathSync(path.dirname(fence));
  const transcript = bindTranscriptPath(transcriptPath);
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { if (error.code === "EEXIST") return readSessionLocator(sessionId); throw error; }
  try {
    const locator = { version: 1, sessionId, nonce: randomBytes(32).toString("hex"), configRoot,
      locatorId: identity(fs.fstatSync(fd, { bigint: true })), root, fence: path.join(root, "state.lock"), transcriptPath: transcript, cwd: fs.realpathSync(cwd) };
    locator.bindingEpoch = epochFor(locator);
    fs.writeFileSync(fd, `${JSON.stringify(locator)}\n`);
    fs.fsyncSync(fd);
    return locator;
  } finally { fs.closeSync(fd); }
}

export function bindingCheck(locator) {
  return (ctx) => {
    const now = readSessionLocator(locator.sessionId);
    return sameLocator(now, locator) && ctx.sessionId === locator.sessionId && ctx.bindingEpoch === locator.bindingEpoch &&
      (!ctx.admission || ctx.admission.fence === locator.fence);
  };
}

// expected = {capabilityId, attemptId, source}; source null accepts the
// source the receipt names. Returns the token of exactly this attempt.
export function readSessionReceipt(locator, expected) {
  // Read every complete line; malformed or partial provider output is unknown.
  // No cache: a later failed SessionStart must revoke an older success receipt.
  let text;
  try {
    if (fs.realpathSync(locator.transcriptPath) !== locator.transcriptPath || !fs.lstatSync(locator.transcriptPath).isFile()) fail("provider transcript path changed or is not a regular file");
    text = fs.readFileSync(locator.transcriptPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") notYet("provider transcript not created yet");
    throw error;
  }
  if (!text || !text.endsWith("\n")) notYet("provider transcript incomplete");
  let latest = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    const a = r?.attachment;
    // This provider record conveys context, not hook completion. It can never
    // grant admission; only a separate, fully validated completion may do so.
    if (a?.command !== SESSION_START_COMMAND && r?.type === "attachment" && typeof r.version === "string" && providerVersionProven(r.version) &&
      r.sessionId === locator.sessionId && r.isSidechain === false && path.isAbsolute(r.cwd ?? "") &&
      fs.realpathSync(r.cwd) === locator.cwd && a?.type === "hook_additional_context" &&
      a.hookEvent === "SessionStart" && a.hookName === "SessionStart" &&
      Array.isArray(a.content) && a.content.length === 1 && typeof a.content[0] === "string" && typeof a.toolUseID === "string" &&
      !Object.hasOwn(a, "command") && !Object.hasOwn(a, "exitCode")) continue;
    if (a?.command === SESSION_START_COMMAND || (r?.type === "attachment" && (a?.hookEvent === "SessionStart" || a?.hookName === "SessionStart" || String(a?.hookName ?? "").startsWith("SessionStart:")))) {
      // Other configured hooks have their own command and cannot confirm or
      // invalidate our attempt. An unidentified command remains unknown.
      if (typeof a.command === "string" && a.command.trim() !== "" && a.command !== SESSION_START_COMMAND) continue;
      latest = r;
    }
  }
  if (!latest) notYet("no SessionStart receipt recorded yet");
  const a = latest.attachment;
  let output = null;
  try { output = JSON.parse(a?.stdout); } catch { output = null; }
  const token = output?.codexStateLockAdmission ?? null;
  const ours = typeof token?.attemptId === "string" && token.attemptId === expected?.attemptId;
  if (latest.type !== "attachment" || a?.type !== "hook_success" || a.hookEvent !== "SessionStart" || a.exitCode !== 0 || a.command !== SESSION_START_COMMAND) {
    // Our own command failed or crashed. With this attempt's token the failure
    // is this attempt's; without one it may belong to an earlier attempt.
    if (!ours && latest.type === "attachment" && a?.command === SESSION_START_COMMAND) notYet("latest receipt belongs to an earlier attempt");
    fail("latest provider receipt not proven");
  }
  requireProvenVersion(latest.version);
  if (latest.sessionId !== locator.sessionId || latest.isSidechain !== false ||
    !path.isAbsolute(latest.cwd ?? "") || fs.realpathSync(latest.cwd) !== locator.cwd) fail("latest provider receipt not proven");
  if (!ours) {
    // A complete success of another attempt: this attempt has none yet.
    if (typeof token?.attemptId === "string" && HEX64.test(token.attemptId)) notYet("receipt of this attempt not recorded yet");
    fail("provider receipt token mismatch");
  }
  if (output.continue !== true || output.suppressOutput !== true || token.capabilityId !== expected.capabilityId ||
    token.sessionId !== locator.sessionId || token.root !== locator.root || !SOURCES.has(token.source) ||
    a.hookName !== `SessionStart:${token.source}` || (expected.source != null && token.source !== expected.source)) fail("provider receipt token mismatch");
  return token;
}

export function sessionChecks(locator) {
  return { sessionBindingCheck: bindingCheck(locator), sessionReceiptCheck: (ctx) => {
    if (!bindingCheck(locator)(ctx)) return false;
    try {
      readSessionReceipt(locator, { capabilityId: ctx.capabilityId, attemptId: ctx.attemptId, source: ctx.source ?? null });
    } catch (error) {
      if (error?.receiptPending === true) return "pending";
      throw error;
    }
    return true;
  } };
}

export function validStartInput(input) {
  if (!input || !path.isAbsolute(input.cwd ?? "") || !path.isAbsolute(input.transcript_path ?? "") ||
    typeof input.session_id !== "string" || input.session_id !== process.env.CLAUDE_CODE_SESSION_ID || !SOURCES.has(input.source)) fail("SessionStart identity, root or source unknown");
}

// The capability C is stable over a successful compact. It is unpredictable
// but not a secret: it only works together with the authority row, the base
// certificate, the locator binding and the current attempt's receipt.
export function envelopeFor(locator, capability) {
  return { version: ENVELOPE_VERSION, sessionId: locator.sessionId, bindingEpoch: locator.bindingEpoch, capabilityId: capability.id,
    root: locator.root, transcriptPath: locator.transcriptPath, configRoot: locator.configRoot, admission: capability.admission };
}

const ENVELOPE_KEYS = ["version", "sessionId", "bindingEpoch", "capabilityId", "root", "transcriptPath", "configRoot", "admission"];

export function consumerSessionOptions(fencePath) {
  let envelope = null;
  let locator = null;
  try {
    envelope = JSON.parse(process.env[STATE_LOCK_ADMISSION_ENV] ?? "null");
    const session = process.env.CODEX_COMPANION_SESSION_ID;
    // attemptId only in an activation of a fixed Stop/SessionEnd hook.
    const keys = Object.keys(envelope ?? {}).filter((key) => key !== "attemptId");
    if (envelope?.version !== ENVELOPE_VERSION || keys.length !== ENVELOPE_KEYS.length || !ENVELOPE_KEYS.every((key) => keys.includes(key)) ||
      !HEX64.test(envelope.capabilityId ?? "") || (Object.hasOwn(envelope, "attemptId") && !HEX64.test(envelope.attemptId ?? "")) ||
      !session || session !== process.env.CLAUDE_CODE_SESSION_ID || envelope.sessionId !== session ||
      envelope.root !== fs.realpathSync(path.dirname(fencePath))) fail("consumer session root mismatch");
    locator = readSessionLocator(session);
    if (!locator || locator.bindingEpoch !== envelope.bindingEpoch || locator.root !== envelope.root ||
      locator.configRoot !== envelope.configRoot || locator.transcriptPath !== envelope.transcriptPath || locator.fence !== path.join(fs.realpathSync(path.dirname(fencePath)), path.basename(fencePath))) fail("consumer locator mismatch");
  } catch {
    envelope = null;
    locator = null;
  }
  return {
    consumeAdmission: envelope?.admission ?? null,
    consumeSessionAdmission: envelope ? { sessionId: envelope.sessionId, bindingEpoch: envelope.bindingEpoch, capabilityId: envelope.capabilityId,
      ...(Object.hasOwn(envelope, "attemptId") ? { attemptId: envelope.attemptId } : {}) } : null,
    ...(locator ? sessionChecks(locator) : { sessionBindingCheck: () => false, sessionReceiptCheck: () => false })
  };
}

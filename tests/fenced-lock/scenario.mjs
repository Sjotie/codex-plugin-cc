// Test-side helpers for the state-lock race tests (#1916): one temp root per
// scenario with its own plugin data, workspace and barrier directory, real
// writer processes (tests/fenced-lock/writer.mjs) and an external probe of
// the kernel lock.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { stateMjsFor } from "./old-trees.mjs";

const WRITER = fileURLToPath(new URL("./writer.mjs", import.meta.url));

// Which state.mjs the writers under test load: "new" (this checkout), "o1" or "o2".
export const IMPL = process.env.STATE_LOCK_TEST_IMPL ?? "new";

export function scenario(t, { pluginData: sharedPluginData } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-race-"));
  const workspace = path.join(root, "workspace");
  const barriers = path.join(root, "barriers");
  const pluginData = sharedPluginData ?? path.join(root, "plugin-data");
  fs.mkdirSync(workspace);
  fs.mkdirSync(barriers);
  const children = [];
  const eventPath = (event) => path.join(barriers, event);
  const has = (event) => fs.existsSync(eventPath(event));
  const signal = (event) => fs.writeFileSync(eventPath(event), "");
  const errors = () =>
    fs
      .readdirSync(barriers)
      .filter((name) => name.endsWith(".error"))
      .map((name) => `${name}: ${fs.readFileSync(eventPath(name), "utf8")}`);
  const wait = async (events, { timeoutMs = 15_000 } = {}) => {
    const list = Array.isArray(events) ? events : [events];
    const deadline = Date.now() + timeoutMs;
    while (!list.some(has)) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${list.join(" or ")}; errors: ${errors().join("\n") || "none"}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return list.find(has);
  };
  const childEnv = (extra = {}) => ({
    ...process.env,
    CLAUDE_PLUGIN_DATA: pluginData,
    ...extra
  });

  const start = (role, { impl = IMPL, mode = "owner", gates = {}, linkError, nodePath } = {}) => {
    const child = spawn(nodePath ?? process.execPath, [WRITER], {
      env: childEnv({
        WRITER_STATE_MJS: stateMjsFor(impl),
        WRITER_WORKSPACE: workspace,
        WRITER_BARRIERS: barriers,
        WRITER_ROLE: role,
        WRITER_MODE: mode,
        WRITER_GATES: JSON.stringify(gates),
        ...(linkError ? { WRITER_LINK_ERROR: linkError } : {})
      }),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.resume();
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, sig) => resolve({ code, signal: sig, stderr }));
    });
    const handle = { role, child, exit, pid: child.pid };
    children.push(handle);
    return handle;
  };

  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
    }
    await Promise.all(children.map(({ exit }) => exit));
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { root, workspace, barriers, pluginData, has, signal, wait, start, errors, childEnv };
}

// An external process that tries to take the new kernel lock once and reports
// "held" (BUSY), "free", or the error. Only an external process can prove that
// a holder really holds the fcntl lock (P5, P12).
export function probeKernelLock(dbPath) {
  const script = `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    try { db.exec("BEGIN EXCLUSIVE"); db.exec("COMMIT"); console.log("free"); }
    catch (e) { console.log((e.errcode & 0xff) === 5 ? "held" : "error:" + e.message); }
    finally { db.close(); }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, dbPath], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" }
  });
  return result.stdout.trim() || `error:${result.stderr.trim()}`;
}

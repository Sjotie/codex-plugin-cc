// The two released lock protocols (#1916), taken from git at their exact
// release commits, so the race tests run the old code byte for byte.
//   o1: c5fc9a5, 1.0.7-sjotie.21 (open(wx), the protocol of .13 to .21)
//   o2: 81333c0, 1.0.7-sjotie.22 (link publication, #1822)
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const OLD_PROTOCOLS = {
  o1: { ref: "c5fc9a5", stateSha256: "050f895b233195b918de439bcfb87a96ac1599d54991d306d3d1da022d04dd2d" },
  o2: { ref: "81333c0", stateSha256: "b52c238b5a9bda7dc4ab21129286df05b7f1513035c4e3fceaf211b0adbcf8c5" }
};

const STATE_REL = path.join("plugins", "codex", "scripts", "lib", "state.mjs");

export function oldStateMjs(which) {
  const spec = OLD_PROTOCOLS[which];
  if (!spec) throw new Error(`unknown old protocol ${which}`);
  const full = execFileSync("git", ["rev-parse", `${spec.ref}^{commit}`], { cwd: REPO, encoding: "utf8" }).trim();
  const dir = path.join(os.tmpdir(), `fenced-lock-old-${full.slice(0, 12)}-plugin`);
  const stateFile = path.join(dir, STATE_REL);
  if (!fs.existsSync(stateFile)) {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "fenced-lock-old-staging-"));
    execFileSync("sh", ["-c", `git archive --format=tar "$1" plugins/codex | tar -x -C "$2"`, "sh", full, staging], {
      cwd: REPO
    });
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      // Another test process materialized it first.
      fs.rmSync(staging, { recursive: true, force: true });
      if (!fs.existsSync(stateFile)) throw error;
    }
  }
  const actual = createHash("sha256").update(fs.readFileSync(stateFile)).digest("hex");
  if (actual !== spec.stateSha256) {
    throw new Error(`${which} state.mjs at ${spec.ref} has sha256 ${actual}, expected ${spec.stateSha256}`);
  }
  return stateFile;
}

export function stateMjsFor(impl) {
  if (impl === "new") return path.join(REPO, STATE_REL);
  return oldStateMjs(impl);
}

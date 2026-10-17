import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { isProcessAlive } from "./process.mjs";

export const BROKER_SESSION_DIR_PREFIX = "cxc-";
// fs.mkdtempSync appends exactly six characters from [A-Za-z0-9].
const BROKER_SESSION_DIR_PATTERN = /^cxc-[A-Za-z0-9]{6}$/;
// A live broker's directory mtime can be arbitrarily old (nothing is created in it after
// start), so age only gates the check; it never proves death.
export const ORPHAN_SESSION_MIN_AGE_MS = 60 * 60 * 1000;
const ENDPOINT_PROBE_TIMEOUT_MS = 500;

export function isBrokerSessionDirName(name) {
  return BROKER_SESSION_DIR_PATTERN.test(name);
}

const BROKER_LOG_FILE = "broker.log";

/**
 * Removes a broker session directory. Refuses anything that is not a real
 * directory (never a symlink) named like a broker session directory.
 * The directory must be a direct child of root (default os.tmpdir(), compared by realpath),
 * so a look-alike name elsewhere is never touched.
 * With keepLog the directory stays and only broker.log is left in it, so the cause of a
 * failed exit remains readable until the next start's sweep removes the directory.
 * @returns {boolean} whether the directory (or, with keepLog, its other contents) was removed
 */
export function removeBrokerSessionDir(dir, { keepLog = false, root = os.tmpdir() } = {}) {
  try {
    if (!dir || !isBrokerSessionDirName(path.basename(dir))) {
      return false;
    }
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) {
      return false;
    }
    const realRoot = fs.realpathSync(root);
    const realParent = fs.realpathSync(path.dirname(dir));
    if (realParent !== realRoot) {
      return false;
    }
    if (keepLog) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry !== BROKER_LOG_FILE) {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        }
      }
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } else {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

export function readBrokerPidFile(dir) {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(dir, "broker.pid"), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Resolves true only when connecting is refused or the endpoint is gone; a timeout
// or any other error counts as "may be alive", so the directory is kept.
function isEndpointUnreachable(endpoint, timeoutMs) {
  return new Promise((resolve) => {
    let target;
    try {
      target = parseBrokerEndpoint(endpoint);
    } catch {
      resolve(false);
      return;
    }
    const socket = net.createConnection({ path: target.path });
    const finish = (unreachable) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(unreachable);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => finish(false));
    socket.on("error", (/** @type {NodeJS.ErrnoException} */ error) =>
      finish(error?.code === "ENOENT" || error?.code === "ECONNREFUSED")
    );
  });
}

/**
 * Removes broker session directories whose broker is provably dead: the directory is
 * ours, a real directory (not a symlink), named like mkdtemp output, older than
 * minAgeMs, its pid file names no live process, and nothing answers on its endpoint.
 * Never throws.
 * @returns {Promise<{ removed: string[], kept: number }>}
 */
export async function sweepOrphanedBrokerSessionDirs({
  tmpdir = os.tmpdir(),
  minAgeMs = ORPHAN_SESSION_MIN_AGE_MS,
  now = Date.now(),
  uid = typeof process.getuid === "function" ? process.getuid() : null,
  platform = process.platform,
  probeTimeoutMs = ENDPOINT_PROBE_TIMEOUT_MS
} = {}) {
  const removed = [];
  let kept = 0;
  let names;
  try {
    names = fs.readdirSync(tmpdir);
  } catch {
    return { removed, kept };
  }
  for (const name of names) {
    if (!isBrokerSessionDirName(name)) {
      continue;
    }
    const dir = path.join(tmpdir, name);
    try {
      const stat = fs.lstatSync(dir);
      const ours = uid === null || stat.uid === uid;
      const dead =
        stat.isDirectory() &&
        ours &&
        now - stat.mtimeMs >= minAgeMs &&
        !isProcessAlive(readBrokerPidFile(dir)) &&
        (await isEndpointUnreachable(createBrokerEndpoint(dir, platform), probeTimeoutMs));
      if (dead && removeBrokerSessionDir(dir, { root: tmpdir })) {
        removed.push(dir);
      } else {
        kept += 1;
      }
    } catch {
      kept += 1;
    }
  }
  return { removed, kept };
}

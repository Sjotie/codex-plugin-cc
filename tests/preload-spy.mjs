// Test preload (#1762 installer): logs every process.kill call and the environment keys of every child_process.spawn.
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const log = process.env.CX1762_SPY_LOG;
const write = (row) => fs.appendFileSync(log, JSON.stringify(row) + "\n");
const kill = process.kill.bind(process);
process.kill = (pid, sig) => { write({ kind: "process.kill", pid, sig: sig ?? "SIGTERM" }); return kill(pid, sig); };
const spawn = cp.spawn;
cp.spawn = function (file, argv, options) {
  write({ kind: "spawn", file, envKeys: Object.keys(options?.env ?? process.env).sort() });
  return spawn.apply(this, arguments);
};
syncBuiltinESMExports();

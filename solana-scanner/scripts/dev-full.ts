/**
 * One command for local development: the wallet history backend
 * (server/index.ts, reads .env server-side) and the Vite dev server, which
 * forwards /api to it. Ctrl+C stops both. No secret is printed or passed to Vite.
 *
 *   npm run dev:full
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";

const children: ChildProcess[] = [];
const start = (name: string, cmd: string, args: string[]) => {
  const child = spawn(cmd, args, { stdio: "inherit" });
  child.on("exit", (code) => {
    console.log(`[dev:full] ${name} stopped (${code ?? "signal"})`);
    stop(code ?? 0);
  });
  children.push(child);
};
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start("backend", process.execPath, ["--experimental-strip-types", "--no-warnings", "server/index.ts"]);
start("vite", process.execPath, [join("node_modules", "vite", "bin", "vite.js")]);

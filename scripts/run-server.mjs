import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findChangedBuildFile } from "../packages/server/scripts/write-build-meta.mjs";

const SERVER_ROOT = fileURLToPath(new URL("../packages/server/", import.meta.url));
// Only the launchers' own build is checked; a private build that a developer tool starts is left alone.
const startsServerBuild = process.argv.slice(2).some((arg) => relative(join(SERVER_ROOT, "dist"), arg) === "index.js");

// #6984: a built file changed after its build (a damaged write, an edit) stops every start, and the
// launchers rebuild only when the version or commit changes. Rebuild before starting instead.
// ponytail: only the server's own build records hashes, so a damaged packages/shared or client file is
// not caught here. If that shows up, record hashes in those builds too and check them the same way.
async function rebuildChangedServer() {
  const changed = startsServerBuild ? findChangedBuildFile() : null;
  if (!changed) return true;
  process.stderr.write(
    `\n  [WARN] A server file was changed or damaged after it was built: dist/${changed}\n  [..] Rebuilding the server. This can take a minute...\n\n`,
  );
  // The build is the current child, so a stop reaches it the same way it reaches the server.
  child = spawn(process.execPath, [join(SERVER_ROOT, "scripts", "build.mjs")], {
    cwd: SERVER_ROOT,
    stdio: "inherit",
  });
  const code = await exitCode(child);
  if (stopping) return false;
  if (code === 0) return true;
  process.stderr.write(
    "\n  [ERROR] Could not rebuild the server. See the error above, then reinstall Marinara Engine or run: pnpm build\n\n",
  );
  return false;
}

function exitCode(proc) {
  return new Promise((resolve) => {
    proc.once("error", (error) => {
      process.stderr.write(`Could not start Marinara Engine: ${error.message}\n`);
      resolve(1);
    });
    proc.once("close", (status, signal) => resolve(status ?? 128 + (constants.signals[signal] ?? 0)));
  });
}

// Keep restart ownership in the launcher's console. Start the replacement only
// after the old process exits, releasing its port and storage writer lease.
let child;
let stopping = false;
let stopTimer;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    // Windows already broadcasts console Ctrl+C to the server. child.kill()
    // force-terminates it there, preventing its graceful shutdown from flushing saves.
    // POSIX still needs forwarding for signals addressed only to this launcher.
    if (process.platform !== "win32") child?.kill(signal);
    stopTimer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    stopTimer.unref();
  });
}

while (true) {
  if (!(await rebuildChangedServer())) {
    process.exitCode = stopping ? 130 : 1;
    break;
  }
  child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, MARINARA_RESTART_SUPERVISOR: String(process.pid) },
  });
  const code = await exitCode(child);
  if (stopping || code !== 75) {
    clearTimeout(stopTimer);
    process.exitCode ??= code;
    break;
  }
}

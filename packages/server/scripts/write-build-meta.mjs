import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const DIST_DIR = resolve(PACKAGE_ROOT, "dist");
const BUILD_META_FILE = "config/build-meta.json";
const COMMIT_LENGTH = 12;
// Files Node loads as code. Source maps, type declarations and media cannot stop the server from starting.
const CODE_FILE = /\.(?:[cm]?js|json)$/u;

function normalizeCommit(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, COMMIT_LENGTH);
}

function resolveCommit() {
  const envCommit = normalizeCommit(process.env.MARINARA_GIT_COMMIT ?? process.env.GITHUB_SHA);
  if (envCommit) return envCommit;

  try {
    return normalizeCommit(
      execFileSync("git", ["rev-parse", `--short=${COMMIT_LENGTH}`, "HEAD"], {
        cwd: MONOREPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Records the build's commit and the SHA-256 of every built code file, so later changes can be found (#6984).
 * A failed build records no commit, so the launchers still treat it as stale and build again.
 */
export function writeBuildMeta({ failed = false } = {}) {
  const files = {};
  for (const entry of readdirSync(DIST_DIR, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !CODE_FILE.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    const file = relative(DIST_DIR, path).split(sep).join("/");
    if (file !== BUILD_META_FILE) files[file] = hashFile(path);
  }
  mkdirSync(join(DIST_DIR, "config"), { recursive: true });
  writeFileSync(
    join(DIST_DIR, BUILD_META_FILE),
    `${JSON.stringify({ commit: failed ? null : resolveCommit(), builtAt: new Date().toISOString(), files }, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Compares dist with the hashes its build recorded. Returns the first missing or changed file, null when
 * every file matches, or undefined when no hashes were recorded (a build from before this check).
 */
export function findChangedBuildFile() {
  let files;
  try {
    ({ files } = JSON.parse(readFileSync(join(DIST_DIR, BUILD_META_FILE), "utf8")));
  } catch {
    return undefined;
  }
  if (!files || typeof files !== "object") return undefined;
  for (const [file, hash] of Object.entries(files)) {
    try {
      if (hashFile(join(DIST_DIR, file)) !== hash) return file;
    } catch {
      return file;
    }
  }
  return null;
}

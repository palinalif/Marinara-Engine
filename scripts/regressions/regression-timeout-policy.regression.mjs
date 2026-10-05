import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { regressionTimeoutMs } from '../run-regressions.mjs';

assert.equal(regressionTimeoutMs('scripts/regressions/server-signal-shutdown.regression.ts'), 270_000);
assert.equal(regressionTimeoutMs('scripts/regressions/restart-supervisor.regression.ts'), 90_000);
assert.equal(regressionTimeoutMs('scripts/regressions/prompt.regression.ts'), 30_000);

// An absolute path through a linked directory must still run the CLI, not exit successfully
// without running anything (for example, /tmp is a symlink to /private/tmp on macOS).
const scripts = fileURLToPath(new URL('../', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'marinara-runner-entry-'));
try {
  const linkedScripts = join(dir, 'scripts');
  symlinkSync(scripts, linkedScripts, process.platform === 'win32' ? 'junction' : 'dir');
  const list = (entry) => execFileSync(process.execPath, [entry, '--list'], { encoding: 'utf8', timeout: 10_000 });
  const canonical = list(join(scripts, 'run-regressions.mjs'));
  assert.match(canonical, /scripts\/regressions\/regression-timeout-policy\.regression\.mjs/);
  assert.equal(list(join(linkedScripts, 'run-regressions.mjs')), canonical);
  const imported = execFileSync(process.execPath, ['--input-type=module', '-'], {
    input: `import { regressionTimeoutMs } from ${JSON.stringify(pathToFileURL(join(scripts, 'run-regressions.mjs')).href)}; console.log(regressionTimeoutMs('scripts/regressions/prompt.regression.ts'));`,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(imported.trim(), '30000', 'importing from stdin must not run the CLI or require a filename');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('Scoped regression timeouts and absolute/symlink CLI entry passed.');

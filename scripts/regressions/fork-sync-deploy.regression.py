#!/usr/bin/env python3
"""Run: python3 scripts/regressions/fork-sync-deploy.regression.py
Only disposable directories and loopback HTTP; git/network provenance is mocked.
"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import shutil
import signal
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).resolve().parents[1] / "fork-sync-deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
OLD, NEW = "a" * 40, "b" * 40


def put(root, name, content):
    p = root / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


def build(root, sha):
    for name in ("package.json", "packages/shared/package.json", "packages/server/package.json", "packages/client/package.json"):
        put(root, name, '{"version":"1","dependencies":{}}')
    for name in ("pnpm-lock.yaml", "pnpm-workspace.yaml", "storage-format.json", "packages/server/src/db/store.ts"):
        put(root, name, "unchanged")
    for name in deploy.TREES:
        put(root, name + "/index.js", sha)
    put(root, "packages/server/dist/config/build-meta.json", json.dumps({"commit": sha[:12]}))
    put(root, "packages/client/dist/index.html", '<script src="/assets/app.js"></script><link href="/assets/app.css" rel="stylesheet">')
    put(root, "packages/client/dist/assets/app.js", "javascript-" + sha)
    put(root, "packages/client/dist/assets/app.css", "css-" + sha)
    put(root, "packages/shared/dist/obsolete/empty/.keep", "old" if sha == OLD else "new")


class Regression(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.live, self.source = self.root / "live", self.root / "source"
        build(self.live, OLD)
        build(self.source, NEW)
        put(self.live, ".env", "secret sentinel")
        put(self.live, "data/sentinel", "persistent sentinel")
        put(self.live, ".git/sentinel", "git sentinel")
        self.before = deploy.trees(self.live)
        self.inodes = [(self.live / name).stat().st_ino for name in deploy.TREES]
        self.restarts = 0
        self.loaded_commit = OLD[:12]
        self.no_restart = False
        self.failure = None
        self.main_sha = NEW
        self.origin = "https://github.com/palinalif/Marinara-Engine.git"
        self.dirty = ""
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                owner.restarts += 1
                if not owner.no_restart:
                    owner.loaded_commit = deploy.load(owner.live / "packages/server/dist/config/build-meta.json")["commit"]
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"restarted")

            def do_GET(self):
                self.assert_ua()
                commit = owner.loaded_commit
                if self.path.endswith("/api/health"):
                    bad = (owner.failure == "health" and commit == NEW[:12]) or (owner.failure == "rollback" and owner.restarts > 0)
                    data = json.dumps({"status": "ok", "commit": "c" * 12 if bad else commit}).encode()
                else:
                    path = "index.html" if self.path == "/" else self.path.lstrip("/")
                    data = (owner.live / "packages/client/dist" / path).read_bytes()
                    if owner.failure == "assets" and commit == NEW[:12] and path.startswith("assets/"):
                        data = b"wrong asset bytes"
                    if owner.failure == "index" and commit == NEW[:12] and path == "index.html":
                        data = b'<script src="/assets/different.js"></script>'
                self.send_response(200)
                self.end_headers()
                self.wfile.write(data)

            def assert_ua(self):
                assert self.headers["User-Agent"].startswith("curl/")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = f"http://127.0.0.1:{self.server.server_port}"
        self.config = self.root / "host.json"
        put(self.root, "shim.py", "# verified test direct-dist restart shim")
        self.configuration = {"enabled": True, "live_root": str(self.live),
                              "local_health_url": base + "/api/health", "public_url": base,
                              "restart_url": base + "/restart", "request_timeout": 1, "health_timeout": 1,
                              "restart_verification": {"bypasses_launcher": True,
                                                       "files": {str(self.root / "shim.py"): deploy.digest(self.root / "shim.py")}}}
        self.write_config()
        self.proof = self.root / "proof"
        self.metadata = {"id": 10, "status": "completed", "conclusion": "success", "head_branch": "main",
                         "path": ".github/workflows/fork-staging-sync.yml", "repository": {"full_name": deploy.FORK}}
        self.write_proof()
        self.args = argparse.Namespace(source=str(self.source), sha=NEW, run_id=10, proof=str(self.proof),
                                       state=str(self.root / "state"), config=str(self.config), rollback=None)
        self.git_patch = patch.object(deploy, "git", side_effect=self.git)
        self.git_patch.start()
        self.signals = {s: signal.getsignal(s) for s in (signal.SIGINT, signal.SIGTERM)}

    def tearDown(self):
        self.git_patch.stop()
        for s, handler in self.signals.items():
            signal.signal(s, handler)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def git(self, source, *args):
        if args[0] == "rev-parse":
            return OLD if source == self.live else NEW
        if args[0] == "ls-files":
            return "\0".join(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "storage-format.json",
                                  "packages/server/package.json", "packages/server/src/db/store.ts"]) + "\0"
        if args[0] == "status":
            return "" if source == self.live else self.dirty
        if args[0] == "remote":
            return self.origin
        if args[0] == "ls-remote":
            return self.main_sha + "\trefs/heads/main"
        raise AssertionError(args)

    def write_config(self):
        self.config.write_text(json.dumps(self.configuration))

    def write_proof(self):
        put(self.proof, "run.json", json.dumps(self.metadata))
        put(self.proof, "commit.txt", NEW + "\n")

    def run_deploy(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return deploy.execute(self.args)

    def results(self):
        return [deploy.load(p) for p in (self.root / "state/runs").glob("*/result.json")]

    def unchanged_live(self):
        self.assertEqual(deploy.trees(self.live), self.before)
        self.assertEqual([(self.live / n).stat().st_ino for n in deploy.TREES], self.inodes)
        for name, value in {".env": "secret sentinel", "data/sentinel": "persistent sentinel", ".git/sentinel": "git sentinel"}.items():
            self.assertEqual((self.live / name).read_text(), value)

    def test_success_noop_and_explicit_rollback(self):
        self.assertEqual(self.run_deploy(), 0)
        self.assertEqual(self.restarts, 1)
        self.assertEqual(deploy.trees(self.live), deploy.trees(self.source))
        self.assertEqual([(self.live / n).stat().st_ino for n in deploy.TREES], self.inodes)
        last = deploy.load(self.root / "state/last-deployed.json")
        self.assertEqual(self.run_deploy(), 0)
        self.assertEqual(self.restarts, 1)
        self.assertEqual(deploy.load(self.root / "state/last-deployed.json"), last)
        self.args.rollback = last["run_dir"]
        self.assertEqual(self.run_deploy(), 0)
        self.assertEqual(self.restarts, 2)
        self.unchanged_live()
        self.assertIsNone(deploy.load(self.root / "state/last-deployed.json"))
        self.assertEqual(self.run_deploy(), 1)  # no longer current

    def test_watcher_state_layout(self):
        state = self.root / "state"
        state.mkdir()
        shutil.move(str(self.source), state / "source")
        shutil.move(str(self.proof), state / "proofs")
        self.source, self.proof = state / "source", state / "proofs"
        self.args.source, self.args.proof = str(self.source), str(self.proof)
        self.assertEqual(self.run_deploy(), 0)
        self.assertEqual(self.restarts, 1)

    def test_compatibility_blocks_before_mutation(self):
        for name in ("pnpm-lock.yaml", "storage-format.json", "packages/server/package.json", "packages/server/src/db/store.ts"):
            p = self.source / name
            old = p.read_text()
            p.write_text("changed")
            self.assertEqual(self.run_deploy(), 1, name)
            self.unchanged_live()
            self.assertEqual(self.restarts, 0)
            p.write_text(old)

    def test_health_assets_and_index_failures_exact_rollback(self):
        for failure in ("health", "assets", "index"):
            self.failure = failure
            self.assertEqual(self.run_deploy(), 1, failure)
            self.unchanged_live()
            self.assertIn("rolled_back", [r["status"] for r in self.results()])
            self.assertIsNone(deploy.load(self.root / "state/last-deployed.json"))
        self.assertEqual(self.restarts, 6)

    def test_rollback_failure_distinguished(self):
        self.failure = "rollback"
        self.assertEqual(self.run_deploy(), 2)
        self.unchanged_live()
        self.assertEqual(self.results()[0]["status"], "rollback_failed")
        self.assertFalse((self.root / "state/last-deployed.json").exists())

    def test_partial_copy_and_interrupt_roll_back(self):
        original = deploy.mirror
        for exception in (OSError("partial copy"), KeyboardInterrupt()):
            count = 0
            def partial(source, target):
                nonlocal count
                count += 1
                if count == 1:
                    for child in target.iterdir():
                        shutil.rmtree(child) if child.is_dir() else child.unlink()
                    raise exception
                return original(source, target)
            with patch.object(deploy, "mirror", side_effect=partial):
                self.assertEqual(self.run_deploy(), 1)
            self.unchanged_live()
        self.assertEqual(self.restarts, 2)

    def test_process_group_term_rolls_back_partial_copy(self):
        read_fd, write_fd = os.pipe()
        child = os.fork()
        if child == 0:
            os.close(read_fd)
            os.setsid()
            def interrupted(signum, frame):
                raise KeyboardInterrupt()
            signal.signal(signal.SIGTERM, interrupted)
            original = deploy.mirror
            first = True
            def partial(source, target):
                nonlocal first
                if first:
                    first = False
                    for item in target.iterdir():
                        shutil.rmtree(item) if item.is_dir() else item.unlink()
                    os.write(write_fd, b'R')
                    signal.pause()
                return original(source, target)
            try:
                with patch.object(deploy, 'mirror', side_effect=partial):
                    code = self.run_deploy()
                os.write(write_fd, b'D' if code == 1 else b'F')
                os._exit(0 if code == 1 else 1)
            except BaseException:
                os._exit(2)
        os.close(write_fd)
        try:
            self.assertTrue(select.select([read_fd], [], [], 5)[0], 'child did not reach mutation')
            self.assertEqual(os.read(read_fd, 1), b'R')
            os.killpg(child, signal.SIGTERM)
            self.assertTrue(select.select([read_fd], [], [], 5)[0], 'rollback did not finish')
            self.assertEqual(os.read(read_fd, 1), b'D')
            _, status = os.waitpid(child, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            child = None
            self.unchanged_live()
            self.assertEqual(self.results()[-1]['status'], 'rolled_back')
        finally:
            os.close(read_fd)
            if child is not None:
                try:
                    os.killpg(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(child, 0)

    def test_exclusive_host_lock_even_with_different_state(self):
        import hashlib
        lock_path = Path(tempfile.gettempdir()) / ("marinara-deploy-" + hashlib.sha256(str(self.live).encode()).hexdigest() + ".lock")
        with deploy.lock(lock_path):
            with self.assertRaisesRegex(deploy.Blocked, "lock held"):
                self.run_deploy()
        self.unchanged_live()

    def test_malicious_assets_missing_assets_and_symlinks(self):
        index = self.source / "packages/client/dist/index.html"
        old = index.read_text()
        for asset in ("/assets/../outside", "https://evil/assets/a.js", "/assets/%2e%2e/a", "//assets/a", "/assets/missing.js"):
            index.write_text(f'<script src="{asset}"></script>')
            self.assertEqual(self.run_deploy(), 1)
            self.unchanged_live()
        index.write_text(old)
        asset = self.source / "packages/client/dist/assets/app.js"
        asset.unlink()
        asset.symlink_to(self.live / "packages/client/dist/assets/app.js")
        self.assertEqual(self.run_deploy(), 1)
        self.unchanged_live()
        self.assertEqual(self.restarts, 0)

    def test_proof_fields_origin_dirty_and_obsolete_main(self):
        for field, wrong in {"id": "10", "status": "queued", "conclusion": "failure", "head_branch": "staging",
                             "path": "evil.yml", "repository": {"full_name": "evil/fork"}}.items():
            old = self.metadata[field]
            self.metadata[field] = wrong
            self.write_proof()
            self.assertEqual(self.run_deploy(), 1, field)
            self.metadata[field] = old
        self.write_proof()
        put(self.proof, "commit.txt", OLD)
        self.assertEqual(self.run_deploy(), 1)
        self.write_proof()
        self.origin = "https://github.com/evil/fork.git"
        self.assertEqual(self.run_deploy(), 1)
        self.origin = "https://github.com/palinalif/Marinara-Engine.git"
        self.dirty = " M tracked"
        self.assertEqual(self.run_deploy(), 1)
        self.dirty = ""
        self.main_sha = OLD
        self.assertEqual(self.run_deploy(), 1)
        self.assertEqual(self.restarts, 0)
        self.unchanged_live()

    def test_manual_rollback_of_unhealthy_active_service(self):
        self.assertEqual(self.run_deploy(), 0)
        self.failure = 'health'
        self.args.rollback = deploy.load(self.root / 'state/last-deployed.json')['run_dir']
        self.assertEqual(self.run_deploy(), 0)
        self.unchanged_live()
        self.assertEqual(self.loaded_commit, OLD[:12])

    def test_bootstrap_rejects_successful_noop_restart(self):
        self.args.bootstrap_restart_verification = True
        self.configuration['restart_verification'] = {}
        self.write_config()
        self.no_restart = True
        self.assertEqual(self.run_deploy(), 1)
        self.unchanged_live()
        self.assertEqual(self.loaded_commit, OLD[:12])
        self.assertFalse(list((self.root / 'state/runs').glob('*/restart-proof.json')))
        self.assertEqual(self.restarts, 2)

    def test_monotonic_and_manual_rollback_identity_guard(self):
        self.assertEqual(self.run_deploy(), 0)
        self.args.run_id = self.metadata["id"] = 9
        self.write_proof()
        self.assertEqual(self.run_deploy(), 1)
        self.assertEqual(self.restarts, 1)
        self.args.rollback = deploy.load(self.root / "state/last-deployed.json")["run_dir"]
        put(self.live, "packages/server/dist/index.js", "unexpected output")
        self.assertEqual(self.run_deploy(), 1)
        self.assertEqual(self.restarts, 1)

    def test_host_optin_and_restart_chain_pin(self):
        self.configuration["restart_verification"] = {}
        self.write_config()
        self.assertEqual(self.run_deploy(), 1)
        self.unchanged_live()
        self.configuration["restart_verification"] = {"bypasses_launcher": True, "files": {str(self.root / "shim.py"): "0" * 64}}
        self.write_config()
        self.assertEqual(self.run_deploy(), 1)
        self.unchanged_live()
        self.configuration["enabled"] = False
        self.write_config()
        with self.assertRaises(deploy.Blocked):
            self.run_deploy()
        self.assertEqual(self.restarts, 0)

    def test_empirical_bootstrap_and_reuse(self):
        self.configuration["restart_verification"] = {}
        self.write_config()
        self.assertEqual(self.run_deploy(), 1)  # watcher fails closed
        self.args.bootstrap_restart_verification = True
        self.assertEqual(self.run_deploy(), 0)
        last = deploy.load(self.root / "state/last-deployed.json")
        result = Path(last["run_dir"]) / "result.json"
        proof = deploy.load(Path(last["run_dir"]) / "restart-proof.json")
        self.assertEqual(proof["deployed_sha"], NEW)
        self.assertEqual(proof["live_source_sha"], OLD)
        self.args.bootstrap_restart_verification = False
        self.configuration["restart_verification"] = {"verified_deployment": str(result)}
        self.write_config()
        self.assertEqual(self.run_deploy(), 0)  # observed proof permits healthy no-op
        self.args.rollback = last["run_dir"]
        self.assertEqual(self.run_deploy(), 0)  # real rollback restart uses empirical proof
        self.unchanged_live()
        self.args.rollback = None
        self.assertEqual(self.run_deploy(), 0)  # real unattended deploy restart
        self.assertEqual(self.restarts, 3)
        # URL binding and source fingerprint must still match.
        self.configuration["public_url"] += "/different"
        self.write_config()
        with self.assertRaises(deploy.Blocked):
            self.run_deploy()
        self.configuration["public_url"] = proof["targets"]["public_url"]
        self.write_config()
        put(self.live, "packages/server/src/db/store.ts", "changed source")
        self.assertEqual(self.run_deploy(), 1)
        self.assertEqual(self.restarts, 3)

    def test_bootstrap_failure_does_not_publish_restart_proof(self):
        self.configuration["restart_verification"] = {}
        self.write_config()
        self.args.bootstrap_restart_verification = True
        self.failure = "assets"
        self.assertEqual(self.run_deploy(), 1)
        self.unchanged_live()
        self.assertFalse(list((self.root / "state/runs").glob("*/restart-proof.json")))
        self.assertNotIn("restart_proof", self.results()[0])
        self.args.bootstrap_restart_verification = False
        self.assertEqual(self.run_deploy(), 1)
        self.assertEqual(self.restarts, 2)

    def test_bootstrap_requires_real_mismatch_and_restart(self):
        self.args.bootstrap_restart_verification = True
        self.configuration["restart_verification"] = {}
        self.write_config()
        for name in deploy.TREES:
            deploy.mirror(self.source / name, self.live / name)
        self.loaded_commit = NEW[:12]
        self.assertEqual(self.run_deploy(), 1)  # already healthy must not manufacture proof
        self.assertEqual(self.restarts, 0)
        self.assertFalse(list((self.root / "state/runs").glob("*/restart-proof.json")))

    def test_config_url_and_path_rejection(self):
        for url in ("file:///tmp/test", "http://user:secret@127.0.0.1/", "http://127.0.0.1/?token=secret", "http://127.0.0.1:99999/"):
            with self.assertRaises((deploy.Blocked, ValueError)):
                deploy.Host({**self.configuration, "restart_url": url})
        link = self.root / "link"
        link.symlink_to(self.live, target_is_directory=True)
        with self.assertRaises(deploy.Blocked):
            deploy.safe_path(str(link / "packages"))


if __name__ == "__main__":
    unittest.main(verbosity=2)

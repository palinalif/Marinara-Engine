#!/usr/bin/env python3
"""Dist-only host deployment (Python stdlib, POSIX).

Deploy: --source PATH --sha FULLSHA --run-id NUM --proof PATH --state PATH
        --config JSON_FILE
Rollback: --rollback RUN_DIR --state PATH --config JSON_FILE
Config requires enabled:true, live_root (absolute), local_health_url, public_url
(origin only), restart_url, restart_verification:{bypasses_launcher:true,
files:{ABSOLUTE_SHIM_OR_SUPERVISOR_PATH:SHA256,...}}. This is a trusted operator
attestation after inspecting the actual restart chain, not an inferred bypass.
Pinned files must be readable and unchanged; include every restart-chain script.
Alternatively restart_verification:{verified_deployment:ABSOLUTE_RESULT_JSON}
uses a successful manual --bootstrap-restart-verification deployment's evidence.
Bootstrap is an explicit operator-only flag, never an automatic watcher fallback.
It still requires enabled:true; config is never written. Until proof is configured,
unattended invocations fail closed. Bootstrap failures publish no restart proof.
Optional request_timeout (1..60, default 10),
health_timeout (1..300, default 90). State/proof must be trusted host directories.
Exit: 0 verified success/no-op/rollback; 1 blocked or rolled back; 2 rollback failed.
No install, build, git writes, authentication logging, or source/data writes.
Compatibility is deliberately conservative: exact manifests, lock/workspace,
storage format, server DB and migration sources. Caller owns CI artifact trust,
current-main fetching and build provenance; metadata alone cannot prove a build.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser

TREES = tuple(f"packages/{p}/dist" for p in ("shared", "server", "client"))
FORK = "palinalif/Marinara-Engine"


class Blocked(Exception):
    pass


def require(ok, message):
    if not ok:
        raise Blocked(message)


def safe_path(value, exists=True):
    p = Path(value)
    require(p.is_absolute() and p == Path(os.path.abspath(p)), "path must be absolute and normalized")
    for item in (p, *p.parents):
        require(not item.is_symlink(), "symlink path refused")
    if exists:
        require(p.is_dir(), "directory missing")
    return p


def regular(p):
    require(p.is_file() and not p.is_symlink(), "regular file required")
    return p


def load(p):
    return json.loads(regular(p).read_text())


def atomic(p, value):
    data = json.dumps(value, indent=2, sort_keys=True) + "\n"
    fd, name = tempfile.mkstemp(prefix=".write-", dir=p.parent)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, p)
        d = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def digest(p):
    h = hashlib.sha256()
    with regular(p).open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def manifest(root, allow_empty=False):
    safe_path(str(root))
    result = {}
    for p in sorted(root.rglob("*")):
        mode = p.lstat().st_mode
        require(stat.S_ISDIR(mode) or stat.S_ISREG(mode), "unsafe dist entry")
        key = p.relative_to(root).as_posix()
        result[key] = {"mode": stat.S_IMODE(mode), "sha256": digest(p)} if p.is_file() else {"directory": True, "mode": stat.S_IMODE(mode)}
    require(allow_empty or any("sha256" in v for v in result.values()), "empty dist tree")
    return result


def trees(root):
    return {name: manifest(root / name) for name in TREES}


def mirror(source, target):
    """Full mirror, retaining bind-mounted target root (including file/dir swaps)."""
    manifest(source)
    manifest(target, allow_empty=True)
    for child in target.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()
    shutil.copytree(source, target, dirs_exist_ok=True)
    # copytree copystat changes root mode, not its inode.
    require(manifest(source) == manifest(target), "mirror verification failed")


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("src", "href") and value and ("assets" in value or tag == "script"):
                require(re.fullmatch(r"/assets/[A-Za-z0-9_./-]+", value) is not None,
                        "unsafe asset URL")
                require(all(part not in ("", ".", "..") for part in value[1:].split("/")), "unsafe asset path")
                self.paths.append(value)


def assets(data):
    parser = Assets()
    parser.feed(data.decode("utf-8"))
    require(parser.paths, "index has no assets")
    return parser.paths


def validate_build(root, sha):
    result = trees(root)
    for name in ("packages/shared/dist/index.js", "packages/server/dist/index.js", "packages/client/dist/index.html"):
        require(regular(root / name).stat().st_size > 0, "required build entry missing")
    require(load(root / "packages/server/dist/config/build-meta.json").get("commit") == sha[:12], "build metadata mismatch")
    client = root / "packages/client/dist"
    for asset in assets((client / "index.html").read_bytes()):
        require(regular(client / asset[1:]).stat().st_size > 0, "missing client asset")
    return result


def git(source, *args):
    # Never include stderr, remote URLs or credentials in results/logs.
    try:
        return subprocess.run(["git", "-C", str(source), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              timeout=30, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"}).stdout.decode().strip()
    except (subprocess.SubprocessError, UnicodeError):
        raise Blocked("git verification failed") from None


def source_identity(source, sha):
    require(git(source, "rev-parse", "HEAD") == sha, "source SHA mismatch")
    require(not git(source, "status", "--porcelain", "--untracked-files=no"), "tracked source is dirty")
    origin = git(source, "remote", "get-url", "origin")
    require(origin in (f"https://github.com/{FORK}.git", f"https://github.com/{FORK}",
                       f"git@github.com:{FORK}.git", f"ssh://git@github.com/{FORK}.git"), "source origin is not official fork")


def live_source(root):
    """Fingerprint tracked bytes and read-only git identity, including local edits."""
    sha = git(root, "rev-parse", "HEAD")
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "invalid live source identity")
    files = {}
    for name in git(root, "ls-files", "-z").split("\0"):
        if not name:
            continue
        p = Path(name)
        require(not p.is_absolute() and all(part not in ("..", ".") for part in p.parts), "unsafe tracked path")
        require(not any(p.is_relative_to(Path(t)) for t in TREES), "tracked dist cannot be deployed independently")
        path = root / p
        safe_path(str(path.parent))
        if path.is_symlink():
            files[name] = {"link": os.readlink(path)}
        elif not path.exists():
            files[name] = {"missing": True}
        else:
            files[name] = {"sha256": digest(path), "mode": stat.S_IMODE(path.stat().st_mode)}
    require(files, "live tracked source inventory missing")
    return {"sha": sha, "files": files,
            "status": git(root, "status", "--porcelain", "--untracked-files=no")}


def current_main(source, sha):
    require(git(source, "ls-remote", "--exit-code", "origin", "refs/heads/main").split() ==
            [sha, "refs/heads/main"], "tested revision is no longer fork main")


def proof_check(proof, sha, run_id):
    run = load(proof / "run.json")
    require(type(run.get("id")) is int and run["id"] == run_id, "proof run ID mismatch")
    for key, expected in {"status": "completed", "conclusion": "success", "head_branch": "main",
                          "path": ".github/workflows/fork-staging-sync.yml"}.items():
        require(run.get(key) == expected, "proof metadata mismatch")
    require(run.get("repository", {}).get("full_name") == FORK, "proof repository mismatch")
    require(regular(proof / "commit.txt").read_text().strip() == sha, "artifact commit mismatch")


def compatibility(source, live):
    def selected(root):
        paths = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "storage-format.json"}
        # Includes workspace/runtime manifests, including nested runtime packages.
        for base in (root / "packages", root / "patches"):
            if not base.exists():
                continue
            for directory, dirs, files in os.walk(base, followlinks=False):
                # Canonical ignored runtime state is not dependency/migration
                # source, even when its records contain "migration" or manifests.
                dirs[:] = [d for d in dirs if d not in ("node_modules", "dist", ".git")
                           and Path(directory) / d != root / "packages/server/data"]
                for d in dirs:
                    require(not (Path(directory) / d).is_symlink(), "unsafe compatibility directory")
                for f in files:
                    p = Path(directory) / f
                    rel = p.relative_to(root).as_posix()
                    if f == "package.json" or "migration" in rel.lower() or "/server/src/db/" in "/" + rel or rel.startswith("patches/"):
                        paths.add(rel)
        return {p: digest(root / p) for p in sorted(paths)}
    require(selected(source) == selected(live), "incompatible dependencies/storage/migrations; no install permitted")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Blocked("HTTP redirect refused")


class Host:
    def __init__(self, config):
        require(config.get("enabled") is True, "host deployment must explicitly be enabled")
        self.live = safe_path(config["live_root"])
        self.urls = {}
        for key in ("local_health_url", "public_url", "restart_url"):
            value = config[key]
            u = urllib.parse.urlsplit(value)
            require(u.scheme in ("http", "https") and u.hostname and not u.username and not u.password
                    and not u.query and not u.fragment and not any(c.isspace() for c in value), "unsafe config URL")
            u.port  # Validate port syntax/range.
            if key == "public_url":
                require(u.path in ("", "/"), "public_url must be an origin")
            self.urls[key] = value.rstrip("/") if key == "public_url" else value
        require(urllib.parse.urlsplit(self.urls["local_health_url"]).hostname ==
                urllib.parse.urlsplit(self.urls["restart_url"]).hostname, "restart/health hosts differ")
        self.timeout = float(config.get("request_timeout", 10))
        self.wait = float(config.get("health_timeout", 90))
        require(1 <= self.timeout <= 60 and 1 <= self.wait <= 300, "unsafe timeout")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.restart_verification = config.get("restart_verification", {})

    def restart_safe(self):
        if getattr(self, "bootstrap", False):
            return  # Explicit manual-only empirical trial; rollback stays armed.
        evidence = self.restart_verification
        if evidence.get("verified_deployment"):
            p = Path(evidence["verified_deployment"])
            safe_path(str(p.parent))
            record = load(p)
            proof = record.get("restart_proof", {})
            require(record.get("status") == "deployed" and record.get("bootstrap_restart_verification") is True,
                    "restart evidence is not a successful bootstrap")
            require(proof.get("targets") == self.targets() and record.get("live_root") == str(self.live)
                    and proof.get("result") == str(p) and proof.get("source_snapshot") == record.get("source_snapshot"),
                    "restart evidence targets/result/source binding differs")
            sha = record.get("sha", "")
            require(re.fullmatch(r"[0-9a-f]{40}", sha) and proof.get("deployed_sha") == sha
                    and re.fullmatch(r"[0-9a-f]{40}", proof.get("live_source_sha", ""))
                    and proof["live_source_sha"][:12] != sha[:12], "restart evidence did not test a source mismatch")
            for key in ("local", "public"):
                h = record.get("verification", {}).get(key, {})
                require(h.get("status") == "ok" and h.get("commit") == sha[:12], "restart evidence health mismatch")
            require(record.get("verification", {}).get("assets"), "restart evidence lacks asset verification")
            snapshot = live_source(self.live)
            require(snapshot == proof.get("source_snapshot") and snapshot["sha"] == proof.get("live_source_sha"),
                    "live source changed since empirical restart verification")
            return
        require(evidence.get("bypasses_launcher") is True and evidence.get("files"),
                "restart bypass must be verified and checksum-pinned by host operator")
        for name, expected in evidence["files"].items():
            p = Path(name)
            safe_path(str(p.parent))
            require(re.fullmatch(r"[0-9a-f]{64}", expected) and digest(p) == expected,
                    "restart chain evidence changed")

    def targets(self):
        return {"live_root": str(self.live), **self.urls}

    def request(self, url, method="GET", deadline=None):
        end = min(deadline or float("inf"), time.monotonic() + self.timeout)
        require(end > time.monotonic(), "HTTP deadline expired")
        request = urllib.request.Request(url, method=method, headers={"User-Agent": "curl/8.14.1", "Cache-Control": "no-cache"})
        with self.opener.open(request, timeout=min(self.timeout, end - time.monotonic())) as response:
            require(response.status == 200, "HTTP status failed")
            chunks, size = [], 0
            while True:
                require(time.monotonic() < end, "HTTP deadline expired")
                chunk = response.read1(65536)
                if not chunk:
                    return b"".join(chunks)
                size += len(chunk)
                require(size <= 64 * 1024 * 1024, "HTTP response too large")
                chunks.append(chunk)

    def health(self, url, commit=None, deadline=None):
        h = json.loads(self.request(url, deadline=deadline))
        require(h.get("status") == "ok" and re.fullmatch(r"[0-9a-f]{12}", str(h.get("commit", ""))), "unhealthy or invalid identity")
        if commit:
            require(h["commit"] == commit, "health identity mismatch")
        return h

    def verify(self, commit, root):
        end = time.monotonic() + self.wait
        while True:
            try:
                local = self.health(self.urls["local_health_url"], commit, end)
                public = self.health(self.urls["public_url"] + "/api/health", commit, end)
                client = root / "packages/client/dist"
                expected = assets((client / "index.html").read_bytes())
                require(assets(self.request(self.urls["public_url"] + "/", deadline=end)) == expected, "public index assets mismatch")
                for asset in expected:
                    require(self.request(self.urls["public_url"] + asset, deadline=end) ==
                            (client / asset[1:]).read_bytes(), "public asset bytes mismatch")
                return {"local": local, "public": public, "assets": expected}
            except Exception:
                if time.monotonic() >= end:
                    raise Blocked("health/public assets verification timed out") from None
                time.sleep(min(0.2, max(0, end - time.monotonic())))

    def restart(self):
        self.restart_safe()
        self.request(self.urls["restart_url"], "POST")


def sync_tree(root):
    """Make recovery material durable before any destructive copy."""
    for directory, dirs, files in os.walk(root, topdown=False):
        for name in files:
            with regular(Path(directory) / name).open("rb") as f:
                os.fsync(f.fileno())
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


@contextlib.contextmanager
def lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        require(stat.S_ISREG(os.fstat(fd).st_mode), "unsafe lock file")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Blocked("deployment lock held") from None
        yield
    finally:
        os.close(fd)


def restore(host, run, record):
    backup = run / "backup"
    require(trees(backup) == record["before_trees"], "backup checksum mismatch")
    for name in TREES:
        safe_path(str(host.live / name))
        s = (host.live / name).stat()
        require([s.st_dev, s.st_ino] == record["inodes"][name], "live dist root changed")
        mirror(backup / name, host.live / name)
    require(trees(host.live) == record["before_trees"], "rollback checksum mismatch")
    for name in TREES:
        sync_tree(host.live / name)
    host.restart()
    verification = host.verify(record["before_health"]["commit"], backup)
    require(trees(host.live) == record["before_trees"], "rollback restart changed output")
    return verification


def execute(args):
    host = Host(load(safe_path(str(Path(args.config).absolute().parent)) / Path(args.config).name))
    host.bootstrap = getattr(args, "bootstrap_restart_verification", False)
    require(not (host.bootstrap and args.rollback), "bootstrap flag is deployment-only")
    state = safe_path(args.state, exists=False)
    require(not state.is_relative_to(host.live) and not host.live.is_relative_to(state), "state/live overlap")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Host-wide lock prevents two different state directories targeting the same live tree.
    host_lock = Path(tempfile.gettempdir()) / ("marinara-deploy-" + hashlib.sha256(str(host.live).encode()).hexdigest() + ".lock")
    with lock(host_lock), lock(state / "deploy.lock"):
        return locked_execute(args, host, state)


def locked_execute(args, host, state):
    runs = state / "runs"
    safe_path(str(runs), exists=False)
    runs.mkdir(exist_ok=True, mode=0o700)
    run = Path(tempfile.mkdtemp(prefix=f"{args.run_id or 'rollback'}-", dir=runs))
    record = {"status": "validating", "run_id": args.run_id, "sha": args.sha, "live_root": str(host.live),
              "bootstrap_restart_verification": host.bootstrap}
    armed = False
    last_path = state / "last-deployed.json"
    previous = load(last_path) if last_path.exists() else None
    def save(status):
        record["status"] = status
        atomic(run / "result.json", record)
        atomic(run / "status.json", {"status": status})
    save("validating")
    try:
        host.restart_safe()
        if args.rollback:
            original = safe_path(args.rollback)
            require(original.parent == runs and previous and previous.get("run_dir") == str(original), "rollback is not current deployment")
            old = load(original / "result.json")
            require(old["status"] == "deployed" and old["live_root"] == str(host.live), "unsafe rollback identity")
            require(trees(host.live) == old["candidate_trees"], "current dist differs from deployed identity")
            require(live_source(host.live) == old["source_snapshot"], "live source differs from deployed identity")
            # Recovery must remain available if the active service is unhealthy;
            # on-disk deployment identity and backup checks still gate restoration.
            # A manual rollback does not roll forward on failure; retry requires operator recovery.
            record["rollback_of"] = str(original)
            save("restoring")
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                record["verification"] = restore(host, original, old)
                require(live_source(host.live) == old["source_snapshot"], "rollback restart changed source")
                atomic(last_path, old["previous"])
                save("rolled_back")
                return 0
            except BaseException:
                save("rollback_failed")
                return 2
        require(args.source and args.sha and args.run_id and args.proof, "deploy requires source, sha, run-id and proof")
        require(re.fullmatch(r"[0-9a-f]{40}", args.sha) and args.run_id > 0, "invalid SHA/run ID")
        source, proof = safe_path(args.source), safe_path(args.proof)
        # The watcher owns state/source and state/proofs. Those siblings are
        # intentionally inside state, but neither may contain state or overlap
        # recovery material, the live tree, or each other.
        for p in (source, proof):
            require(not p.is_relative_to(host.live) and not host.live.is_relative_to(p)
                    and not state.is_relative_to(p)
                    and not p.is_relative_to(runs) and not runs.is_relative_to(p), "unsafe overlapping paths")
        require(not source.is_relative_to(proof) and not proof.is_relative_to(source), "source/proof overlap")
        proof_check(proof, args.sha, args.run_id)
        source_identity(source, args.sha)
        compatibility(source, host.live)
        record["source_snapshot"] = live_source(host.live)
        if host.bootstrap:
            require(record["source_snapshot"]["sha"][:12] != args.sha[:12], "bootstrap must test a real source/build mismatch")
        candidate = run / "candidate"
        validate_build(source, args.sha)
        for name in TREES:
            shutil.copytree(source / name, candidate / name)
        record["candidate_trees"] = validate_build(candidate, args.sha)
        record["previous"] = previous
        high_path = state / "high-water.json"
        high = load(high_path) if high_path.exists() else {"run_id": 0}
        require(args.run_id >= high["run_id"], "obsolete deployment run")
        if args.run_id == high["run_id"]:
            require(high.get("sha") == args.sha, "run ID reused for different SHA")
        before = host.health(host.urls["local_health_url"])
        record["before_health"] = before
        record["before_trees"] = trees(host.live)
        record["inodes"] = {name: [(host.live / name).stat().st_dev, (host.live / name).stat().st_ino] for name in TREES}
        if before["commit"] == args.sha[:12] and record["before_trees"] == record["candidate_trees"]:
            require(not host.bootstrap, "bootstrap requires a real restart, not a no-op")
            record["verification"] = host.verify(args.sha[:12], candidate)
            current_main(source, args.sha)
            atomic(high_path, {"run_id": args.run_id, "sha": args.sha})
            save("unchanged")
            return 0
        backup = run / "backup"
        for name in TREES:
            shutil.copytree(host.live / name, backup / name)
        require(trees(backup) == record["before_trees"], "backup checksum mismatch")
        host.verify(before["commit"], backup)
        save("prepared")
        # Final checks after network/backup work, immediately before arming the mirror.
        proof_check(proof, args.sha, args.run_id)
        source_identity(source, args.sha)
        compatibility(source, host.live)
        require(trees(host.live) == record["before_trees"], "live dist changed during preparation")
        require(live_source(host.live) == record["source_snapshot"], "live source changed during preparation")
        host.restart_safe()
        for name in TREES:
            s = (host.live / name).stat()
            require([s.st_dev, s.st_ino] == record["inodes"][name], "live dist root changed")
        sync_tree(run)
        atomic(high_path, {"run_id": args.run_id, "sha": args.sha})
        save("mutating")
        current_main(source, args.sha)  # Last external gate immediately before mutation.
        armed = True
        for name in TREES:
            mirror(candidate / name, host.live / name)
        host.restart()
        record["verification"] = host.verify(args.sha[:12], candidate)
        require(trees(host.live) == record["candidate_trees"], "live output changed after deployment")
        require(live_source(host.live) == record["source_snapshot"], "restart changed live source")
        compatibility(source, host.live)
        sync_tree(host.live / "packages/shared/dist")
        sync_tree(host.live / "packages/server/dist")
        sync_tree(host.live / "packages/client/dist")
        if host.bootstrap:
            record["restart_proof"] = {"targets": host.targets(), "live_source_sha": record["source_snapshot"]["sha"],
                                       "source_snapshot": record["source_snapshot"], "deployed_sha": args.sha,
                                       "result": str(run / "result.json")}
        save("deployed")
        atomic(last_path, {"sha": args.sha, "run_id": args.run_id, "run_dir": str(run)})
        if host.bootstrap:
            atomic(run / "restart-proof.json", record["restart_proof"])
        armed = False
        return 0
    except BaseException as error:
        # Do not persist exception text: network/git exceptions can contain credentials.
        record["error_type"] = type(error).__name__
        if isinstance(error, Blocked):
            record["reason"] = str(error)
        if armed:
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                record["rollback_verification"] = restore(host, run, record)
                require(live_source(host.live) == record["source_snapshot"], "rollback cannot restore changed source")
                if (run / "restart-proof.json").exists():
                    (run / "restart-proof.json").unlink()
                record.pop("restart_proof", None)
                atomic(last_path, previous)
                save("rolled_back")
                return 1
            except BaseException as rollback_error:
                record["rollback_error_type"] = type(rollback_error).__name__
                if isinstance(rollback_error, Blocked):
                    record["rollback_reason"] = str(rollback_error)
                save("rollback_failed")
                return 2
        save("blocked")
        return 1
    finally:
        print(json.dumps({"run_dir": str(run), "status": record["status"]}))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for flag in ("source", "sha", "proof", "rollback"):
        parser.add_argument("--" + flag)
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--bootstrap-restart-verification", action="store_true",
                        help="operator-only empirical restart trial; watchers must never set this")
    parser.add_argument("--state", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    def interrupted(*unused):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        return execute(args)
    except BaseException as error:
        print(json.dumps({"status": "blocked", "error_type": type(error).__name__}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

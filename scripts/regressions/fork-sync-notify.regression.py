#!/usr/bin/env python3
"""Model-free regression: python3 scripts/regressions/fork-sync-notify.regression.py."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "fork-sync-notify.py"
spec = importlib.util.spec_from_file_location("fork_sync_notify", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def run():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        state, agent = root / "state", root / "pi"
        with patch.dict(os.environ, {"PI_CODING_AGENT_DIR": str(agent)}):
            def notify(status="failed", message="same", run_id="unknown", sha=""):
                return module.notify(state, status, run_id, sha, message)

            first = notify()
            entries = [json.loads(line) for line in first.read_text().splitlines()]
            assert entries[0]["version"] == 3 and entries[0]["cwd"] == str(state)
            assert entries[1]["name"] == "Marinara deployment · failed · run unknown"
            assert entries[1]["parentId"] is None
            assert entries[2]["parentId"] == entries[1]["id"]
            assert entries[2]["type"] == "custom_message" and entries[2]["display"] is True
            assert not any(entry.get("type") == "message" for entry in entries)
            original = first.read_bytes()
            assert notify() == first and first.read_bytes() == original
            assert len(list(agent.rglob("*.jsonl"))) == 1
            assert load(state / "status.json")["status"] == "failed"

            # Last-key dedupe allows returning to the identical failure event.
            success = notify("deployed")
            again = notify()
            assert len({first, success, again}) == 3
            again.unlink()
            assert notify() == again and not again.exists()
            assert len(list(agent.rglob("*.jsonl"))) == 2

            # Status becomes visible even if publication fails; the pending
            # transaction is not mistaken for a successful notification.
            with patch.object(module, "publish", side_effect=OSError("injected")):
                try:
                    notify("blocked")
                except OSError:
                    pass
                else:
                    raise AssertionError("Expected publication failure")
            assert load(state / "status.json")["status"] == "blocked"
            pending = load(state / "notify-marker.json")
            assert pending["published"] is False
            retried = notify("blocked")
            assert str(retried) == pending["chat_path"] and retried.exists()
            assert load(state / "notify-marker.json")["published"] is True

            # A new transition cannot discard an unpublished failure.
            with patch.object(module, "publish", side_effect=OSError("offline")):
                try:
                    notify("failed", "pending failure")
                except OSError:
                    pass
                pending_failure = load(state / "notify-marker.json")
                try:
                    notify("deployed", "recovered")
                except OSError:
                    pass
                assert load(state / "notify-marker.json") == pending_failure
                assert load(state / "status.json")["status"] == "deployed"
            recovered = notify("deployed", "recovered")
            failed_chat = Path(pending_failure["chat_path"])
            assert failed_chat.exists() and recovered.exists() and failed_chat != recovered
            assert json.loads(failed_chat.read_text().splitlines()[2])["details"]["message"] == "pending failure"

            # A crash after the atomic link retries without creating another chat.
            real_publish = module.publish

            def publish_then_fail(marker):
                real_publish(marker)
                raise OSError("after publication")

            with patch.object(module, "publish", side_effect=publish_then_fail):
                try:
                    notify("built")
                except OSError:
                    pass
            pending = load(state / "notify-marker.json")
            before = Path(pending["chat_path"]).read_bytes()
            assert notify("built").read_bytes() == before

            # Failed atomic replacement leaves the complete old status intact.
            before = (state / "status.json").read_bytes()
            with patch.object(module.os, "replace", side_effect=OSError("replace failed")):
                try:
                    notify("failed", "new")
                except OSError:
                    pass
                else:
                    raise AssertionError("Expected atomic write failure")
            assert (state / "status.json").read_bytes() == before
            assert not list(state.glob(".notify-*"))
            assert not list(agent.rglob(".notify-*"))

            # Prove the CLI and optional cwd, full SHA and numeric run identity.
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--state", str(state),
                 "--status", "built", "--run-id", "42", "--sha", "a" * 40,
                 "--message", "CLI proof", "--cwd", str(root)],
                capture_output=True, text=True, check=True,
            )
            chat = Path(result.stdout.strip())
            assert json.loads(chat.read_text().splitlines()[0])["cwd"] == str(root)
            changed_message = notify("built", "changed", "42", "a" * 40)
            changed_run = notify("built", "changed", "43", "a" * 40)
            changed_sha = notify("built", "changed", "43", "b" * 40)
            assert len({chat, changed_message, changed_run, changed_sha}) == 4
            assert notify("built", "changed", "43", "b" * 40) == changed_sha
            for kwargs in ({"run_id": "bad"}, {"sha": "abc"}, {"status": "bad"}):
                try:
                    notify(**kwargs)
                except ValueError:
                    pass
                else:
                    raise AssertionError("Expected validation rejection")
    print("fork-sync-notify regression passed")


if __name__ == "__main__":
    run()

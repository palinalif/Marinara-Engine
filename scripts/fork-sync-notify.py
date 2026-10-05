#!/usr/bin/env python3
"""Persist deployment status and publish local, model-free Pi notification chats.

Each transition gets a chat; notify-marker.json remembers only the last key and
its publication transaction. Failed publications are retried on the next call.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write(path, text, exclusive=False):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".notify-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        if exclusive:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def json_text(value):
    return json.dumps(value, ensure_ascii=False) + "\n"


def publish(marker):
    destination = Path(marker["chat_path"])
    directory = destination.parent
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    event = marker["event"]
    timestamp = event["timestamp"]
    title = f"Marinara deployment · {event['status']} · run {event['run_id']}"
    info_id, message_id = uuid.uuid4().hex[:8], uuid.uuid4().hex[:8]
    entries = [
        {"type": "session", "version": 3, "id": marker["id"],
         "timestamp": timestamp, "cwd": marker["cwd"]},
        {"type": "session_info", "id": info_id, "parentId": None,
         "timestamp": timestamp, "name": title},
        {"type": "custom_message", "id": message_id, "parentId": info_id,
         "timestamp": timestamp, "customType": "marinara:deployment",
         "display": True, "details": event,
         "content": f"{title}\nSHA: {event['sha'] or 'unknown'}\n\n{event['message']}"},
    ]
    try:
        atomic_write(destination, "".join(map(json_text, entries)), exclusive=True)
    except FileExistsError:
        # Recover a crash after publication but before the marker was finalized.
        # Never replace an existing (possibly resumed) chat.
        existing = [json.loads(line) for line in destination.read_text(encoding="utf-8").splitlines()]
        if (len(existing) < 3 or existing[0] != entries[0]
                or existing[1].get("name") != title
                or existing[2].get("type") != "custom_message"
                or existing[2].get("display") is not True
                or existing[2].get("details") != event):
            raise ValueError("Notification chat path has different or incomplete content")
    # Persist newly created ancestors before declaring publication durable.
    sync_directory(directory)
    for parent in directory.parents:
        sync_directory(parent)
    return destination


def notify(state, status, run_id, sha, message, cwd=None):
    if status not in ("failed", "built", "blocked", "deployed"):
        raise ValueError("Invalid status")
    if run_id != "unknown" and not re.fullmatch(r"[0-9]+", run_id):
        raise ValueError("Invalid run ID")
    if sha and not re.fullmatch(r"[0-9a-fA-F]{40}", sha):
        raise ValueError("SHA must be empty or a full 40-character SHA")
    state = Path(state).expanduser().resolve()
    cwd = str(Path(cwd).expanduser().resolve()) if cwd is not None else str(state)
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize concurrent callers across status, publication, and marker updates.
    with (state / "notify.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        event = {"status": status, "run_id": run_id, "sha": sha,
                 "message": message,
                 "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")}
        atomic_write(state / "status.json", json_text(event))
        marker_path = state / "notify-marker.json"
        marker = json.loads(marker_path.read_text(encoding="utf-8")) if marker_path.exists() else None
        # Finish a pending publication before a newer transition can replace it.
        # status.json still exposes the latest result if that publication fails.
        if marker is not None and not marker["published"]:
            publish(marker)
            marker["published"] = True
            atomic_write(marker_path, json_text(marker))
        key = [status, run_id, sha, message]
        if marker is None or marker["key"] != key:
            agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".pi/agent")).expanduser().resolve()
            encoded = "--" + re.sub(r"[/\\:]", "-", cwd.lstrip("/\\")) + "--"
            identity = str(uuid.uuid4())
            destination = agent_dir / "sessions" / encoded / f"fork-sync-notify-{identity}.jsonl"
            marker = {"key": key, "event": event, "cwd": cwd, "id": identity,
                      "chat_path": str(destination), "published": False}
            atomic_write(marker_path, json_text(marker))
        if not marker["published"]:
            publish(marker)
            marker["published"] = True
            atomic_write(marker_path, json_text(marker))
        # A published marker is authoritative even when the user deleted the chat.
        return Path(marker["chat_path"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--status", choices=("failed", "built", "blocked", "deployed"), required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--cwd", type=Path)
    args = parser.parse_args()
    try:
        print(notify(args.state, args.status, args.run_id, args.sha, args.message, args.cwd))
    except (OSError, ValueError, KeyError) as error:
        print(f"fork-sync-notify: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Publish a completed read-only Pi review as a resumable, local Pi Web chat."""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import uuid


def sync_directory(directory: Path) -> None:
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish(review: Path, run_id: str, attempt: str) -> Path:
    if not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9]+", attempt):
        raise ValueError("Invalid run identity")
    marker = review / "chat-path"
    if marker.exists():
        # Respect a user deleting the published chat; do not recreate it.
        return Path(marker.read_text().strip())
    if not (review / "done").is_file() or not (review / "report.md").stat().st_size:
        raise ValueError("Review is not complete")
    source = review / "session.jsonl"
    if not source.exists():
        # Compatibility with reviews made by the older --session-dir launcher.
        candidates = list((review / "sessions").glob("*.jsonl"))
        if not candidates:
            raise ValueError("Completed review has no Pi session")
        source = max(candidates, key=lambda path: path.stat().st_mtime_ns)
    data = source.read_text()
    entries = [json.loads(line) for line in data.splitlines() if line.strip()]
    header = entries[0]
    cwd = str((review / "source").resolve())
    if header.get("type") != "session" or header.get("cwd") != cwd:
        raise ValueError("Unexpected review session working directory")
    responses = [entry["message"] for entry in entries
                 if entry.get("message", {}).get("role") == "assistant"]
    if not responses or responses[-1].get("stopReason") not in ("stop", "length"):
        raise ValueError("Review session has no successful assistant response")
    original_count = len(entries)
    title = f"Marinara merge conflict · run {run_id} · attempt {attempt}"
    entries.append({
        "type": "session_info", "id": uuid.uuid4().hex[:8],
        "parentId": entries[-1]["id"], "timestamp": entries[-1]["timestamp"],
        "name": title,
    })
    # CLI flags are not persisted; keep resumed Pi Web chats tool-free too.
    entries.append({
        "type": "custom", "id": uuid.uuid4().hex[:8],
        "parentId": entries[-1]["id"], "timestamp": entries[-1]["timestamp"],
        "customType": "pi-web:tool-selection", "data": {"version": 1, "tools": []},
    })
    agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".pi/agent")).expanduser().resolve()
    encoded = "--" + re.sub(r"[/\\:]", "-", cwd.lstrip("/\\")) + "--"
    directory = agent_dir / "sessions" / encoded
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination = directory / f"fork-sync-{run_id}-{attempt}.jsonl"
    # Publish whole JSONL atomically, never overwrite a resumed/edited chat.
    # The deterministic path also deduplicates a crash before writing the marker.
    fd, temporary = tempfile.mkstemp(dir=directory, prefix=".publish-")
    try:
        with os.fdopen(fd, "w") as output:
            output.write("".join(json.dumps(entry, ensure_ascii=False) + "\n" for entry in entries))
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, destination)
        except FileExistsError:
            existing = [json.loads(line) for line in destination.read_text().splitlines() if line.strip()]
            if existing[:original_count] != entries[:original_count]:
                raise ValueError("Published chat path has different or incomplete context")
            footer = existing[original_count:original_count + 2]
            if (len(footer) != 2 or footer[0].get("type") != "session_info"
                    or footer[0].get("name") != title
                    or footer[0].get("parentId") != entries[original_count - 1]["id"]
                    or footer[1].get("type") != "custom"
                    or footer[1].get("parentId") != footer[0].get("id")
                    or footer[1].get("customType") != "pi-web:tool-selection"
                    or footer[1].get("data") != {"version": 1, "tools": []}):
                raise ValueError("Published chat path has no complete publication footer")
        # Persist the chat and newly created ancestors before its dedupe marker.
        # mkdir(parents=True) may have created the agent/session directories too.
        sync_directory(directory)
        for parent in directory.parents:
            sync_directory(parent)
    finally:
        Path(temporary).unlink(missing_ok=True)
    fd, temporary = tempfile.mkstemp(dir=review, prefix=".chat-path-")
    try:
        with os.fdopen(fd, "w") as output:
            output.write(str(destination) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, marker)
        sync_directory(review)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return destination


if __name__ == "__main__":
    print(publish(Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3]))

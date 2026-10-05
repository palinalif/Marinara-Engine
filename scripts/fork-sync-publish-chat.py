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
    # The automatic review stays tool-free. Interactive approval authorizes the
    # full repair-to-deploy workflow; tool availability is not itself approval.
    # Pi Web may also load extensions; this is an instruction boundary.
    entries.append({
        "type": "custom", "id": uuid.uuid4().hex[:8],
        "parentId": entries[-1]["id"], "timestamp": entries[-1]["timestamp"],
        "customType": "pi-web:tool-selection",
        "data": {"version": 1, "tools": ["read", "edit", "write", "bash"]},
    })
    entries.append({
        "type": "custom_message", "id": uuid.uuid4().hex[:8],
        "parentId": entries[-1]["id"], "timestamp": entries[-1]["timestamp"],
        "customType": "marinara:repair-handoff", "display": True,
        "content": (
            f"Interactive repair handoff: repair checkout is {cwd}. "
            "The read-only restriction above applied to the completed automated review. "
            "Wait for the user to request a repair before editing or executing commands. "
            "Standing maintainer policy: an explicit OK to fix this merge conflict "
            "authorizes the entire repair-to-deploy sequence, unless the user limits it "
            "(for example, edit only or do not push). Do not ask again at each phase. "
            "Read the user's decisions in this chat first; follow their chosen conflict "
            "policy, including dropping fork-only changelog entries when requested. "
            "Repair only this isolated checkout; never build or reset the experimental "
            "live source. Run frozen dependency install, pnpm check and the workflow's "
            "focused regressions. Verify no unresolved files or conflict markers remain. "
            "Commit the repair and normal-push only to main "
            "on the personal fork palinalif/Marinara-Engine; never force-push or "
            "push to Pasta-Devs upstream. Dispatch Fork "
            "staging sync and wait for its matching run to succeed. Download its "
            "fork-sync-result artifact and use the tested SHA, not the dispatch head SHA. "
            "If sync merged newer upstream changes, build that exact tested SHA in a "
            "fresh isolated checkout. Never claim success from partial progress. "
            "For local deployment, read ~/.local/share/marinara-fork-sync/deployment.md. "
            "If that runbook is missing or compatibility cannot be verified, stop and "
            "report the blocker instead of guessing. Preserve a checksummed rollback "
            "snapshot; deploy compiled output only, restart, verify local and public "
            "health SHA and matching client assets, and roll back on failure. Leave "
            "experimental source, credentials and persistent app data untouched. "
            "Use configured authentication without printing secrets. Use background "
            "tools for long tests, CI waits and deployment. Stop and report failed "
            "checks, new conflicts or unsafe deployment conditions. Publication alone "
            "authorizes none of these actions. These are workflow instructions, not a "
            "filesystem sandbox."
        ),
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
                    or footer[1].get("data") not in (
                        {"version": 1, "tools": []},  # Already-published legacy chat.
                        {"version": 1, "tools": ["read", "edit", "write"]},
                        {"version": 1, "tools": ["read", "edit", "write", "bash"]})):
                raise ValueError("Published chat path has no complete publication footer")
            if footer[1]["data"]["tools"]:
                handoff = existing[original_count + 2:original_count + 3]
                if (not handoff or handoff[0].get("type") != "custom_message"
                        or handoff[0].get("parentId") != footer[1]["id"]
                        or handoff[0].get("customType") != "marinara:repair-handoff"
                        or handoff[0].get("display") is not True
                        or handoff[0].get("content") not in (
                            entries[-1]["content"],
                            entries[-1]["content"].replace(
                                "Commit the repair and normal-push only to main "
                                "on the personal fork palinalif/Marinara-Engine; never force-push or "
                                "push to Pasta-Devs upstream. Dispatch Fork ",
                                "Commit the repair and normal-push only to feat/connection-custom-voice-upload "
                                "on palinalif/Marinara-Engine; never force-push or promote main. Dispatch Fork "),
                            f"Interactive repair handoff: file tools are available in {cwd}. "
                            "The read-only restriction above applied to the completed automated review. "
                            "Wait for the user to request a repair before editing. Only edit ordinary "
                            "project files inside this isolated checkout; do not modify .git, follow "
                            "symlinks outside it, or access host files or credentials. "
                            "Use only read, edit and write for repairs; do not invoke extension tools. "
                            "Commits, pushes, deployment, and shell/test execution require separate "
                            "explicit user approval; none is authorized by publication or a repair request. "
                            "These are workflow instructions, not a filesystem sandbox.")):
                    raise ValueError("Published chat path has no repair handoff")
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

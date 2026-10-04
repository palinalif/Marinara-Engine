#!/usr/bin/env bash
# Real offline Git conflict; mock only GitHub and the model process.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MARINARA_SYNC_STATE="$TMP/state"
export PI_CODING_AGENT_DIR="$TMP/agent"
export PROOF_ROOT="$TMP"
export PROOF_RUN=123 PROOF_ATTEMPT=1 PROOF_ARTIFACT=1 PROOF_FAIL=0 PROOF_SHA_BAD=0
export MARINARA_SYNC_PI="$TMP/pi"
git init -q "$TMP/repo"
git -C "$TMP/repo" config user.name Proof
git -C "$TMP/repo" config user.email proof@example.test
odd=$'voice "quoted"\tfile.txt'
printf 'base\n' > "$TMP/repo/voice.txt"
cp "$TMP/repo/voice.txt" "$TMP/repo/$odd"
git -C "$TMP/repo" add .
git -C "$TMP/repo" commit -qm base
base=$(git -C "$TMP/repo" rev-parse HEAD)
printf 'fork voice workflow\n' > "$TMP/repo/voice.txt"
cp "$TMP/repo/voice.txt" "$TMP/repo/$odd"
git -C "$TMP/repo" commit -qam fork
export PROOF_FORK=$(git -C "$TMP/repo" rev-parse HEAD)
git -C "$TMP/repo" checkout -q --detach "$base"
printf 'upstream voice changes\n' > "$TMP/repo/voice.txt"
cp "$TMP/repo/voice.txt" "$TMP/repo/$odd"
git -C "$TMP/repo" commit -qam upstream
export PROOF_UPSTREAM=$(git -C "$TMP/repo" rev-parse HEAD)
cat > "$TMP/pi" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PROOF_ROOT/agent-calls"
[[ "$PROOF_FAIL" == 0 ]] || exit 1
python3 - "$@" <<'PY'
import json, os, sys, uuid
from pathlib import Path
args = sys.argv[1:]
path = Path(args[args.index('--session') + 1])
entries = [
    {'type': 'session', 'version': 3, 'id': str(uuid.uuid4()), 'cwd': os.getcwd(), 'timestamp': '2026-10-04T00:00:00Z'},
    {'type': 'message', 'id': '11111111', 'parentId': None, 'timestamp': '2026-10-04T00:00:00Z', 'message': {'role': 'user', 'content': 'Investigate conflict', 'timestamp': 1791072000000}},
    {'type': 'message', 'id': '22222222', 'parentId': '11111111', 'timestamp': '2026-10-04T00:00:01Z', 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Preserve both voice changes; tests not run.'}], 'stopReason': 'stop', 'timestamp': 1791072001000}},
]
path.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
PY
printf '# Conflict diagnosis\nPreserve both voice changes; tests not run.\n'
MOCK
chmod +x "$TMP/pi"
gh() {
  if [[ "$1" == api ]]; then
    if [[ "$2" == *status=failure* ]]; then
      printf '%s\t%s\n' "$PROOF_RUN" "$PROOF_ATTEMPT"
    elif [[ "$PROOF_ARTIFACT" == 1 ]]; then
      echo 999
    fi
  else
    local destination=${!#}
    if [[ "$PROOF_SHA_BAD" == 1 ]]; then echo bad > "$destination/fork.txt"; else printf '%s\n' "$PROOF_FORK" > "$destination/fork.txt"; fi
    printf '%s\n' "$PROOF_UPSTREAM" > "$destination/upstream.txt"
    printf '%s\n' "$PROOF_ATTEMPT" > "$destination/attempt.txt"
    echo voice.txt > "$destination/conflicts.txt"
  fi
}
git() {
  if [[ "$1" == clone ]]; then
    command git clone --no-checkout "$PROOF_ROOT/repo" "${!#}" -q
  elif [[ "$1 ${2:-} ${3:-}" == 'remote add upstream' ]]; then
    command git remote add upstream "$PROOF_ROOT/repo"
  else
    command git "$@"
  fi
}
export -f gh git
run() { bash "$ROOT/scripts/fork-sync-conflict-review.sh"; }
PROOF_ARTIFACT=0
run
[[ ! -e "$TMP/agent-calls" ]]
PROOF_ARTIFACT=1 PROOF_SHA_BAD=1
run
[[ -f "$MARINARA_SYNC_STATE/reviews/123-1/skipped" && ! -e "$TMP/agent-calls" ]]
PROOF_RUN=125 PROOF_SHA_BAD=0 PROOF_FAIL=1
if run; then echo 'Accepted model failure' >&2; exit 1; fi
[[ ! -f "$MARINARA_SYNC_STATE/reviews/125-1/done" ]]
before=$(wc -l < "$TMP/agent-calls")
run
[[ $(wc -l < "$TMP/agent-calls") == "$before" ]]
printf '0\n' > "$MARINARA_SYNC_STATE/reviews/125-1/retry-after"
PROOF_FAIL=0
run
review="$MARINARA_SYNC_STATE/reviews/125-1"
[[ -s "$review/report.md" && -f "$review/done" && -s "$review/chat-path" ]]
chat=$(< "$review/chat-path")
[[ -s "$chat" && $(stat -c %a "$chat") == 600 ]]
grep -q 'Marinara merge conflict' "$chat"
grep -q 'Preserve both voice changes' "$chat"
python3 - "$chat" <<'PY'
import json, sys
from pathlib import Path
entries = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
assert entries[-1]['customType'] == 'pi-web:tool-selection'
assert entries[-1]['data'] == {'version': 1, 'tools': []}
assert Path(sys.argv[1]).is_absolute()
PY
[[ $(find "$PI_CODING_AGENT_DIR" -name '*.jsonl' | wc -l) == 1 ]]
# Crash after atomic publication but before marker: no overwrite or duplicate.
sentinel='{"type":"custom","id":"33333333","parentId":null,"timestamp":"2026-10-04T00:00:02Z","customType":"proof","data":"sentinel"}'
printf '%s\n' "$sentinel" >> "$chat"
rm "$review/chat-path"
run
[[ $(tail -n 1 "$chat") == "$sentinel" ]]
# Corrupt or unrelated collisions must not be marked successfully published.
cp "$chat" "$TMP/chat-backup"
printf 'not JSON\n' > "$chat"
rm "$review/chat-path"
run
[[ ! -f "$review/chat-path" ]]
printf '{"type":"session","id":"unrelated"}\n' > "$chat"
run
[[ ! -f "$review/chat-path" ]]
# Matching headers are insufficient: context and both publication entries must exist.
for count in 1 3 4; do
  python3 - "$TMP/chat-backup" "$chat" "$count" <<'PY'
import sys
from pathlib import Path
Path(sys.argv[2]).write_text(''.join(Path(sys.argv[1]).read_text().splitlines(keepends=True)[:int(sys.argv[3])]))
PY
  cp "$chat" "$TMP/incomplete-chat"
  run
  [[ ! -f "$review/chat-path" ]]
  cmp "$chat" "$TMP/incomplete-chat"
done
cp "$TMP/chat-backup" "$chat"
run
[[ -f "$review/chat-path" ]]
[[ $(find "$PI_CODING_AGENT_DIR" -name '*.jsonl' | wc -l) == 1 ]]
grep -q '<<<<<<< HEAD' "$review/source/voice.txt"
grep -q 'fork voice workflow' "$review/stages/2/voice.txt"
grep -q 'upstream voice changes' "$review/stages/3/voice.txt"
grep -q 'upstream voice changes' "$review/stages/3/$odd"
grep -q 'fork voice workflow' "$review/context.txt"
grep -q -- '--model hyperqwen/qwen3.8-27b' "$TMP/agent-calls"
grep -q -- '--no-tools --no-extensions' "$TMP/agent-calls"
before=$(wc -l < "$TMP/agent-calls")
run
[[ $(wc -l < "$TMP/agent-calls") == "$before" ]]
# A publication failure must retry without repeating the completed model turn.
# A permanently malformed completed review must not starve newer reviews.
mkdir -p "$MARINARA_SYNC_STATE/reviews/100-1"
touch "$MARINARA_SYNC_STATE/reviews/100-1/done"
printf 'report\n' > "$MARINARA_SYNC_STATE/reviews/100-1/report.md"
PROOF_ATTEMPT=2
valid_agent=$PI_CODING_AGENT_DIR
export PI_CODING_AGENT_DIR="$TMP/blocked"
touch "$PI_CODING_AGENT_DIR"
if run; then echo 'Accepted publication failure' >&2; exit 1; fi
[[ -f "$MARINARA_SYNC_STATE/reviews/125-2/done" ]]
[[ ! -f "$MARINARA_SYNC_STATE/reviews/125-2/chat-path" ]]
before=$(wc -l < "$TMP/agent-calls")
export PI_CODING_AGENT_DIR=$valid_agent
run
[[ $(wc -l < "$TMP/agent-calls") == "$before" ]]
[[ -f "$MARINARA_SYNC_STATE/reviews/125-2/chat-path" ]]
[[ $(find "$PI_CODING_AGENT_DIR" -name '*.jsonl' | wc -l) == 2 ]]
# Match Pi's tilde expansion, with an absolute recorded destination.
export HOME="$TMP/home" PI_CODING_AGENT_DIR='~/.pi/agent'
# Use a fresh complete review to avoid the existing marker short circuit.
mkdir -p "$TMP/tilde-review"
cp "$review/"{done,report.md,session.jsonl} "$TMP/tilde-review/"
# Header cwd must still refer to this review's source.
python3 - "$TMP/tilde-review" <<'PY'
import json, sys
from pathlib import Path
review = Path(sys.argv[1])
p = review / 'session.jsonl'
entries = [json.loads(line) for line in p.read_text().splitlines()]
entries[0]['cwd'] = str((review / 'source').resolve())
p.write_text(''.join(json.dumps(entry) + '\n' for entry in entries))
PY
# Prove durability ordering: chat, directory and ancestors, marker, rename, review.
python3 - "$ROOT/scripts/fork-sync-publish-chat.py" "$TMP/tilde-review" <<'PY'
import importlib.util, os, stat, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('publisher', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
events = []
fsync, replace = os.fsync, os.replace
def record_sync(fd):
    events.append(Path(os.readlink(f'/proc/self/fd/{fd}'))
                  if stat.S_ISDIR(os.fstat(fd).st_mode) else 'file')
    fsync(fd)
def record_replace(source, destination):
    events.append('replace')
    replace(source, destination)
os.fsync, os.replace = record_sync, record_replace
try:
    review = Path(sys.argv[2]).resolve()
    destination = module.publish(review, '126', '1')
finally:
    os.fsync, os.replace = fsync, replace
directory = destination.parent
assert events == ['file', directory, *directory.parents, 'file', 'replace', review], events
PY
[[ $(< "$TMP/tilde-review/chat-path") == "$HOME/.pi/agent/"* ]]
export PI_CODING_AGENT_DIR=$valid_agent
# Deliberately deleted chats are not silently recreated.
rm "$chat"
run
[[ ! -f "$chat" ]]
# A merge error/nonconflicting pair must never launch a review.
PROOF_RUN=124 PROOF_UPSTREAM="$PROOF_FORK"
before=$(wc -l < "$TMP/agent-calls")
run
[[ -f "$MARINARA_SYNC_STATE/reviews/124-2/skipped" ]]
[[ $(wc -l < "$TMP/agent-calls") == "$before" ]]
[[ ! -f "$MARINARA_SYNC_STATE/reviews/124-2/done" ]]
echo 'PASS: test failure ignored, invalid SHA, actual conflict, read-only model flags, retry/backoff, dedupe, rerun, reproduction guard, quoted/tab paths, atomic chat publication, publication retry, crash dedupe, incomplete collision rejection, durability ordering, deletion respected'

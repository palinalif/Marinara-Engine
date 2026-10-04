#!/usr/bin/env bash
# Real offline Git conflict; mock only GitHub and the model process.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MARINARA_SYNC_STATE="$TMP/state"
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
printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'printf "%s\n" "$*" >> "$PROOF_ROOT/agent-calls"' '[[ "$PROOF_FAIL" == 0 ]] || exit 1' 'printf "# Conflict diagnosis\nPreserve both voice changes; tests not run.\n"' > "$TMP/pi"
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
[[ -s "$review/report.md" && -f "$review/done" ]]
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
PROOF_ATTEMPT=2
run
[[ -f "$MARINARA_SYNC_STATE/reviews/125-2/done" ]]
# A merge error/nonconflicting pair must never launch a review.
PROOF_RUN=124 PROOF_UPSTREAM="$PROOF_FORK"
before=$(wc -l < "$TMP/agent-calls")
run
[[ -f "$MARINARA_SYNC_STATE/reviews/124-2/skipped" ]]
[[ $(wc -l < "$TMP/agent-calls") == "$before" ]]
[[ ! -f "$MARINARA_SYNC_STATE/reviews/124-2/done" ]]
echo 'PASS: test failure ignored, invalid SHA, actual conflict, read-only model flags, retry/backoff, dedupe, rerun, reproduction guard, quoted/tab paths'

#!/usr/bin/env bash
# Offline proof: no GitHub writes, dependency installs, or application builds.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MARINARA_SYNC_STATE="$TMP/state"
export PROOF_LOG="$TMP/calls"
export PROOF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export PROOF_RUN=123
export PROOF_FAIL=0 PROOF_REVIEW_FAIL=0
mkdir -p "$MARINARA_SYNC_STATE/source/.git"

gh() {
  if [[ "$1" == api ]]; then
    if [[ "$2" == *status=failure* ]]; then
      [[ "$PROOF_REVIEW_FAIL" == 0 ]] && return 0
      return 1
    fi
    printf '%s\n' "$PROOF_RUN"
  else
    local destination=${!#}
    printf '%s\n' "$PROOF_SHA" > "$destination/commit.txt"
    echo download >> "$PROOF_LOG"
  fi
}
git() {
  if [[ "$1 $2" == 'remote get-url' ]]; then
    echo https://github.com/palinalif/Marinara-Engine.git
  else
    echo "git $*" >> "$PROOF_LOG"
  fi
}
pnpm() {
  echo "pnpm $*" >> "$PROOF_LOG"
  [[ "$PROOF_FAIL" == 0 ]]
}
export -f gh git pnpm
run() { bash "$ROOT/scripts/fork-sync-local-build.sh"; }

PROOF_SHA=bad
if run; then echo 'Accepted invalid SHA' >&2; exit 1; fi
[[ ! -e "$MARINARA_SYNC_STATE/last-built" ]]
PROOF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PROOF_FAIL=1
if run; then echo 'Accepted failed build' >&2; exit 1; fi
[[ ! -e "$MARINARA_SYNC_STATE/last-built" && ! -e "$MARINARA_SYNC_STATE/last-run" ]]
PROOF_FAIL=0
run
[[ $(<"$MARINARA_SYNC_STATE/last-built") == "$PROOF_SHA" ]]
[[ $(<"$MARINARA_SYNC_STATE/last-run") == "$PROOF_RUN" ]]
before=$(wc -l < "$PROOF_LOG")
run
[[ $(wc -l < "$PROOF_LOG") == "$before" ]]
PROOF_RUN=124
run
[[ $(<"$MARINARA_SYNC_STATE/last-run") == 124 ]]
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 1 ]]
PROOF_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PROOF_RUN=125
PROOF_REVIEW_FAIL=1
run
[[ $(<"$MARINARA_SYNC_STATE/last-built") == "$PROOF_SHA" ]]
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 2 ]]
echo 'PASS: invalid SHA, failure retry, successful build, idempotence, unchanged SHA, newer SHA despite review outage'

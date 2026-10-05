#!/usr/bin/env bash
# Offline proof: fake GitHub/Git/pnpm/deployer; no live mutations or builds.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export MARINARA_SYNC_STATE="$TMP/state" PI_CODING_AGENT_DIR="$TMP/pi"
export PROOF_LOG="$TMP/calls" PROOF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export PROOF_RUN=123 PROOF_FAIL=0 PROOF_REVIEW_FAIL=0 PROOF_DEPLOY_FAIL=0
export PROOF_BRANCH=main PROOF_CONCLUSION=success PROOF_HEAD="$PROOF_SHA" PROOF_CHECKED_OUT=none
export PROOF_EVENT=workflow_dispatch PROOF_REPO=palinalif/Marinara-Engine
mkdir -p "$MARINARA_SYNC_STATE/source/.git" "$TMP/helpers"
cp "$ROOT/scripts/fork-sync-local-build.sh" "$TMP/helpers/"
printf '#!/bin/bash\n[[ "$PROOF_REVIEW_FAIL" == 0 ]]\n' > "$TMP/helpers/fork-sync-conflict-review.sh"
cp "$ROOT/scripts/fork-sync-notify.py" "$TMP/helpers/"
printf 'import os,sys\nwith open(os.environ["PROOF_LOG"],"a") as f: f.write("deploy\\n")\nsys.exit(int(os.environ["PROOF_DEPLOY_FAIL"]))\n' > "$TMP/helpers/fork-sync-deploy.py"
gh() {
  if [[ "$1" == api ]]; then
    if [[ "$2" == *'/actions/runs/'* ]]; then
      printf '{"id":%s,"status":"completed","conclusion":"%s","head_branch":"%s","event":"%s","path":".github/workflows/fork-staging-sync.yml","repository":{"full_name":"%s"}}\n' "$PROOF_RUN" "$PROOF_CONCLUSION" "$PROOF_BRANCH" "$PROOF_EVENT" "$PROOF_REPO"
    else
      [[ "$2" == *'status=success&branch=main&per_page=1' ]] || return 1
      printf '%s\n' "$PROOF_RUN"
    fi
  else
    local destination=${!#}
    printf '%s\n' "$PROOF_SHA" > "$destination/commit.txt"
    echo download >> "$PROOF_LOG"
  fi
}
git() {
  case "$1 ${2:-}" in
    'remote get-url') echo https://github.com/palinalif/Marinara-Engine.git ;;
    'rev-parse FETCH_HEAD') echo "$PROOF_HEAD" ;;
    'rev-parse HEAD') echo "$PROOF_CHECKED_OUT" ;;
    'checkout --detach') printf '%s\n' "$PROOF_SHA" > "$MARINARA_SYNC_STATE/head"; echo "git $*" >> "$PROOF_LOG" ;;
    *) echo "git $*" >> "$PROOF_LOG" ;;
  esac
}
pnpm() {
  [[ -z ${npm_execpath:-} && -z ${npm_config_user_agent:-} && -z ${npm_command:-} ]] || return 1
  echo "pnpm $*" >> "$PROOF_LOG"
  [[ "$PROOF_FAIL" == 0 ]] || return 1
  mkdir -p packages/{shared,server,client}/dist
  printf ok > packages/shared/dist/index.js
  printf ok > packages/server/dist/index.js
  printf ok > packages/client/dist/index.html
}
export -f gh git pnpm
run() {
  if [[ -f "$MARINARA_SYNC_STATE/head" ]]; then export PROOF_CHECKED_OUT=$(<"$MARINARA_SYNC_STATE/head"); fi
  npm_execpath=/usr/bin/npm npm_config_user_agent=pnpm npm_command=exec bash "$TMP/helpers/fork-sync-local-build.sh"
}
fail() { if run; then echo "Accepted $1" >&2; exit 1; fi; }
PROOF_SHA=bad
fail 'invalid SHA'
python3 - "$MARINARA_SYNC_STATE/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s['status']=='failed' and s['sha']=='' and s['run_id']=='123'
PY
PROOF_RUN=bad
fail 'invalid run ID'
python3 - "$MARINARA_SYNC_STATE/status.json" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]))
assert s['status']=='failed' and s['run_id']=='unknown'
PY
PROOF_RUN=123
[[ ! -e "$MARINARA_SYNC_STATE/last-built" ]]
PROOF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PROOF_BRANCH=feature
fail 'non-main run'
PROOF_BRANCH=main PROOF_CONCLUSION=failure
fail 'failed run'
PROOF_CONCLUSION=success PROOF_REPO=other/repo
fail 'other repository'
PROOF_REPO=palinalif/Marinara-Engine PROOF_EVENT=push
fail 'unexpected event'
PROOF_EVENT=workflow_dispatch PROOF_FAIL=1
fail 'failed build'
[[ ! -e "$MARINARA_SYNC_STATE/last-built" && ! -e "$MARINARA_SYNC_STATE/last-run" ]]
PROOF_FAIL=0
run
[[ $(<"$MARINARA_SYNC_STATE/last-built") == "$PROOF_SHA" ]]
[[ $(<"$MARINARA_SYNC_STATE/last-run") == "$PROOF_RUN" ]]
before=$(grep -c '^pnpm build$' "$PROOF_LOG")
run
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == "$before" ]]
PROOF_RUN=124
run
[[ $(<"$MARINARA_SYNC_STATE/last-run") == 124 ]]
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 1 ]] # failed install never reached build
PROOF_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PROOF_HEAD="$PROOF_SHA" PROOF_RUN=125 PROOF_REVIEW_FAIL=1
run
[[ $(<"$MARINARA_SYNC_STATE/last-built") == "$PROOF_SHA" ]]
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 2 ]]
# Opt-in deploy retries even after last-run was set by a build-only installation.
printf '{}\n' > "$MARINARA_SYNC_STATE/deploy.json"
PROOF_DEPLOY_FAIL=1
fail 'failed deployment'
[[ $(<"$MARINARA_SYNC_STATE/last-built") == "$PROOF_SHA" ]]
PROOF_DEPLOY_FAIL=0
run
[[ $(grep -c '^deploy$' "$PROOF_LOG") == 2 ]]
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 2 ]]
# Latest success is obsolete: leave production alone until current main passes.
PROOF_HEAD=cccccccccccccccccccccccccccccccccccccccc
run
[[ $(grep -c '^deploy$' "$PROOF_LOG") == 2 ]]
# Lost output invalidates build cache and triggers a fresh build.
PROOF_HEAD="$PROOF_SHA"
rm "$MARINARA_SYNC_STATE/source/packages/client/dist/index.html"
run
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 3 ]]
[[ $(grep -c '^deploy$' "$PROOF_LOG") == 3 ]]
# Existing entrypoints are insufficient: changed output bytes invalidate cache.
printf corrupt > "$MARINARA_SYNC_STATE/source/packages/server/dist/index.js"
run
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 4 ]]
[[ $(grep -c '^deploy$' "$PROOF_LOG") == 4 ]]
# Same-run build-only mode must still check freshness and output integrity.
rm "$MARINARA_SYNC_STATE/deploy.json"
PROOF_HEAD=cccccccccccccccccccccccccccccccccccccccc
run
python3 - "$MARINARA_SYNC_STATE/status.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['status']=='blocked'
PY
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 4 ]]
PROOF_HEAD="$PROOF_SHA"
printf corrupt > "$MARINARA_SYNC_STATE/source/packages/server/dist/index.js"
run
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 5 ]]
rm "$MARINARA_SYNC_STATE/source/packages/client/dist/index.html"
run
[[ $(grep -c '^pnpm build$' "$PROOF_LOG") == 6 ]]
echo 'PASS: provenance gates, real failure notifications, failure retry, build-only freshness/cache checks, deploy retry, stale main, lost/corrupt-output rebuild, clean pnpm environment'

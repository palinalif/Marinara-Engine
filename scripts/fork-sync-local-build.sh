#!/usr/bin/env bash
# Build successful main syncs; deploy only with explicit host-local opt-in config.
set -euo pipefail
export PATH="/opt/node24/bin:$PATH"
export GIT_TERMINAL_PROMPT=0
# Do not pass pnpm-only launcher arguments to an inherited npm executable.
unset npm_execpath npm_node_execpath npm_config_user_agent npm_lifecycle_event npm_lifecycle_script npm_command npm_package_json
STATE=${MARINARA_SYNC_STATE:-"$HOME/.local/state/marinara-fork-sync"}
REPOSITORY=palinalif/Marinara-Engine
BRANCH=main
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CONFIG=${MARINARA_SYNC_DEPLOY_CONFIG:-"$STATE/deploy.json"}
mkdir -p "$STATE"
exec 9>"$STATE/build.lock"
flock -n 9 || exit 0
run_id=unknown
sha=
notify() {
  local notify_run=$run_id notify_sha=$sha
  [[ "$notify_run" =~ ^[0-9]+$ ]] || notify_run=unknown
  [[ "$notify_sha" =~ ^[0-9a-f]{40}$ ]] || notify_sha=
  python3 "$HERE/fork-sync-notify.py" --state "$STATE" --status "$1" \
    --run-id "$notify_run" --sha "$notify_sha" --message "$2" || \
    echo 'Local status notification failed; will retry on the next tick' >&2
}
on_exit() {
  code=$?
  if [[ "$code" != 0 ]]; then
    notify failed "Watcher failed (exit $code). Inspect $STATE/build.log and runs/*/result.json for production and rollback status."
  fi
  [[ -z ${result:-} ]] || rm -rf "$result"
  exit "$code"
}
trap on_exit EXIT

# Conflict investigation is independent of deployment and still read-only.
if ! bash "$HERE/fork-sync-conflict-review.sh"; then
  echo 'Conflict review failed; will retry on the next watcher tick' >&2
fi
run_id=$(gh api "repos/$REPOSITORY/actions/workflows/fork-staging-sync.yml/runs?status=success&branch=$BRANCH&per_page=1" --jq '.workflow_runs[0].id // empty')
[[ -n "$run_id" ]] || exit 0
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo 'Invalid workflow run ID' >&2; exit 1; }
result=$(mktemp -d "$STATE/result.XXXXXX")
gh api "repos/$REPOSITORY/actions/runs/$run_id" > "$result/run.json"
python3 - "$result/run.json" "$run_id" <<'PY'
import json,sys
run=json.load(open(sys.argv[1]))
assert str(run['id'])==sys.argv[2]
assert run['status']=='completed' and run['conclusion']=='success'
assert run['head_branch']=='main'
assert run['event'] in ('schedule','workflow_dispatch')
assert run['path']=='.github/workflows/fork-staging-sync.yml'
assert run['repository']['full_name']=='palinalif/Marinara-Engine'
PY
gh run download "$run_id" --repo "$REPOSITORY" --name fork-sync-result --dir "$result"
sha=$(<"$result/commit.txt")
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid tested commit SHA' >&2; exit 1; }

# A private checkout only. Never reset, clean, or build the interactive/live tree.
if [[ ! -d "$STATE/source/.git" ]]; then
  git clone --no-checkout --single-branch --branch "$BRANCH" "https://github.com/$REPOSITORY.git" "$STATE/source"
fi
cd "$STATE/source"
[[ $(git remote get-url origin) == "https://github.com/$REPOSITORY.git" ]]
git fetch --no-tags origin "$BRANCH"
git cat-file -e "$sha^{commit}"
# Never deploy a successful but obsolete run over an unvalidated new main.
if [[ $(git rev-parse FETCH_HEAD) != "$sha" ]]; then
  notify blocked 'Fork main has moved since the latest successful CI artifact; awaiting successful CI for current main.'
  exit 0
fi
# Cache trust covers every output byte, not merely the presence of entrypoints.
output_digest() {
  python3 - <<'PY'
import hashlib,pathlib
h=hashlib.sha256()
for package in ('shared','server','client'):
    root=pathlib.Path('packages')/package/'dist'
    if not root.is_dir() or root.is_symlink(): raise SystemExit(1)
    for path in sorted(root.rglob('*')):
        if path.is_symlink(): raise SystemExit(1)
        if path.is_file():
            h.update(str(path).encode()+b'\0')
            h.update(hashlib.sha256(path.read_bytes()).digest())
print(h.hexdigest())
PY
}
cache_ok=0
if [[ -f "$STATE/last-built" && $(<"$STATE/last-built") == "$sha" && $(git rev-parse HEAD) == "$sha" ]]; then
  if git diff --quiet && git diff --cached --quiet && \
     [[ -s packages/shared/dist/index.js && -s packages/server/dist/index.js && -s packages/client/dist/index.html && -f "$STATE/last-built-output" ]] && \
     current_digest=$(output_digest) && [[ "$current_digest" == "$(<"$STATE/last-built-output")" ]]; then
    cache_ok=1
  fi
fi
if [[ "$cache_ok" != 1 ]]; then
  git checkout --detach --force "$sha"
  git clean -ffdx
  pnpm install --frozen-lockfile
  pnpm build
  git diff --exit-code
  git diff --cached --exit-code
  output_digest > "$STATE/last-built-output.tmp"
  mv "$STATE/last-built-output.tmp" "$STATE/last-built-output"
  printf '%s\n' "$sha" > "$STATE/last-built.tmp"
  mv "$STATE/last-built.tmp" "$STATE/last-built"
fi
# Recheck after a potentially long build before allowing any live changes.
git fetch --no-tags origin "$BRANCH"
if [[ $(git rev-parse FETCH_HEAD) != "$sha" ]]; then
  notify blocked 'Fork main moved during the local build; awaiting successful CI for current main.'
  exit 0
fi
mkdir -p "$STATE/proofs/$run_id"
cp "$result/run.json" "$result/commit.txt" "$STATE/proofs/$run_id/"
if [[ -f "$CONFIG" ]]; then
  python3 "$HERE/fork-sync-deploy.py" --source "$STATE/source" --sha "$sha" \
    --run-id "$run_id" --state "$STATE" --config "$CONFIG" --proof "$STATE/proofs/$run_id"
  notify deployed "Verified production at $sha after successful CI run $run_id. See $STATE/runs for evidence and rollback snapshots."
else
  notify built "Built $sha from successful CI run $run_id; deployment is disabled (no host config)."
fi
printf '%s\n' "$run_id" > "$STATE/last-run.tmp"
mv "$STATE/last-run.tmp" "$STATE/last-run"
printf '%s Finished CI run %s (%s)\n' "$(date -u +%FT%TZ)" "$run_id" "$sha"

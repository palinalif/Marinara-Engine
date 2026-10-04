#!/usr/bin/env bash
# Build only SHAs published by a successful fork sync. Never touches the live app.
set -euo pipefail
export PATH="/opt/node24/bin:$PATH"
export GIT_TERMINAL_PROMPT=0
STATE=${MARINARA_SYNC_STATE:-"$HOME/.local/state/marinara-fork-sync"}
REPOSITORY=palinalif/Marinara-Engine
BRANCH=feat/connection-custom-voice-upload
mkdir -p "$STATE"
exec 9>"$STATE/build.lock"
flock -n 9 || exit 0

# Review conflicts independently of successful builds; a provider outage must not
# prevent an already validated application commit from being built.
if ! bash "$(dirname -- "${BASH_SOURCE[0]}")/fork-sync-conflict-review.sh"; then
  echo 'Conflict review failed; will retry on the next watcher tick' >&2
fi

run_id=$(gh api "repos/$REPOSITORY/actions/workflows/fork-staging-sync.yml/runs?status=success&per_page=1" --jq '.workflow_runs[0].id // empty')
[[ -n "$run_id" ]] || exit 0
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo 'Invalid workflow run ID' >&2; exit 1; }
[[ ! -f "$STATE/last-run" || $(<"$STATE/last-run") != "$run_id" ]] || exit 0

result=$(mktemp -d "$STATE/result.XXXXXX")
trap 'rm -rf "$result"' EXIT
gh run download "$run_id" --repo "$REPOSITORY" --name fork-sync-result --dir "$result"
sha=$(<"$result/commit.txt")
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid tested commit SHA' >&2; exit 1; }
if [[ -f "$STATE/last-built" && $(<"$STATE/last-built") == "$sha" ]]; then
  printf '%s\n' "$run_id" > "$STATE/last-run"
  exit 0
fi

# This directory belongs exclusively to this watcher, not an interactive checkout.
if [[ ! -d "$STATE/source/.git" ]]; then
  git clone --no-checkout --single-branch --branch "$BRANCH" "https://github.com/$REPOSITORY.git" "$STATE/source"
fi
cd "$STATE/source"
[[ $(git remote get-url origin) == "https://github.com/$REPOSITORY.git" ]]
git fetch --no-tags origin "$BRANCH"
git cat-file -e "$sha^{commit}"
git merge-base --is-ancestor "$sha" FETCH_HEAD
git checkout --detach --force "$sha"
# Remove only generated/untracked files inside the watcher's private checkout.
git clean -ffdx
pnpm install --frozen-lockfile
pnpm build
printf '%s\n' "$sha" > "$STATE/last-built"
printf '%s\n' "$run_id" > "$STATE/last-run"
printf '%s Built %s in %s/source (not deployed)\n' "$(date -u +%FT%TZ)" "$sha" "$STATE"

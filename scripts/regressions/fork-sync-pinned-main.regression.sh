#!/usr/bin/env bash
# Run the real workflow shell against a non-networked Git stub.
set -euo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 - "$ROOT/.github/workflows/fork-staging-sync.yml" "$TMP/step.sh" <<'PY'
import sys,textwrap
from pathlib import Path
workflow=Path(sys.argv[1]).read_text()
assert 'TARGET_BRANCH: main' in workflow
assert 'ref: main' in workflow
step=workflow.split('        id: merge\n',1)[1].split('        run: |\n',1)[1]
lines=[]
for line in step.splitlines():
    if line.strip() and len(line)-len(line.lstrip()) < 10:
        break
    lines.append(line)
Path(sys.argv[2]).write_text(textwrap.dedent('\n'.join(lines))+'\n')
PY
mkdir "$TMP/bin"
cat > "$TMP/bin/git" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$PROOF_CALLS"
case "$*" in
  'rev-parse HEAD') printf '%s\n' "$PROOF_HEAD" ;;
  'rev-parse upstream/staging') printf '%040d\n' 2 ;;
  config\ *|remote\ add\ *|fetch\ *|merge\ --no-edit\ *) ;;
  *) echo "Unexpected git command: $*" >&2; exit 1 ;;
esac
SH
chmod +x "$TMP/bin/git"
export PATH="$TMP/bin:$PATH" PROOF_CALLS="$TMP/calls"
export PROOF_HEAD=1111111111111111111111111111111111111111
export GITHUB_OUTPUT="$TMP/output" GITHUB_RUN_ATTEMPT=1
: > "$PROOF_CALLS"
EXPECTED_SHA="$PROOF_HEAD" bash "$TMP/step.sh"
[[ $(<"$PROOF_CALLS") == 'rev-parse HEAD' ]]
for invalid in 1111111 2222222222222222222222222222222222222222 '$(touch SHOULD_NOT_EXIST)'; do
  : > "$PROOF_CALLS"
  if EXPECTED_SHA="$invalid" bash "$TMP/step.sh"; then
    echo "Accepted invalid/moved pinned revision: $invalid" >&2
    exit 1
  fi
  if grep -Eq '^(config|remote|fetch|merge)' "$PROOF_CALLS"; then
    echo 'Invalid pinned run mutated or fetched repository state' >&2
    exit 1
  fi
done
: > "$PROOF_CALLS"
EXPECTED_SHA= bash "$TMP/step.sh"
grep -Fxq 'fetch --no-tags upstream staging' "$PROOF_CALLS"
grep -Fxq 'merge --no-edit upstream/staging' "$PROOF_CALLS"
printf 'PASS: pinned main SHA, moved/invalid/injection controls, unchanged default upstream merge\n'

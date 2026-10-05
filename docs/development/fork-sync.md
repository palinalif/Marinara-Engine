# Voice fork daily sync

This automation is specific to `palinalif/Marinara-Engine`; it does not write upstream.

## GitHub schedule

`.github/workflows/fork-staging-sync.yml` runs at **07:17 UTC/GMT** every day and can also be dispatched manually. The off-hour minute reduces exposure to GitHub’s documented top-of-hour congestion; schedules remain best-effort and may start late or be dropped. The workflow must also exist on the fork's default branch (`main`) for the schedule to run; the maintainer has now explicitly promoted the voice fork to that branch.

The job checks out the personal fork's `main`, merges `Pasta-Devs/Marinara-Engine:staging`, runs `pnpm check`, focused voice/TTS/narrator server regressions, Chromium smoke tests and desktop/mobile Chromium voice/narrator tests, then pushes normally. Conflicts or failed checks leave the remote fork `main` unchanged. A concurrent divergent branch update rejects the push; there is no force-push or automated conflict resolution. For an explicitly approved main promotion, dispatch with the optional full `expected_sha` input to validate that exact main revision without merging newer upstream. A moved main branch fails the pinned run before validation or publication. Scheduled runs and dispatches without that input continue to merge upstream.

Successful jobs publish a `fork-sync-result` artifact containing the exact tested SHA. Browser failures publish evidence. Review failures under **Actions → Fork staging sync**; enable GitHub Actions failure notifications in your GitHub notification settings. Scheduled workflows in public repositories may be disabled after 60 days without repository activity; check that Actions remains enabled.

## Automatic conflict investigation

When the merge step leaves unmerged files, GitHub publishes a `fork-sync-conflict` artifact with the exact fork/upstream SHAs, conflict paths and run attempt. The local watcher checks the latest 20 failed sync runs, ignores ordinary test failures, and reproduces the recorded merge in a separate private checkout before launching a **HyperQwen (`hyperqwen/qwen3.8-27b`) read-only subagent**.

The reviewer has **no tools**: conflict diffs and all three merge stages are supplied as input (capped at 100 KB, with an explicit truncation notice). This prevents model access to host credentials or other files. Shell, edits, extensions, project instructions and project resources are disabled. Each review is capped at ten minutes, with at most one review per watcher invocation. Successful reviews are deduplicated by run ID and attempt; failed reviews retry after a one-hour per-run cooldown, allowing other failures to be reviewed in the meantime. Invalid SHA evidence and nonreproducing merges are marked skipped so they cannot block later runs. A conflict-review failure does not block a successful sync's build.

Reports, evidence, three-way merge stages and inspectable Pi sessions are saved under `~/.local/state/marinara-fork-sync/reviews/<run-id>-<attempt>/`; read `report.md` for the diagnosis and suggested resolution. Each completed review is also published as a new local Pi Web chat named **Marinara merge conflict · run <run-id> · attempt <attempt>**, preserving its supplied code context and diagnosis. It appears when the sidebar refreshes; your current chat is not switched. Publication does not run another model turn. The interactive handoff selects `read`, `edit`, `write`, and `bash`; availability is not approval. The completed automated review remains read-only. Under the maintainer's standing policy, an explicit **OK to fix this conflict** authorizes repair → local validation → commit → normal personal-fork `main` push (never upstream) → matching fork-sync CI run → exact-tested-SHA build → local deployment with rollback and health/asset checks, without repeated phase confirmations. A narrower instruction (such as edit only or do not push) overrides that default. Publication alone authorizes no action. Failed checks, new conflicts, missing deployment configuration or unsafe compatibility stop the sequence and are reported. Pi Web may still load host extension tools; these boundaries are workflow instructions, not an enforced filesystem or tool sandbox. A run attempt creates at most one chat, even after a retry or restart; publication failures retry without repeating the review, and deliberately deleted chats are not recreated. The review's `chat-path` file records its published location under Pi's normal session storage (`PI_CODING_AGENT_DIR`, or `~/.pi/agent`). The watcher logs the report path in `build.log`. This is **investigation only**: no automated conflict edits, commits, pushes, deployments or external notifications. The host must be online and its Pi HyperQwen credentials working. Expired artifacts and failures outside the latest 20 failed runs are not reviewed automatically.

The helpers are installed beside the build script as `~/.local/lib/marinara-fork-sync/fork-sync-conflict-review.sh` and `fork-sync-publish-chat.py`; chat publication also requires Python 3. Its Pi executable defaults to the globally installed `/usr/local/bin/pi`; `MARINARA_SYNC_PI` can override that path. Disable reviews without disabling builds by removing the helper (the build watcher will log a warning). Offline proof:

```bash
bash scripts/regressions/fork-sync-conflict-review.regression.sh
```

## Local build watcher

`scripts/fork-sync-local-build.sh` reads only successful main workflow runs and their tested-SHA artifact, independently verifies the run identity, and requires that SHA to remain current fork `main` both before and after building. It builds in its own checkout under `~/.local/state/marinara-fork-sync/source`. Without host deployment configuration it remains build-only. It requires authenticated `gh`, Git, Node 24, pnpm, Python 3, and `flock`. This host uses `/opt/node24/bin`.

Installed on this host as `~/.local/lib/marinara-fork-sync/build.sh`, with this crontab entry:

```cron
*/10 * * * * /usr/bin/env -i HOME=/root PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin /usr/bin/timeout --kill-after=600s 1800 /bin/bash /root/.local/lib/marinara-fork-sync/build.sh >> /root/.local/state/marinara-fork-sync/build.log 2>&1
```

The watcher runs every ten minutes while the host is online. Locking prevents overlapping builds. It reuses intact unchanged builds, retries failures (including deployment failures after a successful build), cleans only its private checkout, and records `last-built` only after a successful frozen-lockfile install and build. Artifacts expire after 14 days, so a host offline longer than that needs a fresh successful sync run. `build.log`, `status.json`, and `runs/*/result.json` contain local results. Deduplicated local Pi Web chats report status transitions without running a model or sending external notifications; publication failures do not invalidate a successful deployment.

To disable local builds, remove only the crontab line containing `marinara-fork-sync/build.sh`. To disable syncing, disable **Fork staging sync** in GitHub Actions. To trigger manually:

```bash
gh workflow run fork-staging-sync.yml --repo palinalif/Marinara-Engine --ref main
```

Offline watcher regression proof:

```bash
bash scripts/regressions/fork-sync-local-build.regression.sh
```

## Opt-in automatic deployment

The same watcher can call `scripts/fork-sync-deploy.py` after a verified build. No additional daemon is needed. Deployment is disabled unless the operator supplies `~/.local/state/marinara-fork-sync/deploy.json` (or `MARINARA_SYNC_DEPLOY_CONFIG`) with `enabled: true` and verified host endpoints. Never copy endpoint guesses from another installation.

The runner accepts `--source`, `--sha`, `--run-id`, `--proof`, `--state`, and `--config`. The proof directory contains the independently fetched `run.json` and successful workflow artifact `commit.txt`; the artifact, not the workflow head SHA, identifies the tested commit. Configuration requires an absolute `live_root`, `local_health_url`, public origin `public_url`, `restart_url`, and a trusted `restart_verification`. Read the runner's module documentation for the verification interface. **Verify the restart behavior before enabling deployment**: a launcher which rebuilds from live source on a commit mismatch is incompatible with dist-only deployment. Prefer inspecting and checksum-pinning the actual restart chain. If host supervisor files are inaccessible, an operator may explicitly invoke `--bootstrap-restart-verification` for one exact-CI deployment with rollback armed. Only verified success on a real source/build SHA mismatch records empirical evidence; point `restart_verification.verified_deployment` at that run's absolute `result.json`. This tests observed behavior, not inaccessible supervisor code, and later unattended runs require the same endpoints and unchanged tracked live source. The watcher never supplies the bootstrap flag. Empirical proof cannot detect changes to inaccessible external supervisor scripts; the operator must disable deployment and reverify after any restart-chain change. It is not a checksum-pinned chain attestation. Every later deployment still verifies the running health identity and assets and attempts rollback on failure.

Before mutation, the runner checks clean source identity, genuine build metadata, complete assets, and matching manifests, dependency lock/workspace, storage format, and server database/migration sources. Incompatible upstream updates stop for manual review; it never installs dependencies in production. It locks deployment, captures fresh checksummed rollback trees and prior health, mirrors all three complete dist trees while preserving bind-mounted root inodes, and restarts with bounded requests. Success requires exact local/public health identity and exact public index-referenced asset bytes. A failed mutation or verification restores the captured build and verifies rollback. Source, Git state, dependencies, credentials, and persistent app data are not deployment targets. Process termination attempts rollback. The watcher timeout gives a ten-minute TERM-to-KILL grace period, exceeding the runner's maximum five-minute verification deadline plus one-minute restart request and allowing time for local restoration. Slow or stalled disk I/O, power loss, or SIGKILL can still require operator recovery.

Evidence and rollback snapshots live under `STATE/runs/`. `last-deployed.json` changes only after verified success. To perform an operator rollback:

```bash
python3 scripts/fork-sync-deploy.py --rollback /absolute/path/to/deployment \
  --state /absolute/path/to/state --config /absolute/path/to/deploy.json
```

Rollback refuses stale snapshots that no longer match the active deployment, but does not require the active service to be healthy. Keep snapshots until the update has been accepted; retention is operator-managed.

After power loss, SIGKILL, or a `rollback_failed` result, stop the watcher before manual recovery. The rollback CLI deliberately cannot recover an interrupted, partially copied deployment. Inspect that run's `result.json`, confirm the recorded live-source fingerprint and dist root device/inode identities still match, and validate each `backup/` tree against `before_trees` before copying. Restore all three complete backup trees with an inode-preserving mirror (never replace their roots), restart through the verified shim, and require the recorded `before_health.commit` locally and publicly plus the saved client's public asset bytes. Do not resume automation or claim recovery until those checks pass; preserve the run evidence for investigation. Disable unattended deployment by removing the host config (builds continue), or stop the watcher crontab while investigating a failure. Successful daily CI may deploy automatically only after this explicit host opt-in; conflict repairs still require maintainer approval. The host runbook remains at `~/.local/share/marinara-fork-sync/deployment.md`.

Offline deployment and notification proofs:

```bash
python3 scripts/regressions/fork-sync-deploy.regression.py
python3 scripts/regressions/fork-sync-notify.regression.py
```

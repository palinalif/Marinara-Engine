# Voice fork daily sync

This automation is specific to `palinalif/Marinara-Engine`; it does not write upstream.

## GitHub schedule

`.github/workflows/fork-staging-sync.yml` runs at **07:00 UTC/GMT** every day and can also be dispatched manually. GitHub schedules are best-effort and may start late. The workflow must also exist on the fork's default branch (`main`) for the schedule to run; installing that workflow file alone does not promote application changes to `main`.

The job checks out `feat/connection-custom-voice-upload`, merges `Pasta-Devs/Marinara-Engine:staging`, runs `pnpm check`, focused voice/TTS/narrator server regressions, Chromium smoke tests and desktop/mobile Chromium voice/narrator tests, then pushes normally. Conflicts or failed checks leave the remote feature branch unchanged. A concurrent divergent branch update rejects the push; there is no force-push or automated conflict resolution.

Successful jobs publish a `fork-sync-result` artifact containing the exact tested SHA. Browser failures publish evidence. Review failures under **Actions → Fork staging sync**; enable GitHub Actions failure notifications in your GitHub notification settings. Scheduled workflows in public repositories may be disabled after 60 days without repository activity; check that Actions remains enabled.

## Local build watcher

`scripts/fork-sync-local-build.sh` reads only successful workflow runs and their tested-SHA artifact. It builds in its own checkout under `~/.local/state/marinara-fork-sync/source`; it never edits the interactive checkout, copies files into the live app, restarts services, or modifies app data. It requires authenticated `gh`, Git, Node 24, pnpm, and `flock`. This host uses `/opt/node24/bin`.

Installed on this host as `~/.local/lib/marinara-fork-sync/build.sh`, with this crontab entry:

```cron
*/10 * * * * /usr/bin/env -i HOME=/root PATH=/opt/node24/bin:/usr/local/bin:/usr/bin:/bin /usr/bin/timeout --kill-after=30s 1800 /bin/bash /root/.local/lib/marinara-fork-sync/build.sh >> /root/.local/state/marinara-fork-sync/build.log 2>&1
```

The watcher runs every ten minutes while the host is online. Locking prevents overlapping builds. It skips unchanged SHAs, retries failures, cleans its private checkout (including ignored build output), and records `last-built` only after a successful frozen-lockfile install and build. Artifacts expire after 14 days, so a host offline longer than that needs a fresh successful sync run. Check `build.log` for local failures; there is no external local-build notification service.

To disable local builds, remove only the crontab line containing `marinara-fork-sync/build.sh`. To disable syncing, disable **Fork staging sync** in GitHub Actions. To trigger manually:

```bash
gh workflow run fork-staging-sync.yml --repo palinalif/Marinara-Engine --ref main
```

Offline watcher regression proof:

```bash
bash scripts/regressions/fork-sync-local-build.regression.sh
```

The build watcher is **not a deployment mechanism**. Serving its output automatically would need a separate restart/health-check/rollback step and explicit live-deployment authorization.

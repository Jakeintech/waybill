# Waybill on Windows

Short version: **the engine is pure Node and runs everywhere; only the
two hook scripts assume a `bash`.** And because metering is retroactive
and idempotent, even a machine where the hooks never fire loses no data —
the hook is a convenience trigger, not a data dependency.

## What works out of the box

Every engine command — `init`, `mine`, `meter`, `query`, `status`,
`verify`, `export` (packs included), `dashboard` — is a single
dependency-free Node bundle (`bin/waybill.mjs`, Node ≥ 20). PowerShell,
cmd, Git Bash, WSL: all fine. `$WAYBILL_HOME` defaults under your user
profile; paths are handled by Node, not by shell.

## The hooks

The plugin registers two hooks (`hooks/hooks.json`), both invoked as
`bash "${CLAUDE_PLUGIN_ROOT}/scripts/…"`:

- `SessionEnd` → `capture-session.sh` queues the session and spawns the
  detached miner.
- `SessionStart` → `session-start.sh` prints at most one pacing/first-run
  line.

They run unchanged wherever a `bash` is on `PATH`:

- **Git for Windows** (most developers have it): Git Bash's `bash.exe`
  satisfies the hook commands as-is.
- **WSL**: running Claude Code inside WSL is effectively the Linux story;
  everything applies verbatim.

## No bash? Run the catch-up instead

Without the SessionEnd hook, sessions simply wait in your local
transcripts. Metering them later produces byte-identical events (the
determinism suite enforces this), so a periodic catch-up is a full
substitute:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT\bin\waybill.mjs" mine --all
```

Run it manually before you ask waybill anything (the skills do it
themselves), or schedule it:

```powershell
schtasks /Create /SC HOURLY /TN "waybill-mine" /TR "node <plugin-path>\bin\waybill.mjs mine --all"
```

The one real caveat: transcript **retention**. If Claude Code's
`cleanupPeriodDays` is low, transcripts can be pruned before an unmined
session is captured — that is a data loss on any OS; the hook just makes
the window smaller. `waybill status` reports your retention setting;
raise it and the catch-up path is as safe as the hook path.

## Honest limit

This port story is reasoned from the engine's design (pure Node, no
shell in the metering path) and CI runs on Linux; a native-Windows
end-to-end report is a welcome contribution — especially hook behavior
under Git Bash across Claude Code versions.

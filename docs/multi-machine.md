# One ledger, several machines

`$WAYBILL_HOME` is already a git repository (`waybill init` creates it,
commits every append, and ignores the rebuildable parts). That makes
multi-machine a git workflow, not a sync feature: point the home at a
**private** remote and the ledger follows you. Nothing here touches the
network on waybill's side — you run the pushes and pulls; `waybill status`
reports where you stand from local refs only.

## Why this works (and where the edges are)

The data model was built for it:

- **Append-only monthly shards.** Nothing rewrites a stream line, so two
  machines appending to the same shard produce a line-level union, not a
  real conflict. `waybill init` writes a `.gitattributes` with
  `streams/**/*.jsonl merge=union`, so git resolves a crossed append by
  keeping both sides' lines.
- **Order-independent reads.** Event ids are deterministic (content
  hashes) and supersession links by id, so the merged line order carries
  no meaning. A union merge cannot change any query's answer.
- **Machine-local state stays machine-local.** `meter_state.json` (meter
  checkpoints), `pending-sessions/`, and `rollups/` are gitignored. Each
  machine meters its own transcripts; sessions live on exactly one
  machine, so their usage events never collide.

The one edge: if two machines append the **same** event (say, both apply
the same sync plan before pulling), the union merge keeps two
byte-identical lines and `waybill verify` flags the duplicate id. That is
the honest outcome — and because the lines are byte-identical, the fix is
mechanical and safe:

```bash
awk '!seen[$0]++' streams/ledger/2026-08.jsonl > /tmp/dedup && mv /tmp/dedup streams/ledger/2026-08.jsonl
git -C "$WAYBILL_HOME" commit -am "ledger: dedupe crossed append"
```

(Only ever dedupe *byte-identical* lines; anything else is a real finding
for `verify` to explain.)

## Setup

First machine (existing home):

```bash
# Create a PRIVATE repository first — the ledger carries tracker keys,
# titles, and repo names. Never a public remote.
git -C "$WAYBILL_HOME" remote add origin git@github.com:you/waybill-ledger.git
git -C "$WAYBILL_HOME" push -u origin main
```

Additional machines:

```bash
git clone git@github.com:you/waybill-ledger.git "$WAYBILL_HOME"
waybill init      # idempotent: hooks, retention check, machine-local bits
waybill status    # should end green, with the remote line
```

## Routine

Pull before you log, push when you stop:

```bash
git -C "$WAYBILL_HOME" pull   # start of the workday on this machine
# ... work; waybill appends and commits locally ...
git -C "$WAYBILL_HOME" push   # end of the workday
```

`waybill status` keeps you honest about it:

```
remote: origin/main — 2 ahead, 0 behind (as of last fetch 2026-08-22T09:14:02Z)
```

The counts come from local refs, so "behind" is only as fresh as your
last fetch — status says so rather than pretending to know. A home with
no remote gets one line pointing here; a home that is behind gets the
pull command.

## What not to do

- Don't point two machines' *live* Claude Code sessions at one home over
  a network filesystem — the miner's lock and atomic renames assume a
  local disk. The git remote is the transport; each machine works on its
  own clone.
- Don't rebase or squash the home repo. Append-only history is the audit
  property; `git pull` (merge) is the right default here.
- Don't add the remote to a public repository, and don't push
  `identity.json` anywhere you wouldn't paste your git email list.

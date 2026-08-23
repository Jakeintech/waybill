# The OTel fallback — a live-export recipe

The transcript is waybill's source of truth (FR-M1); OpenTelemetry is the
**fallback** for the one failure mode transcripts have: pruning. If a
session's transcript is deleted before it is mined, its tokens are gone
from the primary source — `waybill status` shows it as a `meter_gap`.
With Claude Code telemetry exported to a file, those totals are
recoverable:

```bash
waybill meter --otel <export.jsonl>
```

`--otel` fills **transcript-less sessions only** — a session metered from
its transcript is never mixed with or overwritten by OTel data, and if a
transcript later reappears, transcript metering supersedes the OTel
events wholesale. Attribution still runs (branch evidence isn't in the
metrics, so expect more `unattributed`/repo-default resolution), and
conservation is checked the same way.

## Producing the export file

Claude Code emits the `claude_code.token.usage` metric when telemetry is
enabled. Waybill reads OTLP-JSON lines (one export payload per line).
The reliable pipeline is Claude Code → OTLP → a local collector with a
file exporter:

1. Enable telemetry where Claude Code runs:

   ```bash
   export CLAUDE_CODE_ENABLE_TELEMETRY=1
   export OTEL_METRICS_EXPORTER=otlp
   export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
   ```

2. Run a minimal collector that writes JSON lines
   (`otelcol-contrib --config otel-file.yaml`):

   ```yaml
   receivers:
     otlp:
       protocols:
         http:
           endpoint: 127.0.0.1:4318
   exporters:
     file:
       path: /var/lib/waybill/otel-export.jsonl
   service:
     pipelines:
       metrics:
         receivers: [otlp]
         exporters: [file]
   ```

3. When a gap appears (`status` names the session), backfill:

   ```bash
   waybill meter --otel /var/lib/waybill/otel-export.jsonl
   ```

## When to bother

Most users never need this: the better fix for pruning is retention
(`cleanupPeriodDays` high enough that the miner always wins the race —
`waybill status` checks it). Run the OTel pipeline when transcripts are
aggressively cleaned by policy, when sessions run on ephemeral machines
whose disks vanish, or when you want a second, independent record of
totals on principle. The collector runs locally; nothing about this
recipe sends your data anywhere waybill's promises forbid — the exporter
endpoint above is loopback, and the export file lives on your disk.

Two operational notes from live validation: start the collector before
the session (metrics that arrive with no listener are dropped, not
queued), and remember exports flush on an interval — for short sessions
either wait a few seconds after exit or lower
`OTEL_METRIC_EXPORT_INTERVAL` (ms) while testing.

**Validated live (2026-08-23):** this recipe, exactly as written above —
Claude Code 2.1.241 with the four env vars → otelcol-contrib 0.112.0
running the yaml verbatim → file exporter → `waybill meter --otel` on
the produced export ingested the session (`+1 usage event(s) across 1
session(s)`), `waybill verify` green, `query spend` showing the
session's exact token total. Fixture-tested in `tests/unit/otel.test.ts`
(shape, fill-gaps-only, transcript-wins supersession); the exact metric
attributes it reads are documented in `src/meter/otel.ts`.

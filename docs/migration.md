# Schema freeze & migration policy (1.0)

As of 1.0, **schema v2 is frozen**. The fact schemas — the event envelope,
the four streams, `config.json`, `identity.json`, `meter_state.json` — are
the product's compatibility surface, and SemVer is enforced against them:

| Change | Release | What it means for your data |
|---|---|---|
| New **optional** field on an event or config object | minor | Nothing. Old events without the field stay valid forever; `waybill verify` recomputes ids from content as written, so grandfathered events never churn. |
| New stream, new event kind, new CLI subcommand | minor | Nothing. Unknown kinds in newer homes are ignored by older engines. |
| Renaming/removing a field, changing a field's meaning or type, changing id derivation, changing the shard rule | **major** (schema v3) | Ships with a migration tool and a written migration guide, never silently. |

## Rules the freeze rests on

1. **Append-only is forever.** No migration will ever rewrite a stream line
   in place. A v3 migration writes new streams alongside the old and leaves
   the originals untouched; verify learns to check both.
2. **Ids are content.** An event's ULID derives from its bytes. Additive
   fields only appear on newly written events; recomputation of an old
   event's id uses the fields it actually has. This is why additive changes
   are safe: nothing old ever re-derives differently.
3. **Version markers travel with data.** Every event carries
   `schema_version`; `meter_state.json` carries the rules/pricing versions
   each session was metered under. An engine that encounters a
   `schema_version` newer than it understands says so and refuses to write
   — it never guesses.
4. **The escrow payload format (`estimate.v1`) is frozen independently.**
   A future `estimate.v2` would be a new payload tag; v1 seals verify
   forever.

## Grandfathered fields (pre-freeze additions)

- `usage.waste` and ledger `reopened` (added in 1.0): optional; events
  written before 1.0 simply lack them. Re-meter with
  `waybill meter --all --force` to backfill waste on historical sessions if
  you want it; nothing requires you to.
- `usage.source: "otel"` (added in 0.4): sessions metered from OTel carry
  it; transcript events predate it unchanged.

## What "frozen" does not mean

Projections (`rollups/`, `waybill query` output shapes) are **not** frozen:
they are derived, deletable, and may improve in any release. The receipts
are the contract; the reports are the rendering.

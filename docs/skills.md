# Skill Reference

Waybill's skills follow one naming scheme: **a single plain word — verb where
it acts, noun where it informs.** The plugin prefix carries the brand
(`/waybill:sync`), so skill names stay short, predictable addresses; the
frontmatter *description* carries the trigger phrases and does the discovery.
The deterministic engine is intentionally **not** a skill — it is a single
dependency-free executable, `bin/waybill.mjs` (subcommands: `init`,
`bootstrap`, `mine`, `meter`, `append`, `resolve`, `verify`, `query`,
`pace`, `status`, `export`, `pricing`, `sync-plan`), invoked by hooks and
skills, so the automatic path never depends on a model call (see the
[product spec](product-spec.md), §5.7).

## The skills

| Skill | Invocation | Kind | Purpose | Say things like |
|---|---|---|---|---|
| `ledger` | `/waybill:ledger` | knowledge | Storage layout, entry schema, and integrity rules; loads whenever entries are read or written | "initialize my waybill ledger", "what's in my ledger" |
| `log` | `/waybill:log` | action | Open a task (pre-register the without-Claude estimate), ship it, or mine queued sessions into entries | "I'm starting PLAT-482, log it", "log this — the PR merged", "process my pending sessions" |
| `sync` | `/waybill:sync` | action | Reconcile the ledger with your Jira issues and GitHub PRs; derive baselines; first run offers the bootstrap report | "sync my ledger", "import my history", "reconcile my ledger" |
| `report` | `/waybill:report` | action | One-page, receipt-linked outputs: `token-pitch`, `perf-review`, `sprint-recap`, `quarterly`, bootstrap | "build my token pitch", "sprint recap", "help me with my performance review" |
| `forecast` | `/waybill:forecast` | action | Size the next token ask from committed work × your historical rates | "how many tokens should I ask for", "draft my token request" |
| `spend` | `/waybill:spend` | action | Spend analytics ("what did PLAT-482 cost?"), budget pacing, and the attribution inbox | "where am I spending", "how's my burn", "resolve my attribution inbox" |

## Naming decisions (recorded)

- **`log`, not `log-work`.** Renamed in 0.2.1: shorter invocation, verb-first,
  and consistent with the other action skills; the namespace removes any
  ambiguity about *what* is being logged.
- **`ledger` stays a noun.** It names the core data structure, which is a
  protected concept in [brand.md](brand.md); the skill documents that
  structure rather than performing an action.
- **Reserved words never used as skill names:** `waybill` (the plugin),
  every engine subcommand (`init`, `bootstrap`, `mine`, `meter`, `append`,
  `resolve`, `verify`, `query`, `pace`, `status`, `export`, `pricing`,
  `sync-plan`), `inbox` (a surface
  inside `spend`, not a skill), and the brand concept names
  (`evidence tiers`, `open spend`, `pre-registration`).

## Rules for new skills (contributors)

1. One lowercase word; a verb if it acts, a noun if it informs.
2. No collisions with the reserved words above or brand concept names.
3. The frontmatter `name` must match the directory (CI enforces this).
4. Put every canonical trigger phrase, quoted, in the description — the name
   is the address; the description is the discovery. Trigger-test before the
   PR (see [CONTRIBUTING](../CONTRIBUTING.md)).

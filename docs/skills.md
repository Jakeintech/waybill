# Skill Reference

Waybill's skills follow one naming scheme: **a single plain word — verb where
it acts, noun where it informs.** The plugin prefix carries the brand
(`/waybill:sync`), so skill names stay short, predictable addresses; the
frontmatter *description* carries the trigger phrases and does the discovery.
The deterministic engine is intentionally **not** a skill — it is a single
dependency-free executable, `bin/waybill.mjs` (subcommands: `init`,
`bootstrap`, `mine`, `meter`, `append`, `resolve`, `verify`, `query`,
`pace`, `status`, `export`, `pricing`, `sync-plan`, `conventions`,
`dashboard`), invoked by hooks and
skills, so the automatic path never depends on a model call (see the
[product spec](product-spec.md), §5.7). Skills invoke it through the
`bin/waybill` launcher (`"${CLAUDE_PLUGIN_ROOT}/bin/waybill" <command>`) —
never `node <path>.mjs`, whose unquoted-variable form silently broke on
zsh; the validator enforces this.

**The export-pack boundary** (same principle, output side): document
rendering stays out of the engine. The engine emits numbers and structured
data (`query`, `export` — CSV/JSON); skills render prose and Markdown; any
formatted document beyond that (HTML, DOCX, PDF) is a handoff to the host's
document tooling, never an engine feature. Prose is Claude's job; numbers
are the engine's. A renderer in the engine would put presentation code
inside the deterministic, conservation-checked path — that boundary is what
keeps `verify` meaningful.

## The skills

| Skill | Invocation | Kind | Purpose | Say things like |
|---|---|---|---|---|
| `ledger` | `/waybill:ledger` | knowledge | Storage layout, entry schema, and integrity rules; loads whenever entries are read or written | "initialize my waybill ledger", "what's in my ledger" |
| `log` | `/waybill:log` | action | Open a task (pre-register the without-Claude estimate), ship it, or mine queued sessions into entries | "I'm starting PLAT-482, log it", "log this — the PR merged", "process my pending sessions" |
| `sync` | `/waybill:sync` | action | Reconcile the ledger with your Jira issues and GitHub PRs; derive baselines; first run offers the bootstrap report | "sync my ledger", "import my history", "reconcile my ledger" |
| `report` | `/waybill:report` | action | One-page, receipt-linked outputs: `token-pitch`, `perf-review`, `sprint-recap`, `quarterly`, bootstrap | "build my token pitch", "sprint recap", "help me with my performance review" |
| `forecast` | `/waybill:forecast` | action | Size the next token ask from committed work × your historical rates | "how many tokens should I ask for", "draft my token request" |
| `spend` | `/waybill:spend` | action | Spend analytics ("what did PLAT-482 cost?"), budget pacing, and the attribution inbox | "where am I spending", "how's my burn", "resolve my attribution inbox" |
| `standup` | `/waybill:standup` | action | "What did I do" digests from the ledger: shipped, in progress, opened, session/token totals, for any day or range | "what did I do yesterday", "prep my standup", "weekly digest" |
| `salvage` | `/waybill:salvage` | action | Turn untracked work into receipts: cluster unattributed/unlogged spend, propose titles from the receipts, one tap per cluster | "group my untracked work", "clean up my unattributed spend", "what did I forget to log" |
| `retro` | `/waybill:retro` | action | The honest look back: shipped + cost, estimate calibration (above-range included), model mix, waste/rework, cache savings, what sat | "run my retro", "how did my estimates hold up", "how did the sprint actually go" |
| `invoice` | `/waybill:invoice` | action | Billing paperwork from the receipts: client invoice pack (line items, recorded hours, disclosed AI costs) and the personal expense receipt | "prepare my invoice", "invoice my client", "expense my Claude usage" |
| `disclose` | `/waybill:disclose` | action | Per-item AI-involvement statements the meter can back: recorded role, sessions, tokens, share — single item or a window's register | "was AI used on PLAT-482", "build my AI disclosure", "AI involvement report" |

## Naming decisions (recorded)

- **`log`, not `log-work`.** Renamed in 0.2.1: shorter invocation, verb-first,
  and consistent with the other action skills; the namespace removes any
  ambiguity about *what* is being logged.
- **`ledger` stays a noun.** It names the core data structure, which is a
  protected concept in [brand.md](brand.md); the skill documents that
  structure rather than performing an action.
- **`standup`, not `yesterday` or `digest`.** It names the ritual the
  output serves — the noun users already say ("prep my standup") — where
  `yesterday` names only one of its windows and `digest` says nothing
  about which one. The engine half is a `query` projection
  (`query standup`), not a subcommand, so the name stays available for
  the skill.
- **`salvage`, not `untracked` or `cleanup`.** A verb (it acts), and the
  shipping term for recovering unmanifested cargo — which is literally
  what it does. The engine half is a `query` projection
  (`query untracked`), so the noun stays available as the data's name.
- **`retro`, not `retrospective` or `calibration`.** The word teams
  actually say for the ritual it serves; `calibration` names one section
  of the pack, not the pack. Pure rendering — every number it shows
  already exists on `query report`/`manifest`/`untracked`, so no engine
  name is consumed at all.
- **`invoice` and `disclose`, not more `report` presets.** Presets share
  an audience (a decision-maker reading about value); these two serve
  different readers with different vocabularies — a client paying for
  hours, a policy asking about AI involvement — and their trigger phrases
  ("invoice my client", "was AI used on…") would never find the report
  skill. Both are pure renderings; `disclose` is a verb on purpose:
  disclosure is something the user does, never something done to them.
- **Reserved words never used as skill names:** `waybill` (the plugin),
  every engine subcommand (`init`, `bootstrap`, `mine`, `meter`, `append`,
  `resolve`, `verify`, `query`, `pace`, `status`, `export`, `pricing`,
  `sync-plan`, `conventions`, `dashboard`), `inbox` (a surface
  inside `spend`, not a skill), and the brand concept names
  (`evidence tiers`, `open spend`, `pre-registration`).

## Rules for new skills (contributors)

1. One lowercase word; a verb if it acts, a noun if it informs.
2. No collisions with the reserved words above or brand concept names.
3. The frontmatter `name` must match the directory (CI enforces this).
4. Put every canonical trigger phrase, quoted, in the description — the name
   is the address; the description is the discovery. Trigger-test before the
   PR (see [CONTRIBUTING](../CONTRIBUTING.md)).

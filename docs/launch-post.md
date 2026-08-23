# I built a token meter, then ran it on the session that built it

<!-- Launch-post draft (docs/ROADMAP.md distribution checklist). Rules:
     1. Every number below is raw engine output — the exact commands are
       shown beside each block. NEVER retype or adjust a figure; to
       refresh, re-run the commands against your own ledger.
     2. These numbers came from metering the (remote) Claude Code
       session that built 2.1.0, engine at that commit. Before posting,
       consider re-rendering from your local machine's fuller history:
       init meters everything, then `query cache` / `query spend`.
     3. Suggested venues: dev.to, r/ClaudeAI, r/ClaudeCode (include the
       what-I-learned element below), Hacker News, the Claude Discord.
       Proposed Show HN title (finding, not tool, <80 chars):
         Show HN: 99% of my Claude Code tokens were cache reads,
         billed at a tenth
     4. Human sign-off required on final wording before posting
       (see the 2.1.0 handoff). -->

My team allocates Claude Code tokens the way finance allocates anything:
you get a grant, and at renewal someone asks what it was worth. Last
cycle I watched a colleague answer that question from memory, in
adjectives, the night before. They got discounted — not because the work
wasn't real, but because nothing they said was *checkable*.

So I built the boring thing: an accounting system. **Waybill** is a
Claude Code plugin that meters every token from the local transcripts —
subagent transcripts included — attributes each one to the story it
served, and renders the receipts into the artifacts that decide an
engineer's year: the token-budget pitch, the review packet, the standup,
the invoice, the disclosure register.

Then I pointed it at the Claude Code session that was building it.

## What the meter found (waybill on waybill)

Raw engine output — `waybill query cache`, over the session that built
release 2.1.0:

```json
"tokens": {
  "input": 608,
  "output": 255071,
  "cache_read": 102428828,
  "cache_creation": 604563,
  "cache_creation_5m": 19028,
  "cache_creation_1h": 585535
},
"total_tokens": 103289070,
"cache_read_pct": 99.2,
"billed": {
  "effective_usd": 126.8972,
  "list_equivalent_usd": 1042.7483,
  "saved_usd": 915.8511,
  "cache_read_share_of_billed_pct": 80.7,
  "covered_pct": 100,
  "basis": "list_price_equivalent_derived"
},
"unattributed_pct": 100
```

Three things I did not expect to be *this* pronounced:

1. **99.2% of the tokens were cache reads.** "103 million tokens"
   sounds alarming until the receipt shows the shape: 102.4M of them
   were cache reads billed at a tenth of the input rate. Actual typed
   input across the whole build: 608 tokens. The headline number everyone quotes —
   "tokens used" — is almost entirely the cheapest class.
2. **The effective bill was $126.90 against a $1,042.75 list-equivalent**
   for the same volume uncached — a derived figure, computed from the
   current rate table and labeled so (`basis:
   "list_price_equivalent_derived"`), write premiums (1.25× for
   5-minute, 2× for 1-hour cache entries) already netted out. Prompt
   caching is not a rounding error; it is the bill.
3. **`unattributed_pct: 100` — and the tool prints it.** This session
   ran on an automation branch with no tracker keys, so the resolver
   refused to guess and booked everything to `unattributed`. That line
   is the product working: on a normal repo, branch keys, commit
   evidence, and one-tap pins move spend onto the stories it served —
   and whatever remains unattributed *stays visible in every report*.
   The unflattering number is what makes the flattering ones
   believable.

What I learned building it: I had shipped a metering bug that made
exactly this kind of number silently wrong — the walker never descended
into subagent transcript directories, so on a measured real session
28.6M of 41.8M tokens were invisible to the meter. The conservation
check (Σ per-turn usage = session receipt totals, per session) could
not catch it, because it checks the meter against its own parse — an
internal-consistency guarantee, not a completeness oracle. The fix
ships in 2.1.0, subagent files metered as sessions of their own; the
lesson — say precisely what each verification mechanism does and does
not prove — is now written into the docs and the pack README.

## How it stays honest

The interesting problems were all honesty problems:

- **Counterfactuals are gameable**, so "hours without Claude" estimates
  only count when they're **pre-registered** — logged *before* the
  work and SHA-256-sealed at write time. The seal proves the entry
  hasn't been edited since a copy was shared; write-time ordering is
  enforced separately (logged_at ≤ entry ts, wall-clock skew check at
  append, and verify discloses estimates written long after their
  claimed logged_at). There is deliberately no way to add tier-3
  evidence after the fact.
- **Meters drift**, so every session's per-turn usage must sum exactly
  to the session receipt's totals — re-checkable offline with
  `waybill verify`. Event ids are content hashes; edit a line and it no
  longer matches its own id.
- **History gets rewritten**, so the ledger is append-only JSONL in a
  local git repo. Corrections supersede; nothing is edited.
- **And the recipient shouldn't have to trust any of this**, so
  `waybill export --pack` ships the verbatim events behind a report
  plus the engine itself. The person reading your pitch runs
  `node waybill.mjs verify --home .` and re-checks the seals and the
  conservation themselves. No network, no install. Sessions whose
  transcripts were pruned before metering are disclosed in the pack,
  not papered over.

The metering path has no model calls and no network at all — it's one
dependency-free Node bundle reading your own transcripts on your own
machine. Claude's part is rendering prose around numbers it is never
allowed to compute.

## What it refuses to do

No manager dashboards, no peer comparison, no hosted service, no time
tracking. It reads *your* assigned issues and *your* authored PRs;
the adapters drop other people's records even when a mis-scoped query
fetches them. Those are commitments in the spec, with tests.

## Try it

```bash
claude plugin marketplace add Jakeintech/waybill
claude plugin install waybill@waybill
# restart Claude Code, then:
#   "initialize my waybill ledger"   (60s, zero auth; meters your existing transcripts)
#   "why is my bill like this"       (the cache receipt above, for your ledger)
#   "sync my ledger"                 (Jira/GitHub/Linear/GitLab/ADO/Bitbucket optional)
#   "what did I do yesterday"        (standup from the ledger)
#   "build my token pitch"
```

Repo: <https://github.com/Jakeintech/waybill> — MIT, engine + skills +
the full product spec and the recorded adversarial architecture review.
Honest limits and all: the adapters table says exactly which paths have
live end-to-end reports and which still want one. Bring receipts.

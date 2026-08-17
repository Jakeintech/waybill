# Trigger evals

Skill descriptions are the UI, and skills chronically undertrigger — these
cases check that each skill fires on its canonical phrase (and that none
fires on an unrelated one). Run them with an authenticated Claude Code CLI:

    claude plugin eval waybill@waybill --threshold 0.8

CI runs the suite automatically when an `ANTHROPIC_API_KEY` secret is
configured (see .github/workflows/ci.yml); the job is skipped otherwise, so
forks without keys stay green. `plugin eval` is early-access — if the case
layout drifts from the CLI's expectations, regenerate with
`claude plugin eval init` and port the criteria.

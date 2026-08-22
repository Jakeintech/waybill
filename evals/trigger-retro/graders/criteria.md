Pass if the assistant loads the waybill `retro` skill and renders the
look-back from engine queries: runs catch-up metering (`mine --all`), then
`query report` for the window (calibration, model mix, waste/rework, cache
savings) plus `query manifest`/`query untracked` for what sat unshipped,
states the window, reports estimate calibration honestly — including any
items whose actual hours came in ABOVE the pre-registered range — and
closes with factual observations only. Fail if it hides or softens
above-range calibration entries, invents process advice the numbers don't
support, compares the user to peers, treats the request as a formal report
or a daily standup instead, or answers from memory without engaging the
waybill plugin.

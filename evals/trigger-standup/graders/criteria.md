Pass if the assistant loads the waybill `standup` skill and answers from
the ledger: runs catch-up metering (`mine --all`) and `query standup` for
yesterday's window, then renders short bullets of shipped items, metered
work in progress, and newly opened entries, each traceable to ledger
facts. Fail if it answers from conversation memory or invents
accomplishments, pads an empty window instead of saying nothing was
recorded, mixes in unlabeled non-ledger items, or never engages the
waybill plugin.

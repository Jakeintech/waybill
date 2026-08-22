Pass if the assistant loads the waybill `salvage` skill and drives the
engine's clustering: runs catch-up metering (`mine --all`) and
`query untracked`, presents the clusters with their receipts (sessions,
branches, tokens, date ranges), proposes titles drawn only from those
receipts, and asks for one confirmation per cluster before appending any
reconstructed entry. Fail if it invents titles or tracker keys the
receipts don't show, backfills a pre-registered estimate onto
reconstructed work, bulk-applies without per-cluster confirmation, or
never engages the waybill plugin.

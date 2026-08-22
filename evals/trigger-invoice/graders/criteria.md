Pass if the assistant loads the waybill `invoice` skill and renders the
client invoice pack from engine queries: runs catch-up metering
(`mine --all`), queries the report for the billing window at internal
audience, renders shipped entries as line items with recorded
`actual_hours` (never estimates or time-saved counterfactuals presented
as hours), discloses AI involvement with per-item metered cost labeled
as list-price equivalent, and leaves pricing/rates to the user. Fail if
it invents hours or prices, presents `estimate_without_claude_hours` or
`time_saved_hours` as billable time, pseudonymizes the client's own work
items (external audience), or never engages the waybill plugin.

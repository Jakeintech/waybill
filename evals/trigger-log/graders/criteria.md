Pass if the assistant loads the waybill `log` skill and starts the
pre-registration flow: it asks for a without-Claude estimate as a RANGE in
hours before any other work, and intends to write the entry through
`waybill append` (never hand-built JSONL). Fail if it logs the task without
asking for the estimate range, backfills `pre_registered`, or never engages
the waybill plugin.

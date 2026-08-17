Pass if the assistant loads the waybill `forecast` skill and uses metered
rates (`query forecast`) with the low-confidence label when the basis is
thin, stating the planning buffer explicitly. Fail if it produces a number
with no ledger basis and no label, or never engages the waybill plugin.

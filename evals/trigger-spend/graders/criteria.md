Pass if the assistant loads the waybill `spend` skill (or report skill) and
answers from the engine: it runs `mine --all` (catch-up) and `query spend`
with a week window, and presents per-account numbers including the
unattributed share. Fail if it estimates numbers itself, hides
unattributed, or never engages the waybill plugin.

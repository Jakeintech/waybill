Pass if the assistant loads the waybill `disclose` skill and answers from
the meter: runs catch-up metering (`mine --all`), pulls the item's shipped
row / story spend from engine queries, and states the recorded
`claude_role` (labeled as the user's declaration), metered sessions and
tokens (labeled as measured assistance volume, never an authorship
percentage), the ship receipt, and the verification basis
(conservation-checked, event ids on request). Fail if it blends role and
tokens into an invented "AI wrote N%" figure, answers from memory without
engaging the waybill plugin, hides metered tokens on a role-none item, or
discloses anything about other people's work.

Pass if the assistant loads the waybill `spend` skill (or otherwise
engages the waybill plugin) and serves the zero-token dashboard: it runs
(or clearly prepares to run) `"${CLAUDE_PLUGIN_ROOT}/bin/waybill"
dashboard` and tells the user to open the generated
`rollups/dashboard.html`, noting the miner keeps it fresh. Fail if it
fabricates dashboard numbers inline, builds an ad-hoc HTML page by hand,
or never engages the waybill plugin.

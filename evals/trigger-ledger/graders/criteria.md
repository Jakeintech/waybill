Pass if the assistant loads the waybill `ledger` skill and begins ledger
initialization: it runs (or clearly prepares to run) the engine's `init`
subcommand through the plugin launcher
(`"${CLAUDE_PLUGIN_ROOT}/bin/waybill" init`), and reports the
transcript-retention setting rather than asking configuration questions
first. Fail if it hand-creates files, invents a different storage layout,
or never engages the waybill plugin.

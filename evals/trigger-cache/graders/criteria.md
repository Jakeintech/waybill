Pass if the assistant loads the waybill `cache` skill and answers from
the engine: it runs (or clearly prepares to run)
`"${CLAUDE_PLUGIN_ROOT}/bin/waybill" query cache` (after a catch-up
`mine --all`), and frames the answer in cache terms — volume by tier,
the cache-read share, effective vs list cost labeled as derived from the
current rate table. Fail if it estimates or invents dollar figures,
answers from generic knowledge about Anthropic pricing without reading
the user's metered ledger, or never engages the waybill plugin.

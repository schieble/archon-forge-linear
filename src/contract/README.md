# Archon forge contract (vendored)

Unmodified copies of `packages/forge/src/{identity,lifecycle,checks,events,operations,response-match,plugin-config,remote-url}.ts`
from coleam00/Archon at f47aa2bbf298c3c9bd69abafcc2a270939e6babf.
The plugin parses requests with these schemas, and its tests check every response against them and
against the host's own result matcher (`matchesForgeOperationResponse`). To follow a newer
Archon commit, recopy them with `scripts/sync-contract.sh <archon-checkout>`.

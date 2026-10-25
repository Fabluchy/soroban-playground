# Deployment pre-flight

The playground Build & Deploy panel now requires a pre-flight result before
enabling deployment. Choose Localhost Quickstart, Testnet, Futurenet or Mainnet,
generate or enter a 32-byte hexadecimal salt, then run the checks. Mainnet has a
distinct real-funds warning and requires confirmation after successful checks.

The checklist is tied to the actual server CLI signer, not an unrelated browser
wallet. Configure `SOROBAN_SOURCE_ACCOUNT` with that CLI identity. The server
resolves only its public address with `keys address`; no private key is returned
to the browser. Account signer weight and medium threshold are verified. RPC
simulation must succeed, and additional address-based contract authorization is
rejected instead of being represented as available.

Checks use parallel account, ledger, fee, network and code/address lookups, then
simulate the next upload or creation operation. The UI reports actual elapsed
time. The <500ms target depends on CLI identity resolution and external network
latency and is pending live measurement; network failures/timeouts fail closed.
These reads do not sign, upload, fund or broadcast a transaction.

Native XLM arithmetic uses integer stroops, including the ledger's actual base
reserve, subentries, sponsorship and selling liabilities. Fee estimates include
twice the simulated resource fee plus inclusion fees. When WASM is not uploaded,
creation cannot yet be simulated: the UI explicitly reserves an additional
1 XLM creation budget and reports that limitation. Configure that allowance with
`DEPLOY_CREATE_FEE_RESERVE_STROOPS`. It is an estimate, not a fee guarantee. The
CLI performs its normal final simulation; this does not bypass its safety checks.
Expired code and occupied contract addresses block the checklist.

The deterministic address is derived from the network ID, source-account address
and salt using Stellar's XDR contract-ID preimage. WASM content is not part of
that address preimage. The exact salt and network passphrase are passed to the
CLI. Automatic WASM optimization is disabled for guarded deployment so the
checked bytes/hash are retained. The returned address must match the preview.

Results expire after 30 seconds, and changing the network, salt, artifact or
compilation status invalidates approval. The deploy endpoint rechecks live state
and the expected WASM hash before spawning the CLI, even if the browser previously
passed. Guarded Mainnet requests also require confirmation on the server. Legacy
API clients that omit the new optional pre-flight descriptor keep their existing
behavior; the playground always supplies it.

Per-network backend overrides are `SOROBAN_<NETWORK>_RPC_URL`,
`SOROBAN_<NETWORK>_HORIZON_URL`, and
`SOROBAN_<NETWORK>_NETWORK_PASSPHRASE` (`NETWORK` is LOCAL, TESTNET,
FUTURENET or MAINNET). Localhost defaults to Quickstart on port 8000. Futurenet
availability depends on its configured service; an unavailable endpoint remains
blocked. The RPC's reported passphrase must match the selected network.

Tests cover address derivation against the SDK's real operation preimage,
integer balance boundaries, liabilities/sponsorship, signer thresholds, live and
expired code, collisions, changed artifacts, simulation/network failures,
Mainnet confirmation, client invalidation/expiry and server revalidation. No live
deployment is performed by these tests. A local-network deployed-address match,
live network latency and deployment signing remain pending integration evidence.

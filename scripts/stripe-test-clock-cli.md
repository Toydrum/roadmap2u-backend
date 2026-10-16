# Test clock caller: local process boundary

`run-stripe-test-clock.ts` is the process entry point. It composes the existing
authority, Windows journal, ownership reader, AWS/Stripe observers, conditional
transaction/readback and provider advance. It does not create fixtures, discover
credentials, change permissions, log in, retrieve SSM secrets or retry operations.

Arguments are exactly one mode (`--preview` or `--execute`) plus `--source-root`,
`--review-root` and `--manifest`. The roots are absolute paths; the manifest is a
relative path below the review root. Unknown/duplicate arguments are rejected.
No credential, API key, endpoint, stage override or authorization belongs in argv.

A trusted local coordinator supplies one UTF-8 JSON packet over private stdin.
The process bounds input to 512 KiB and ten seconds and emits one sanitized JSON
result. It neither echoes the packet nor persists it. Do not supply real private
packets through chat, command history, committed files or redirected diagnostic logs.

Preview accepts exactly `schemaVersion: 1` and `requestRaw` (the exact serialized
request). It validates the manifest/request digest and uses the canonical business
preparers. It emits hashes and request limits without snapshots or private IDs.
It does not claim current source, ownership, human authorization or remote state.
The older offline `stripe-test-clock-preview.ts` remains a transaction inspector.

Execute additionally requires `authorizationRaw`, `credentials` (temporary
`accessKeyId`, `secretAccessKey`, `sessionToken`, ISO `expiration`), `apiKey`
(restricted `rk_test_` key), `cliConfigPath`, `cliCredentialsPath` and `caBundlePath`.
The approval must come from the actual human response to the exact committed
manifest. A synthetically authored receipt is not human authorization. The CLI
checks the receipt binding; it does not authenticate its human producer.

Execute opens the already reviewed NTFS journal without changing its ACL. It
uses the manifest's PowerShell/CA pins and revalidates actual committed source,
reviewed manifest, credentials, ownership and business/provider observations.
A durable reservation prevents the same approval from being reused after restart.
There are at most six ownership CLI reads plus 11 SDK requests for install, ten
for ready/refresh or 14 for advance_fence. A phase has at most one DynamoDB write
request/readback and, for advance_fence only, one Stripe advance after the exact
verified fence. An advance acknowledgement never publishes ready evidence.

The SDK adapters use explicit pinned CA verification, fixed DEV/TEST endpoints,
finite response sizes and absolute request deadlines. They do not follow redirects
or select endpoints from stdin. The process always uses the native adapters;
constructor ports in the library exist for isolated tests, not command options.

Exit codes: `0` preview or verified completion, `1` stopped before verified
completion, `2` rejected input/preparation, `3` uncertain outcome/cleanup. An
uncertain result is not permission to repeat the command. Preserve its journal
and prepare a separate read-only recovery inventory.
A lost write acknowledgement can return verified completion only when the exact
atomic readback proves application. Missing or failed readback stays uncertain;
neither case resends the write. Preview also rejects expired provider clocks.

Local Git/NTFS/SDK/loopback tests do not authorize physical execution. Runtime and
permission inventory, fresh physical manifests/approvals, fixture isolation,
bounded recovery and authenticated PWA DEV/TEST acceptance remain separate gates.
PROD and historical non-clock billing sources remain outside this caller.

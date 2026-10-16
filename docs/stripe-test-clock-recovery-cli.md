# Read-only clock recovery CLI

Entry: `scripts/run-stripe-test-clock-recovery.ts`. This is an operator tool,
separate from the application and from the write-side clock caller.

## Inputs

Exactly seven metadata arguments are accepted:

    --preview|--execute --source-root <absolute> --review-root <absolute> --manifest reports/<reviewed-file>.json

The manifest must be a bounded regular file within the review checkout. Its strict
`clock_recovery_read_only` schema fixes DEV/TEST, the isolated synthetic owner,
Customer/clock, AWS resources and caller, committed source, separate native attempt
and optional prior journal identities, PowerShell executable/hash, AWS CLI
executable/hash and CA hash. The prior paid historical subscription is never a
clock fixture. There is no PROD mode.

Private stdin is bounded UTF-8 JSON, never an argument or environment discovery
source. A terminal, malformed/oversized input, unknown fields, path traversal or
credentials supplied to preview are rejected. No secret lookup, login, profile
resolution or role assumption is performed.

Preview packet: `schemaVersion: 1`, plus `originalRequestRaw` and `savedIntent`
only when the manifest includes original readback. Preview produces no authority,
transport, native attempt or API request. It does not prove committed-source or
human authorization checks have passed.

Execute adds exactly `authorizationRaw`, `credentials`, `apiKey`, `cliConfigPath`,
`cliCredentialsPath`, `caBundlePath` and `caBundleSha256`. Credentials must be
temporary ASIA credentials with a session token and canonical ISO expiration.
Only a restricted `rk_test_` key is accepted. The private CLI files and pinned CA
are validated by the existing ownership/native transport boundary. Secrets remain
in memory or the private child-process environment and are omitted from results.

## Read sequence

1. Six AWS CLI reads: caller, stack, app table, privacy table, pool, stack again.
2. Six AWS SDK reads: caller, both table descriptions, disabled synthetic identity,
   one atomic eight-item snapshot and one complete financial query (limit 100).
3. Three Stripe GET: exact account, Customer and clock. Expired, advancing,
   internal-failure or exact missing-clock observations are diagnostic facts.
4. If reviewed and available, one atomic readback of the exact original operation.

The combined budget is 15 reads without the original, 16 with it. The pinned SDK
transport separately limits its nine/ten requests. A complete query is required;
there is no automatic pagination or retry. Source, review, journal, helper, CA,
credentials and the time window are checked again around reservations/delegations.
AWS CLI executable bytes are checked before each child process. The new reply is
consumed once in a separate exclusive native record. The original journal stays
read-only, and missing original bytes are not reconstructed.

## Results

Exit 0 means the bounded diagnostic reads completed. It does not mean the clock is
readable or financial recovery is approved. Exit 3 means uncertain original proof
or cleanup; exit 1 means the coordinator stopped; exit 2 means input/preparation was
rejected. Fixed error codes and counts are safe to retain. No arbitrary provider or
child-process error is echoed. Raw customer/profile/financial data is omitted.

All outputs retain `physicalExecutionAllowed: false`, `retryAllowed: false`, zero
remote writes/advances and no provider-ready evidence. These fields prevent an
operator result from being used as a general execution capability. A fresh direct
human reply, matching manifest and existing physical permissions are still required
for a reviewed real read-only run. Nothing here authorizes a repair, write replay,
clock advance, fixture creation, identity/flags changes, deployment or payment.

Local validation uses real Git, NTFS/PowerShell and SDK serialization with memory
cloud transports. The process-entry smoke covers private-stdin preview. It does not
prove a physical AWS/Stripe session or authenticated temporal PWA acceptance.

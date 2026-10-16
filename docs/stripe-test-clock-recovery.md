# Read-only clock recovery components

An interrupted clock operation must be diagnosed before any new financial
operation is proposed. These private library components collect scoped facts
and optionally inspect the original transaction's exact atomic readback. They
perform no transaction write, journal reservation, clock advance, repair or
ready publication. They are not a recovery CLI or physical authorization.

## Readers and bounds

| Component | Maximum delegated requests | Result |
| --- | ---: | --- |
| `prepareClockAwsObserver({kind: 'recovery', ...})` | 6 AWS reads | Current identity, two table descriptions, disabled synthetic identity, eight-item atomic snapshot and one bounded financial-partition query |
| `prepareClockStripeRecoveryObserver(...)` | 3 Stripe GET | Bound account, Customer and diagnostic clock status |
| `prepareClockRecoveryReadback(...)` | 1 DynamoDB read | Canonical inspection of the exact original transaction items |

The future coordinator also needs six ownership reads. Its maximum inventory
is therefore **16 reads**, including the optional original readback. An earlier
local procedure estimated 15 and omitted the AWS observer's independent STS
identity check. That check remains mandatory. No physical window is authorized
by this document or by the previous caller's consumed approval.

Each SDK request is counted at the actual handler boundary before delegation.
The readers accept explicit transports, clocks, budgets and credentials; they
discover no profile or key and assume no role. Retries are disabled and an
instance is consumed once, including after failure. A throwing or asynchronous
budget reservation prevents delegation. Freshness is checked again after a
synchronous reservation, before delegating the request.

## Facts do not authorize a repair

AWS recovery retains an absent or present financial state, mirror, mapping,
subscription source, closure, restore exclusion and financial rows. It requires
the intended account/caller, active table schemas and exact disabled Cognito
fixture. Its single query is limited to 100 rows and rejects pagination,
inconsistent counts and another owner's partition. Partial installation facts
remain private diagnostic input; they do not satisfy installation's empty-state
guards. Existing install and transition modes retain their business checks.

The eight-item snapshot is atomic. The partition query, ownership reads and
Stripe reads are separate observations, not one cross-service atomic snapshot.
A future coordinator must compare their scope, freshness and business facts
before proposing any next operation. The components return
`physicalAuthorizationChecked=false` and do not verify source/stack ownership.

Stripe still verifies the account, Mexico, the exact non-live Customer,
owner/stage/integration metadata and its bound clock. Recovery can report
`ready`, `advancing`, `internal_failure` and expiration as facts. Only a
`404/resource_missing` response from the already scoped clock GET is reported
as `clock_not_found`; failures for account/Customer or other errors stop.
Recovery produces no ready evidence, extends no expiration and permits no
retry. The normal Stripe observer still uses the canonical ready validator.

## Exact original readback

The optional reader requires the original private request bytes, their SHA-256,
the original source SHA and the saved journal intent. It reconstructs the
canonical plan and rejects a mismatch before any delegated request. Intent
metadata alone must never be used to invent or replace the original bytes.

The installed SDK serializes one `TransactGetItems` request in memory first;
only that exact request, endpoint, target and item order can be delegated.
Explicit temporary credentials and handler references are captured before
asynchronous preparation yields. Reads have a deadline, abort their signal and
destroy their owned transport. Output excludes credentials, signed headers,
request bodies and raw transport errors.

`inspectClockWriteReadback` remains the authority for the result: all exact
items can prove `verified_applied` even after a lost acknowledgement. A missing,
changed, reordered or failed read remains `uncertain`, with no write or replay.
Verification of an old transaction does not make its expired financial clock
readable. The result always preserves `retryAllowed=false` and
`physicalExecutionAllowed=false`.

## Local validation and remaining work

The focused AWS/Stripe/readback suite has 142 passing cases, including the
unchanged publication-mode regressions. Tests use the actual installed SDK
serialization/deserialization with synthetic credentials and memory-only cloud
handlers. Type checking passes. Native TLS code and tests are unchanged from
the parent publication candidate; their prior 17 passing cases are separate
evidence and are not rerun by the broader recovery regression command.

```powershell
$env:ROADMAP2U_FRONTEND_PATH = '<checkout of pinned frontend 8a16b90>'
npm run typecheck
npm test -- --exclude test/billing-clock-native-transport.test.ts
```

Fresh authority binding, source/stack ownership, native composition/CLI, actual
permissions, bounded physical recovery and authenticated/visual DEV/TEST clock
acceptance remain pending. The earlier synthetic restart drill retained the
original bytes in the coordinator's memory; it does not prove recovery after
a reboot that loses those bytes. Preserve the existing journal and historical
non-clock paid/cancelled subscription. No hosted state, contract, Lambda, IAM,
workflow, fixture, secret or flag is changed by this local implementation.

# Clock caller: source, receipt and resource ownership

These components implement the local approval and ownership preflight needed by
the future physical clock caller. They discover no credentials, read no SSM
secret, assume no role and expose no financial write or execution CLI.
`physicalExecutionAllowed` remains false. Native Windows storage and ACL checks
are implemented in the [durable journal](stripe-test-clock-durable-journal.md).
The [approval attempt](stripe-test-clock-approval-attempt.md) adds consumption
across processes for ownership reads. Full caller composition, recovery and
temporal PWA acceptance remain separate requirements.

## Exact reviewed operation

`verifyClockCallerAuthority` accepts the reviewed manifest and the exact private
request as UTF-8 strings in memory. The manifest contains:

- `schemaVersion`, `sourceSha`, `operationId` and one phase: `install`,
  `advance_fence`, `ready` or `refresh`;
- `requestSha256` over every byte of the request, and
  `targetFrozenTimeSeconds` for an advance, otherwise null;
- the existing clock fixture scope, storage scope and expected AWS caller ARN;
- the exact CloudFormation stack ARN and logical/physical bindings of the app
  table, privacy table and Cognito User Pool.

A durable attempt additionally requires the exact native journal directory,
directory identity and ACL digest in the reviewed manifest. Legacy manifests
remain usable for evidence verification but cannot reserve a durable attempt.

The existing fixture selector rejects PROD/live, crossed or duplicate fixtures
and the historical monthly QA owner. Tables must use the canonical DEV/TEST
names in account765932874577/us-east-1. Three distinct resource bindings and the
canonical stage backend stack are mandatory.

The verifier checks the private request's digest, phase, operation, owner,
storage, scope, operational freshness and advance target. It invokes the real
`prepareClockJournal` and business preparers, preserving their checks for age,
closed purchases, disabled identity, minors, closure, restore exclusion,
mapping, state, leases and evidence. It retains that exact prepared plan in
process memory. `readClockCallerPlan` returns a copy with the original
transaction/readback hashes; it cannot accept a replacement caller plan.

## Local direct-human receipt and source

The receipt is supplied in memory. Its exact fields are `source`, `callId`,
`consumed`, `answer`, `manifestSha256`, `approvedRootCommit`, `issuedAt` and
`expiresAt`. `source` must be `direct_human_async_reply`; a goal continuation,
generic answer, consumed receipt, changed hash, future issuance or expired
window is rejected. The window is at most15 real minutes. The exact answer is:

```text
Autorizar reloj <DEV|TEST> <phase> <operationId>
```

This validates the supplied receipt's binding. The trusted caller is responsible
for recording an actual direct-human response; the function does not
authenticate a person or create a human response. The raw approval is never
saved by these components or tests. Native attempt records contain only the
bounded metadata/digests described in the approval-attempt document.

Native Git verifies the configured source remote, exact HEAD and clean tracked
and untracked state. The executing module must be a regular tracked file inside
that source root with the committed content. Only CRLF-to-LF checkout conversion
is accepted for this comparison. The reviewed manifest's actual bounded file
must match its in-memory hash and its blob in `approvedRootCommit`; that commit
must remain an ancestor of the review checkout. Escaping paths, symlinks,
descriptor growth and arbitrary dependency errors are rejected with fixed codes.

The result is an immutable in-process authority object. Its WeakMap binding
rejects objects fabricated from booleans, copies and serialized/reloaded data.
An ownership observation consumes the receipt binding once in the process,
including when another authority object is verified from the same receipt.
The native attempt reservation consumes that call in the exact reviewed journal
before the ownership wrapper delegates any read. It cannot resume an existing
attempt after a restart or failure. Full caller composition remains pending.

## Six bounded ownership reads

`prepareClockOwnershipObserver` requires that authority object and an explicit
copy of temporary ASIA credentials with sufficient remaining lifetime. It does
not use a profile or a credential provider. The future caller can resolve its
existing MFA-origin session once and pass the same memory-only credentials.

The default adapter invokes the installed native AWS CLI with fixed arguments,
region/endpoints, no pagination or prompt, one maximum attempt and bounded
timeouts/output. Two regular empty configuration files prevent profile fallback;
a pinned public CA bundle is checked before each request and again after its
reservation. AWS overrides and unrelated Stripe variables are removed from the
inherited environment. Credentials are supplied only in the child environment,
never in argv, receipts or output.

It performs these serial reads once:

1. STS identity matching the approved account and ARN.
2. The named immutable CloudFormation stack, in an accepted stable status.
3. Its exact app table logical/physical/type binding.
4. Its exact privacy table binding.
5. Its exact Cognito User Pool binding.
6. The same stack again, with the same identity/status/update timestamps.

Every delegation requires a successful synchronous reservation; thenables are
rejected and their failures absorbed before any delegation. Failure, timeout,
changed files/context, pagination, malformed UTF-8 or a second invocation cannot
produce another send. A timeout propagates AbortSignal to the native adapter.
Only controlled codes, counters and approved resource metadata are returned.

CloudFormation resource ownership and live DynamoDB schema checks serve
different purposes. The existing AWS observer remains responsible for active
table schemas, disabled Cognito identity and the current atomic business
snapshot. Stripe observation and request/readback/journal fences also remain
mandatory before any write or provider advance.

## Validation and remaining work

Tests use the real Git executable, temporary isolated repositories and a bundle
of the actual implementation. Approval receipts and private requests exist only
in memory. CloudFormation/STS responses are simulated at the CLI adapter boundary;
no AWS, Stripe, SSM or credential lookup occurs. Temporary paths are checked to
remain inside their owned test directory before recursive cleanup.

The tests cover every phase and exact request binding, review ancestry/source
drift, automatic/consumed/stale receipts, historical ownership, resource and stack
crossing, rejected/async reservations, one-use replay, timeouts, configuration/CA
changes, caller mutation, response bounds, private-error handling and environment
isolation. The full caller still must require the native journal capability and
attempt, verify permissions, fresh remote AWS/Stripe facts and approved scope,
and compose the existing bounded writers with recovery.
The normal and temporal PWA journeys and
independent DEV/TEST/live acceptance are still required.

CloudFormation response semantics were checked against the official
[DescribeStackResource](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeStackResource.html),
[StackResourceDetail](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_StackResourceDetail.html)
and [DescribeStacks](https://docs.aws.amazon.com/AWSCloudFormation/latest/APIReference/API_DescribeStacks.html)
references. No cloud ownership or financial acceptance is claimed by local tests.

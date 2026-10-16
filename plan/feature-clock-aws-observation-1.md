# Current AWS observation for the trusted clock publisher

Continue the approved trusted-publisher design locally from a8e123c. The existing
preview accepts recorded snapshots; this component collects the corresponding
current AWS facts through the installed SDKs and a mandatory supplied transport.
It does not provide a physical CLI or authorize a cloud operation.

1. Capture scope, temporary credentials, exact caller ARN, Cognito pool and all
   dependencies before awaiting. Reuse the existing fixture selection and reject
   PROD/live, historical owners and crossed canonical table ARNs before IO.
2. Read in order: STS identity, two table descriptions, disabled fixture Cognito
   identity, eight-item atomic application/privacy snapshot, and one complete
   financial-partition query for installation only. Transition observation omits
   the query. Verify account/caller, active table names/ARNs/string keys, exact
   fixture sub, response keys and complete query; never paginate or retry.
3. Freeze SDK serialization offline. At each real HTTP seam require the exact
   endpoint, operation and body, reserve one send, enforce wall-time freshness,
   temporary-credential lifetime and a bounded timeout. Destroy the supplied
   transport once. SDK errors and credentials never become receipts or logs.
4. Return a private in-memory install/transition snapshot usable by the existing
   transaction preparers, plus sanitized counts. Source/human authorization and
   CloudFormation ownership verification remain the future caller's work; no
   physical readiness claim is made. Test first with the actual SDKs and local
   handlers, including drift, malformed/paginated responses, uncertainty,
   credential/input mutation, timeout, budgets and duplicate invocation. Retain
   the existing 369 focused tests, types and unchanged runtime/contracts/deps.

No account, secret, flag, IAM, Stripe, deployment or financial operation is part
of this local implementation. Full PWA and independent DEV/TEST acceptance remain
mandatory; the temporal-client choice is still unanswered.

Local validation completed: the missing module first failed import, then a
non-implemented entry failed all 42 original cases. Implementation passed those
cases and all 369 retained cases. Review added 15 cases for actual SDK wire
mutation, missing dependencies, cleanup error sanitization and composition with
the real business guards. The final source passed **57 new + 369 retained = 426
tests in twelve files** and TypeScript. Two fixture-only type mismatches were
corrected. No physical AWS/Stripe requests or credential discovery occurred in
these tests. CloudFormation ownership, exact source/human authority, physical
caller/CLI, recovery and full client acceptance remain pending.

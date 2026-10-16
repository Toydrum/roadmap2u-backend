# Local clock evidence publisher core

Base: backend 923642e98cb3482af031149cf65aec305caf7d4d, isolated branch codex/stripe-clock-publisher-local. This implements the evidence-publisher component of the human-approved scoped-clock design. The prepared 923642e publication packet and all historical fixtures remain unchanged.

The approved component verifies same-sandbox Customer/TestClock membership, explicit synthetic ownership, ready state and monotonic time/revision. Its physical read/write window is separate. This local core is pure: it prepares evidence transitions and existing mirror conditions; it has no SDK client, credentials, CLI entrypoint, network, table writes, clock advance or identity/financial operation.

1. Add failing behavior tests against the actual clock reader for initial evidence, stale refresh and invalidation/ready publication.
2. Implement a pure planner in scripts/stripe-test-clock-evidence.ts using the existing canReadTestClock, resolveFinancialClock and testClockGuard protocol.
3. Enforce a fixed one/two-fixture scope, unique owner/Customer/clock/binding IDs, DEV/TEST only, explicit provider read context, bounded real observation time, and the protected historical monthly owner exclusion.
4. Derive financial seconds only from verified ready provider observations. Before an advance, prepare an advancing mirror that the actual reader rejects. Publish a newer ready revision only for the recorded target and observations after invalidation. Refresh requires the same frozen time; advancing without the invalidation protocol is rejected.
5. Initial output requires atomic installation of its reference with the mirror before admission; no installation adapter is included. Refresh/advance outputs carry the exact existing mirror condition. Actual atomic state/mapping installation, transport, readbacks, retry/uncertainty handling and physical executor remain necessary follow-up work.
6. Run the new cases with the 68 existing clock cases and typecheck; save local source and evidence. Do not rerun the completed full suite for an unimported pure operator module.

Stripe's public API defines ready/advancing/internal_failure and frozen_time in seconds: https://docs.stripe.com/api/test_clocks/object. Advance is asynchronous and requires later ready observation: https://docs.stripe.com/api/test_clocks/advance. Customer.test_clock establishes membership: https://docs.stripe.com/api/customers/object. These public references were checked on 2026-10-13; they do not prove account permissions or authorize provider calls.

Acceptance is this local core only. Normal PWA/Checkout/Portal, offline/recovery and temporal client compatibility remain required, separate acceptance. Physical rollout and production are incomplete.

Local validation completed: 46 new cases first failed because no publisher core existed. The first implementation passed those plus the 68 existing clock cases. Three review cases then reproduced coerced missing strings and mutable condition aliasing; those were corrected before the final **117 cases / four files** and typecheck passed. There are 49 publisher cases and 68 existing reader cases. Runtime, contracts, workflows and dependencies are unchanged. This does not represent a repeated full backend suite or any physical publication/advance.

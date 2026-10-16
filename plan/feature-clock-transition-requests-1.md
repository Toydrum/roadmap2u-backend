# Local protected clock transition requests

Base: ecb53b14330b31c4c1b2f9b123a9a9873144906c. Continue the approved publisher locally; 923642e publication and the historical monthly fixture remain unchanged.

1. Add failing tests for refresh, pre-advance invalidation and post-advance ready transactions against real initial-install output and the actual clock reader.
2. Reuse storage, owner, disabled-identity, closure/restore and closed-flags validation from the initial installer; keep that installer's 40 cases and packing behavior.
3. Each transition writes only a conditionally fenced mirror and a financial audit. It must not change financial STATE, mapping, sources, access or PROFILE. Guard the exact observed state revision/reference and an absent/expired real operational lease, plus the exact existing scoped mapping and common safety records.
4. Reject closed/lost/rebound state, crossed mirror snapshots, active leases, missing/foreign mapping and wrong transition/operation. A ready write must match the pending advance operation and target; refresh cannot silently move time. A retained earlier valid reference may remain behind a newer mirror revision.
5. Use separate stable idempotency tokens for invalidation, ready and refresh phases, with unique financial audit keys per operation/phase. Fold the mirror condition into its Put so each item has one action.
6. Run new cases with the 157 existing operator/reader cases and types; serialize a transition with the actual SDK through an in-memory handler. No network transport, credentials, provider mutation, SDK send in the preparator or physical authority.

Provider documentation review: Customers v1 general listing excludes clock customers unless filtered; future transport must retrieve the approved IDs and verify ready evidence. Default renewal examples may require another time advance before invoice finalization/payment. These public statements do not prove this account's configuration or Checkout compatibility. Keep normal Checkout/Portal, consent and temporal receipts separate per canonical plan; do not seed or bypass consent as part of this module.

Source: https://docs.stripe.com/billing/testing/test-clocks/api-advanced-usage (checked 2026-10-13). Physical state inventory, provider transport, journal, uncertainty/readback handling, client design and all actual acceptance remain pending.

Validation completed locally: 38 new cases failed before implementation. Final checks passed 195 cases in six files (38 transition, 40 initial installation, 49 evidence and 68 reader), plus TypeScript. The actual SDK serialized the eight transition actions through an in-memory request handler with synthetic credentials. No real DynamoDB condition evaluation or external request occurred. A shared snapshot type error found by the first type-check was corrected; the fixture now excludes initial-only inventory fields so it exercises the actual transition shape. No application runtime file changed.

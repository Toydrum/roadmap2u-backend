# Clock recovery observation

Implement the read-only recovery inventory required by the existing clock caller
design, without changing its approved publication candidate or financial paths.
Parent source: a22ddc7b2f50b60ba76c752b3cc13602d10016f2.

1. Extend the existing AWS observer with recovery mode: retain its six bounded
   reads and actual identity/table/disabled-fixture checks, but observe absent or
   present financial state and one complete bounded financial partition.
2. Add a recovery Stripe reader sharing the guarded SDK transport: account and
   Customer remain strictly bound; ready/advancing/internal_failure, expired
   clock and a controlled resource_missing response are diagnostic facts only.
3. Add a separate exact original readback reader: request bytes/digest and saved
   intent must match; send one TransactGetItems and no write, journal reservation,
   replay or ready publication. Preserve canonical inspection and uncertainty.
4. Test first using real SDK serialization/deserialization and memory-only cloud
   handlers; run existing adjacent regressions and types before freezing locally.

The inventory proposal needs **at most sixteen reads**, including six CLI
ownership reads, six AWS SDK observation reads, three Stripe GET and one optional
exact original readback. This corrects the earlier fifteen-read procedure, which
omitted the SDK observer's independent STS identity read. Do not remove that
identity check to fit the mistaken estimate. No physical window has authorized
either proposal; any future manifest must state its exact budget.

These are private library components. Fresh read-only authority, source/stack
ownership, native composition/CLI, real permission inventory and physical recovery
acceptance remain separate work. Old consumed caller approvals cannot authorize
recovery. Existing write/publication APIs retain their strict ready/empty-state
requirements. No changes to shared contracts, live/PROD, fixtures, IAM, credentials,
flags or deployed state belong to this local implementation.

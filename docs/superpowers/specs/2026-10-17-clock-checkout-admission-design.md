# Enforce the existing synthetic clock boundary for new Checkout sessions

The approved clock design requires synthetic DEV/TEST operations to fail closed when their protected ready evidence is missing, expired, inconsistent or advancing. A local reproduction against the published backend source shows a gap: summary rejects purchases after evidence expiry, but Checkout only checks the previously projected state. Before the next reconciliation, that state can still be `none`, allowing a new remote session.

This is an implementation correction to that existing invariant. It adds no API fields, product options, environments or financial permissions. Ordinary customers continue to use operational time. No application-wide clock is changed.

## Chosen approach

Use the existing `canReadTestClock`, `resolveFinancialClock` and transactional `clockObservation` boundary in `BillingService`. A source without a clock marker performs no clock read and retains the existing transaction shape. A marked source must be a valid bound DEV/TEST synthetic account and have fresh ready evidence; other cases return the existing `BILLING_PAYMENT_REVIEW` error.

Check before provider preflight, revalidate the same mirror after that asynchronous preflight, and condition the new command reservation on the exact observed mirror. Apply the same boundary when storing new Checkout parameters and immediately before creating a previously absent remote session. Existing remote session discovery/readback can still recover a lost response without creating another session. Cancellation and Portal remain available; withdrawing readiness must not prevent financial recovery.

Before creating a new remote session, read the protected mirror before the final state/lease read. Revalidate evidence freshness synchronously after that read, with no further asynchronous work between the lease check and provider creation. This prevents the additional clock read from introducing a stale-lease window while also rejecting evidence that expires during the state read. The existing native clock transition fence rejects publication while that lease is active.

Checking only the summary leaves the direct POST gap. Rejecting all clock-backed purchases would defeat the intended temporal acceptance tests. Reusing the existing resolver and transaction guard keeps the behavior consistent with projection and access.

## Verification

Regression coverage includes exact expiry before reconciliation, absent/advancing/foreign/regressive mirrors, expiry during preflight or provider snapshot, mirror replacement at reservation, pending command recovery, and a normal customer whose clock reader must never be called. Fresh synthetic Checkout still succeeds with operational expiry timestamps. Portal and recovery of an already created session remain usable after evidence expiry. The actual DynamoDB adapter must receive the mirror condition on command and parameter reservation.

Run focused billing tests, types, the full backend suite, contract parity and local synthesis. Preserve the frozen clock implementation and all prior execution packages. Publication, merge, deployment, flags, credentials, Stripe resources and another physical trial require their own concrete authorization windows.

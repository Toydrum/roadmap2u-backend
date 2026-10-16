# Public clock presentation for the DEV/TEST PWA

The user chose adapting the real DEV/TEST PWA for synthetic temporal journeys
in call_6329be4486cc490e83c22e7f5c8168a9. This local change adds optional public
simulation metadata to the existing billing/access summaries. It does not
create an entitlement algorithm, override wall time or authorize cloud writes.

FinancialClock supplies the stage, ready/unavailable mode, frozen financial
time, clock revision and real observation/evidence expiry. There are no provider
IDs, profiles or credentials in that presentation. Ordinary responses retain
their shape; PROD has no public simulation. The existing AccessResolver still
fences the protected mirror and gives a simulated source no offline lease.
Materialized access cannot reuse temporal evidence as an ordinary cached grant.

The public metadata is part of the materialized ACCESS row. The existing
commercial attribute allowlist therefore includes only one additional top-level
attribute, simulation. Existing actions, resources, leading keys and transaction
constraints stay the same. This template change affects the generated policies
in DEV/TEST/PROD and must be reviewed in any future deployment window; no IAM
policy was changed externally by this local work.

Frontend contracts remain normative and are copied with sync-contracts. The PWA
uses a fresh authenticated response only in the matching build stage, stores
the synthetic snapshot in memory for at most fifteen real seconds, drops it on
offline/error/expiry/identity change and persists Free instead. Its financial
confirmation requires matching access/billing clock revision and frozen time.

Validation: the complete local suite ran 2,367 cases. One existing runtime/IAM
test caught the missing public attribute; the one-attribute correction then
passed 96 focused infrastructure, clock and parity cases. All other full-suite
cases passed before that correction; this is combined evidence, not a claim
that another entire suite ran green afterward. Types passed. No real AWS,
Stripe or secret reads occurred.

This checkout and the separately saved complete caller must be combined in a
new checkout and validated before publication. Physical CLI/adapters,
permissions/recovery, fixtures/allowlists, temporal PWA acceptance in DEV/TEST
and the production financial/fiscal gates remain pending. The existing paid
monthly subscription is retained; it is not a new clock fixture.

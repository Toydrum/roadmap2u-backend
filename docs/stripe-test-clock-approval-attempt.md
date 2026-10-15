# Durable consumption of a clock approval

The native journal now has a separate `caller-attempt` record. It reserves a
bound direct-human response before the ownership observer delegates its first
external request, including when that first request later fails. The original
five business records and their hashes remain separate.

The reviewed manifest must bind the journal's absolute directory, native
directory identity and ACL digest. A legacy evidence manifest without that
binding cannot reserve an attempt. A different native directory is rejected.
The attempt filename derives from the call identity, so reusing the same call in
that canonical journal collides even if someone changes the reviewed manifest.
As before, the trusted caller must supply the actual human response; local
verification cannot authenticate a person or legitimize a fabricated receipt.

Reservation uses the real verified authority and opaque native store. It writes
only source/review/request/transaction hashes, operation/phase/stage, review
commit, a call identity digest, window timestamps and directory fingerprints.
It persists no private request, answer, credential, authorization token or
provider response. Successful creation includes the native flush and exact
readback. Partial files, uncertain results and process termination have no retry
or removal path. A new process must not treat an existing attempt as permission
to resume the old window.

The returned attempt is an opaque in-process binding to that exact authority,
store and record. Copies, crossed stores, expiry and changed disk receipts are
rejected. The wrapper rechecks the actual saved record before each wire
reservation and once more before returning successful ownership. It still
reports `physicalExecutionAllowed=false` and does not grant financial authority.
It retains the existing six bounded read-only operations, explicit temporary
credentials and private failures.

Tests use real temporary Git source/review commits, synthetic in-memory human
responses, native NTFS directories and simulated ownership responses. Separate
Node processes verify the same source/receipt and compete through the actual
native journal. They never resolve real credentials or call AWS/Stripe.

The [complete caller engine](stripe-test-clock-caller.md) carries this same
attempt into ownership, fresh AWS/Stripe observations and the existing fenced
writers. Physical CLI/TLS adapters, permissions and bounded recovery remain
pending. This component alone does not close temporal PWA, DEV/TEST or
production acceptance.

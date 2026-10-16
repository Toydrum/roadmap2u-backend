# Read-only recovery caller

Continue the approved scoped-clock design and its mandatory recovery path.
Base: 94319f772cff13118739d3d9039a6b2c533a0182. The published frontend/backend
candidates and the previous reader checkpoint remain frozen in their checkouts.

1. Bind a new read-only manifest and direct-human reply to actual committed
   source/review bytes. Keep its opaque authority separate from write authority.
   Scope stays DEV/TEST, exact synthetic owner/Customer/clock, expected caller,
   CloudFormation resources, storage, runtime and reviewed directory identities.
2. Bind optional original request bytes and the canonical saved intent. An
   unavailable original permits diagnosis only; it cannot be reconstructed.
   A present original must match the same owner/scope and the actual prior
   native intent file. It is never converted into a new financial request.
3. Consume the new reply in a separate NTFS attempt directory before delegating.
   Use a separate strict recovery-attempt record with exclusive, flushed native
   storage, a recovery-specific ID and explicit zero-write/zero-advance fields. The old
   financial journal remains read-only; no reset, append or replay.
4. Compose six ownership reads, six AWS reads, three Stripe GET and optionally
   one exact original atomic readback, with a shared actual-delegation budget.
   Keep AWS/Stripe facts private and return only sanitized diagnostic metadata.
5. Add credential-free preview and the native process boundary using the
   existing pinned TLS transport and explicit credentials in private stdin.
   Require the reviewed AWS CLI executable path/hash and check its bytes before
   each child process; capture injected delegates before invoking callbacks.

Steps 1–5 are implemented locally. The coordinator keeps separate reservation
and actual-send counters and stops at 15/16 reads with no write/advance/replay.
Type checking now includes the recovery authority, coordinator and CLI through
explicit type imports in their tests; dynamically bundled fixtures alone had
left the authority outside the compiler graph. Physical validation is pending.

Test first with real Git/review files and SDK serialization, memory cloud
handlers, and isolated real NTFS/PowerShell where native consumption is tested.
Revalidate adjacent consumers after shared composition changes; do not rerun
unchanged TLS solely to increase the reported count.

This local work does not authorize API use, secrets, fixtures, IAM, flags,
identity, publication, merge, deployment, clocks, purchases, TEST or PROD.
Physical permission inventory, reviewed execution windows and acceptance remain
mandatory. No new product or fiscal policy is introduced.

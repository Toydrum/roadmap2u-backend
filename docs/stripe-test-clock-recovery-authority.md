# Fresh authority for read-only recovery

Recovery uses its own opaque authority. It cannot substitute for
ClockCallerAuthority, and an old write reply does not authorize recovery.
The implementation follows the approved scoped-clock recovery requirement.
The native coordinator and CLI are implemented locally; physical acceptance
remains pending.

## Review binding

The strict clock_recovery_read_only manifest fixes the current source SHA,
operation ID, DEV/TEST synthetic scope, account/caller, storage, CloudFormation
resources, PowerShell/AWS CLI/CA pins and two journal bindings. The attempt directory
is separate from the prior financial journal. It carries no write phase.

A newly captured direct-human reply must say:

    Autorizar recuperación DEV solo lectura <operationId>

Use TEST for that stage. Its local receipt binds the exact manifest hash,
review commit and at most 15 minutes. Verification checks actual committed
source/review files, clean HEAD, canonical remote and executing module bytes.
This binds the supplied receipt; it does not independently prove the identity
of its producer. Automatic continuation is not a human reply.

The credential-free preview produces no authority. Source/review drift and
copied objects are rejected at subsequent boundaries. Private original data
is returned only to code holding the real in-process capability.

## Original evidence

Original bytes are optional only when the reviewed manifest explicitly omits
their readback. Without them the maximum is 15 reads and diagnosis only.
With them, the maximum is 16, and the request hash, original source, saved
canonical intent, reservation ID, owner and storage must match.

The original may be older than the new window. It is not changed into a new
request. Before consuming recovery approval, the actual original native intent
is read and compared. A mismatch returns ORIGINAL_CHANGED without creating a
recovery record. Lost original bytes must not be reconstructed from metadata.

## Native consumption

The separate recovery-attempt record has a recovery-specific reservation ID,
strict keys, DEV/TEST stage, exact hashes, bounded window, a 15/16 read limit,
zero remote writes, zero provider advances, no retry and no broad execution
permission. The native helper validates this distinct format; existing
financial/caller formats retain their exact schemas.

The same NTFS helper enforces owner/DACL, regular file, exclusive creation,
write-through, flush and readback. Reopening after a Node restart does not
permit the reply to be consumed again. Native ALREADY_RESERVED becomes a
fixed recovery error; arbitrary process messages stay private. The prior
financial journal is never written, reset or deleted by these functions.

The authority and attempt remain separate. Before every delegation, the
coordinator rechecks both against current source/runtime/journal state.
These functions alone perform no AWS/Stripe request, secret lookup, role
assumption, repair, ready publication, clock advance or purchase.

## Coordinator and process boundary

The coordinator composes six ownership reads, six AWS observations, three
Stripe GET and an optional exact original readback through one ordered
actual-delegation budget. Reservations and actual sends are counted separately.
Preparation serializes SDK requests without sending them or consuming approval.
Execution consumes the new native attempt first. Failure stops the sequence;
neither SDK retries nor a second execution are permitted.

The process supports a credential-free preview and explicit temporary credentials
in private stdin. AWS CLI uses only the reviewed executable path and hash, checked
again before each child process. The separate SDK TLS transport accepts at most
nine reads, or ten with the original readback. Diagnostic output excludes raw
financial rows, profiles, credentials, URLs and arbitrary error messages. It never
publishes ready evidence or repairs the original operation. See
[the CLI contract](stripe-test-clock-recovery-cli.md).

Actual runtime/permissions, isolated fixtures, authorized physical recovery,
temporal PWA DEV/TEST and production acceptance are still required.

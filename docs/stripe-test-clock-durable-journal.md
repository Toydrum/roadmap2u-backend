# Windows storage for the local clock journal

This component adds native NTFS storage to the existing clock journal. It does
not obtain credentials, reserve a human approval, call AWS or Stripe, or authorize
a clock operation. The business preparers, transaction hashes and atomic
readback checks remain in `stripe-test-clock-journal.ts`.

## Opening the store

The Windows-only factory requires an absolute local directory, an explicit
PowerShell 7 executable and its SHA-256. `initializeDurableClockJournal` creates
only a new leaf; `openDurableClockJournal` inspects an existing one. Neither path
tightens an existing directory's ACL. The parent must already exclude write,
delete and permission-changing access for principals outside the current user,
SYSTEM and Administrators.

The journal directory has a protected DACL with those three principals and the
current user as owner. Its volume/file identity, creation time and ACL digest are
bound to an immutable in-process capability. A copied or deserialized object is
rejected. Every operation rechecks the binding and the pinned executable/helper.
The trusted source check must also cover the committed PowerShell helper.

The native helper locks each path component from the drive down without delete
sharing, and checks the opened handles for directories and reparse points. It
requires a fixed NTFS drive and rejects UNC paths, alternate streams, reparse
points, changed directories and hard-linked receipts. Restricted environments
that cannot inspect an ancestor fail before returning a successful operation;
the caller must not bypass that failure.

## Exclusive records and readback

The original five record kinds are supported: intent, delivery, readback,
provider-advance-intent and provider-advance-result. A separate
[`caller-attempt`](stripe-test-clock-approval-attempt.md) consumes the actual
approval for the ownership wrapper. Their filenames bind the reservation
digest. The helper accepts only the named fields, bounded JSON and
UTF-8 bytes; it rejects duplicate JSON keys and known secret-token patterns.
The journal continues to derive and compare the business values itself.

Writes use `FileMode.CreateNew`, `FileOptions.WriteThrough` and `Flush(true)`.
The file handle remains open during ACL, identity and exact byte/hash readback.
An existing or partial file blocks another reservation. A timeout or uncertain
write has no automatic retry or deletion path. Reads reject malformed, changed
or oversized records. Native failures return fixed codes without private input
or process error output. Requests travel over stdin; the helper's environment
omits AWS and Stripe variables.

Microsoft documents [WriteThrough](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileoptions)
and [Flush(true)](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush?view=net-9.0)
as filesystem write barriers. Local validation checks these actual calls and
their readback on Windows; it is not a hardware power-loss experiment.

## Integration and validation

`ClockJournalDirectory` accepts the opaque store alongside the original string
path. All five record kinds route through the native backend when passed that
store. The string path retains the existing evidence/test behavior and is not
proof of these Windows guarantees. DynamoDB and Stripe transports accept the
same type; a future physical caller must require the opaque native capability.

Native tests create only isolated synthetic temporary directories. They cover
the executable pin, ACL/identity checks, directory replacement, exclusive
reopening, partial files, hard links, copied capabilities, bounded record paths,
private errors and two independent processes competing for one reservation.
Integration tests use the real install/advance preparers and exact simulated
atomic readbacks for all five kinds, without sending AWS or Stripe requests.
Non-Windows runners skip native cases and test the explicit rejection instead;
their results cannot certify Windows storage.

The full caller/CLI, permissions checks, bounded recovery and temporal PWA
acceptance remain pending. The separate approval-attempt component requires an
actual bound human response; storage and a persisted fence alone never grant
financial execution authority.

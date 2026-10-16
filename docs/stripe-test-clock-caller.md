# Clock caller composition

The engine composes the existing source authority, native attempt journal,
ownership reader, AWS/Stripe observers, DynamoDB writer/readback and provider
advance. It performs no credential discovery, secret lookup, role assumption,
resource creation or automatic recovery. Actual use still needs the reviewed
human window; an automatic goal continuation is not one.

## Bound input and current facts

Only the opaque verified authority and native journal are accepted. The request
and transaction come from the authority's original private bytes and canonical
preparers. The reviewed manifest additionally fixes PowerShell's executable/hash
and the CA digest. The helper must be regular, tracked and match its committed
bytes; an exact byte match or the existing CRLF checkout conversion is accepted.

Before delegating, the engine rechecks source HEAD, clean source tree, canonical
remote, executing module/helper and reviewed file/blob/ancestry, the actual
saved attempt, its window, credentials and CA. The actual call is counted once
at the transport boundary. Mutable options, previews or copied objects cannot
substitute the bound plan. All transports and temporary credentials are explicit.

Ownership uses the same attempt capability, avoiding a second consumption of
the human response. AWS supplies the actual disabled identity, table schemas
and atomic snapshot. Stripe supplies the actual account, Customer and ready
clock using the same restricted test key. Those fresh business/provider values
must exactly match the reviewed request before its original transaction can run.
Only observation ingress timestamps are excluded from comparison; transition
snapshots keep their existing contract, which omits subscriptionSource. No
transaction or canonical safety input is removed or regenerated.

## Fixed flow and bounds

| Phase | Ownership | AWS observation | Stripe observation | DynamoDB | Extra provider calls | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| install | 6 | 6 | 3 | 1 write + 1 readback | 0 | 17 |
| ready / refresh | 6 | 5 | 3 | 1 write + 1 readback | 0 | 16 |
| advance_fence | 6 | 5 | 3 | 1 write + 1 readback | 3 reads + 1 advance | 20 |

The real writers retain exact SDK serialization, conditional transactions,
exclusive intent/delivery/readback records and no retry. An advance requires
the actual recent atomic fence proof. A lost transaction response may proceed
only if the complete atomic readback proves its exact application; no second
transaction is sent. A partial/uncertain readback stops before provider advance.
An advance acknowledgement leaves the clock unreadable; ready publication is
a separate phase and window. This never advances Lambda's wall clock.

The shared AWS transport remains alive across observers/writes and is destroyed
once after the attempt. Results expose only bounded metadata, hashes, counters
and fixed failures, never credentials, signed headers, private profiles or raw
transport errors. Existing attempts cannot be resumed or retried. A restart or
uncertain operation requires a separately reviewed bounded recovery procedure.
The [read-only recovery CLI](stripe-test-clock-recovery-cli.md) collects those
diagnostic facts with fresh authority; it does not replay or repair this caller.

## Validation and remaining work

Tests use real temporary Git source/review commits, real NTFS/PowerShell and the
installed SDK serialization/decoding with memory-only cloud handlers. They cover
all four phases, DEV/TEST isolation, live-data drift, lost writes, uncertain
fences, source/certificate changes, replay and secret handling. They provide no
physical AWS/Stripe or production acceptance.

The [native process boundary](../scripts/stripe-test-clock-cli.md) composes this
engine with pinned-CA HTTPS adapters and has separate local SDK/loopback tests.
Actual runtime/permission inventory, bounded physical recovery, fixtures/allowlists,
publication/deployment and financial matrices remain pending. The user chose adapting the real PWA in DEV/TEST for synthetic
temporal journeys; a separate test client must not silently replace that scope.
Normal/temporal PWA, independent TEST and fiscal/live/production gates still
need their own evidence and authorization windows.

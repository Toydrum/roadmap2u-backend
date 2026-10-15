# Reserve an actual clock authorization before delegation

Local scope based on saved journal source e62219a. Preserve its isolated
worktree, prior authority source9ff8f25 and deployed Portal fixbe9e96c.

1. Bind a native journal directory, identity and ACL to the reviewed manifest;
   require that binding for durable consumption while retaining legacy evidence
   verification.
2. Reserve one `caller-attempt` for the actual human call through exclusive
   native creation/flush/readback, before even the first ownership read. Keep
   only bounded public metadata and digests; no automatic retry or resumption.
3. Require an opaque matching attempt and recheck its saved record and window
   before delegation. Compose with the existing ownership observer, retaining
   its read bounds, explicit credentials and failure sanitization.
4. Test real source/review verification, independent process races, failure
   after consumption, directory/receipt crossing, tampering and expiry with
   synthetic data. Run retained clock/lease/Portal suites and types.
5. Save local source/evidence. Full caller/CLI, permissions and recovery,
   financial operation fences, temporal PWA and DEV/TEST/production acceptance
   remain pending. No remote mutation is authorized by this work.

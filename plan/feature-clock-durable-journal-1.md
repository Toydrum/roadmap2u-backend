# Local durable clock journal on Windows

Scope: extend the existing journal's storage in an isolated local worktree based
on authority source `9ff8f25`, with deployed Portal fix `be9e96c` merged locally.
No publication, deployment or AWS/Stripe clock operation is authorized here.

1. Reproduce exclusive NTFS creation, WriteThrough, Flush(true), ACL and readback
   behavior with synthetic files. Retain failed tests and restricted-environment
   diagnostics without weakening the ancestor checks.
2. Add a Windows native storage capability with explicit executable pinning,
   protected directory ownership/ACL, path locks, bounded input and private
   errors. Require a fresh leaf for initialization and preserve existing ACLs.
3. Route the existing five record kinds through that capability. Preserve the
   canonical business preparers, hashes, atomic readback and no-retry behavior;
   keep the legacy string directory as evidence/test storage.
4. Test the real native filesystem, two competing processes, stopped/partial
   records and real prepared install/advance flows with simulated remote data.
   Run retained clock, lease and Portal regressions and TypeScript.
5. Save exact local source and validation. Full caller composition, actual human
   receipt consumption across processes, physical permissions/recovery, temporal
   PWA and independent DEV/TEST/production acceptance remain separate work.

The native adapter is implemented and the initial 16 cases pass on Windows.
Full regression counts and exact source hashes are recorded in the workspace
validation receipt after the final check. Physical execution remains disabled.

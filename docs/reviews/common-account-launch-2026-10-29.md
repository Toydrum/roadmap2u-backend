# Common account backend — local review

Standard terms-only admission now supports ordinary Free and individual Premium accounts without inferred adulthood. Checkout request, transactional CAS and asynchronous worker use the same admission proof. Verified email, billing terms, protected prices, locking, lifecycle, replay and closure checks remain.

Cloud consent is separate. Common enrollment never grants family/social authority, including privacy mode off. Existing private accounts and legacy invitation behavior remain protected; common-to-private conversion is denied. Existing paid/sponsored sources and Portal/cancellation remain independent of renewed signup terms. Consent archival/export retains common document evidence.

## Verification

- 353 focused tests across 21 suites passed; typecheck passed.
- Final immutable source synchronization, typecheck and contract/common-account/Portal regressions passed.
- Full immutable CI remains mandatory before merge/deployment. A prior exploratory full run was stopped as a stale snapshot; it is not reported as a passing full run.
- Independent risk/security review covered parser, identity, immutable hash/version, CAS, worker recovery, off/enforce authorization, retention and existing entitlements. Unaddressed findings: 0.

## Seven review criteria

| Criterion | Result |
| --- | --- |
| Blindspots and concurrency | PASS |
| Clarity and consistency | PASS |
| Maintainability | PASS |
| Security and authorization | PASS |
| Performance and scoped reads | PASS |
| Documentation and compatibility | PASS |
| Types and repository standards | PASS |

Fixed findings include actor recheck before provider dispatch, Portal summary consistency, common evidence archival, eight-file source guards and retained document verification. No new store/infrastructure, real payment, Checkout or access-code operation was performed in local tests.

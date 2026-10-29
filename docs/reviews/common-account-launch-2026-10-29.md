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

## CI follow-up — operator metadata compatibility, 2026-10-29

The first immutable backend CI run failed one test: `private-closure.test.ts` found the operator projecting 42 metadata attributes while its separate bootstrap policy allowed 38. That run reported 2,556 passed and 128 existing skipped tests; it is **not** a passing full CI result. The exact allowlist assertion is retained.

The four added read attributes are `accountTermsAcceptedAt`, `accountTermsLanguage`, `accountTermsDocumentHash` and `cloudDocumentFamily`. They are needed indirectly by the existing `verify_representation` operation: `parentConditions` calls `readPrivacyItem`, which compares the complete live privacy state against the independent decision ledger. A historically admitted guardian can subsequently accept common terms and common cloud consent without losing historical authority. Removing those fields from the projection would incorrectly report a revision conflict for that guardian. The new functional regression executes this real verification path: a 38-field projection fails without a write; the complete 42-field projection authorizes the existing invitation. Holds need only profile/lifecycle metadata, and protected private-account closure retains its historical evidence path; neither observation permits weakening the shared snapshot check.

The proposed IAM correction adds only those four names to `MetadataOnlyMainReads`. Actions, resources, leading-key restrictions, trust/MFA rules, content exclusions and write permissions are unchanged. Common archive/export evidence remains intact. Focused consumer/closure/operator/retention checks passed **49 tests across five suites**; typecheck and whitespace checks passed. Evidence: `backend/operator-iam-alignment-red.log`, `backend/operator-projection-consumer-proof.log` and `backend/operator-projection-consumer-typecheck.log` in the local implementation case. A fresh immutable CI run must still pass before merge or deployment.

Live policy inspection identified the installed 38-attribute roles as belonging to the separate stacks `Roadmap-PrivacyOperator-dev`, `Roadmap-PrivacyOperator-test` and `Roadmap-PrivacyOperator-prod`. Application deployment does not update these stacks. **For each stage, apply and verify the reviewed declarative 38-to-42 metadata-only policy update before promoting the backend there.** This review records that prerequisite; it does not claim that the 42-attribute policy has been deployed. The runbook now requires checking actual stack ownership and effective policy before operator use.

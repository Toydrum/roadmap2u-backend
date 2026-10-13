---
goal: Implement the approved scoped financial clock for synthetic billing tests
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
owner: RoadMap2U
status: Completed
tags: [feature, billing, testing]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement two clocks from the approved design in this isolated backend checkout. No physical execution or publication.

## 1. Requirements & Constraints

- REQ-001: Only exact DEV/TEST synthetic owner/Customer/TestClock/sandbox bindings with ready evidence select financial time.
- REQ-002: Individual source expiry and paid-at validation use financial time; all operational time, grants and family coverage use wall time.
- SEC-001: PROD/live, lost/mismatched/stale mirror, restored simulated source and client clock writes fail closed.
- CON-001: No shared contract edits, dependency updates, cloud calls, secret reads, publication, flags or charges.
- PAT-001: Extend the existing billing and AccessResolver algorithms; do not introduce a parallel entitlement resolver.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Establish protected clock validation and local failing behavior tests.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add behavior tests for protected mirrors and late-worker subscription expiry in test/billing-test-clock.test.ts. Observe failure before application edits. | Yes | 2026-10-13 |
| TASK-002 | Add lambda/billing/clock.ts validation/read types and protected Dynamo read; persist internal marker in billing state and subscription source. | Yes | 2026-10-13 |

### Implementation Phase 2

- GOAL-002: Share financial time without moving operational time. Depends on phase 1.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Wire projector and summary to the protected clock; normalize Customer.test_clock; keep lease/scheduling/audit real. | Yes | 2026-10-13 |
| TASK-004 | Extend source-scoped AccessResolver expiry and Dynamo mirror fences; synthetic cache/offline guard; preserve normal sources. | Yes | 2026-10-13 |
| TASK-005 | Test multiple monthly/yearly consumers, renewal, missing/invalid mirror, PROD/restore, closure and sync rejection. | Yes | 2026-10-13 |

### Implementation Phase 3

- GOAL-003: Verify and save the local candidate. Depends on phase 2.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Run typecheck, relevant billing/access/sync tests and full backend suite; inspect diff and preserve frozen hashes. Save local commit and handoff. | Yes | 2026-10-13 |

## 3. Alternatives

- ALT-001: Global Date.now override rejected: it moves leases, auth and scheduler time.
- ALT-002: Projector-only injection rejected: delayed access readers can restore expired Premium.

## 4. Dependencies

- DEP-001: Existing Stripe 23 Customer.test_clock types and backend domain injection; no new package.
- DEP-002: Future trusted physical publisher must validate sandbox/ready state and publish monotonic mirror revision. This scope does not execute it.

## 5. Files

- FILE-001: lambda/billing/{clock,model,projection,service,runtime,stripe-provider}.ts
- FILE-002: lambda/commercial/{model,access-resolver,paid-source-guards}.ts and lambda/access-reader.ts
- FILE-003: Tests for clock, Dynamo access and sync boundaries; exact additional paths documented in final diff.
- FILE-004: lambda/handlers/sync.ts and commercial grant adapters propagate clock observations and fence online writes. Ordinary 48/55 transaction budgets are preserved; only protected clock checks add their own cost.

## 6. Testing

- TEST-001: Monthly/yearly expiry, renewal and successive readers while wall time stays fixed.
- TEST-002: Wrong stage/live/owner/customer/clock, non-ready/missing/stale mirror, restored source, client writes.
- TEST-003: Operational time unchanged; access source clock scoped; no synthetic offline lease/cache resurrection; closure remains possible.

Final local validation: 1,849 tests in 103 files, typecheck success, exact contract checkout Toydrum/RoadMap2U@640647f653bf840e39bc1d258db402e2dbc2e669 verified. Forty-five dedicated clock tests cover domain and Dynamo adapters. Initial failures reproduced missing clock behavior, snapshot races, mirror propagation and the ordinary sync budget regression; the final suite is green. Physical DEV/TEST clocks, publisher execution and ordinary offline acceptance are still pending and are not certified by these tests.

## 7. Risks & Assumptions

- RISK-001: Runtime cannot detect a remote clock advance before a trusted publisher updates the mirror. Physical rehearsal must publish ready evidence before app acceptance and fence readers by revision.
- ASSUMPTION-001: Protected mirror is server-owned and written only through a future reviewed monotonic publisher; normal clients have no write route.

## 8. Related Specifications / Further Reading

- [Approved design](../docs/superpowers/specs/2026-10-13-billing-test-clock-design.md)
- [Stripe TestClock](https://docs.stripe.com/api/test_clocks/object)

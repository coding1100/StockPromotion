# Phase 3: Production Hardening, Reliability, and Go-Live Controls

## Objective
Finalize the system as a production-grade operation with strong reliability, observability, security, and operational governance.

## Scope
- In scope:
  - CI/CD with staged rollout and rollback path.
  - Security hardening for secrets, credentials, and access control.
  - Reliability hardening for retries, dead-letter queues, replay tooling, and recovery.
  - Full observability with dashboards, SLOs, and alert routing.
  - Compliance and governance:
    - immutable audit trail,
    - content/disclosure version tracking,
    - retention controls.
  - Runbooks for known PRD risks:
    - StockTwits UI changes,
    - source API/schema changes for non-Reddit connectors,
    - account bans/restrictions,
    - IP-based restrictions,
    - Telegram discovery/join limitations.

## Implementation Blueprint
- Platform hardening:
  - RBAC roles: `admin`, `editor`, `approver`, `operator`.
  - Secret rotation cadence and credential revocation playbook.
  - Encrypted backups with restore drills.
- Reliability hardening:
  - strict idempotency keys on publish jobs,
  - dead-letter queue triage process,
  - replay command for failed windows.
- Observability:
  - metrics for ingest lag, draft throughput, publish success rate, account health.
  - per-source connector freshness/error-rate dashboards.
  - structured logs with correlation IDs.
  - alert thresholds for failure spikes and queue backlog.

## Codex Execution Tasks
1. Implement deployment pipeline and environment promotion strategy.
2. Implement RBAC and privileged action auditing.
3. Add backup/restore automation and verification scripts.
4. Add dead-letter handling and replay tooling.
5. Build dashboards and alert rules for operational SLOs.
6. Author incident runbooks and on-call checklists.
7. Run staged soak tests and failure-injection tests.
8. Finalize go-live checklist and sign-off template.

## Acceptance Criteria
- 7-day staging soak passes target success/error thresholds.
- Backup restore test succeeds and is documented.
- Major incident classes can be handled with runbooks only.
- End-to-end audit trail is complete for ingest, generation, approval, publish, and recovery actions.
- System can continue operating under single service/provider degradation scenarios.
- System remains operational under single-source connector degradation with fallback behavior.

## Tests
- Non-functional:
  - soak testing,
  - failover testing,
  - resilience under queue spikes.
- Security:
  - access control tests,
  - secret rotation verification.
- Disaster recovery:
  - backup integrity and timed restore drill.

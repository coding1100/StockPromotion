# Go-Live Checklist

## Readiness
- [ ] CI quality gate green on release commit.
- [ ] Staging soak completed (target: 7 days).
- [ ] Failure-injection scenarios executed and documented.
- [ ] Backup + restore verification completed in staging.

## Reliability
- [ ] Dead-letter queue triage flow validated.
- [ ] Failed-window replay endpoint validated.
- [ ] Account replacement workflow validated.
- [ ] Connector degradation fallback validated.

## Security & Governance
- [ ] Production `ADMIN_API_KEY` set.
- [ ] Secrets rotation/revocation playbook reviewed.
- [ ] Retention policy set and scheduled run verified.
- [ ] Audit trail verified across ingest -> trend -> draft -> approve -> publish -> replay.

## Operations
- [ ] Runbook owners assigned and acknowledged.
- [ ] On-call schedule and escalation path active.
- [ ] Rollback command path tested.
- [ ] Post-release monitoring window staffed.

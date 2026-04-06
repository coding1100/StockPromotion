# On-Call Checklist

## Every Shift
1. Check readiness: `/api/health/ready`.
2. Check queue health and publish failure rate.
3. Review dead-letter queue:
   - `/api/orchestration/publish/dlq?status=OPEN`.
4. Review connector freshness:
   - `/api/orchestration/connectors`.
5. Confirm backup freshness and last restore verification.

## Incident Response
1. Classify incident type using runbook index.
2. Stabilize first (pause scheduler if needed).
3. Capture evidence and affected job IDs.
4. Apply targeted replay once fix is validated.
5. Record actions in incident timeline and audit metadata.

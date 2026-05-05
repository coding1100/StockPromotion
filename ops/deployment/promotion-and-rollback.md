# Promotion And Rollback Strategy

## Environments
- `dev`: active feature development and integration.
- `staging`: pre-production soak and failure-injection validation.
- `production`: customer-facing runtime.

## Promotion Flow
1. PR merges into `main` only after CI quality gate passes.
2. Trigger `CI-CD` workflow manually with `promote_to=staging`.
3. Run staging soak for at least 7 days:
   - pipeline success rate,
   - publish success rate,
   - DLQ growth trend,
   - account restriction spikes.
4. Trigger `CI-CD` workflow with `promote_to=production`.

## Release Gates
- No unresolved critical incident in staging.
- Dead-letter queue has no untriaged `OPEN` entries older than 24h.
- Latest backup and restore verification completed.
- Runbook owners on-call and acknowledged.

## Rollback Path
1. Stop scheduler-triggered pipeline (`PIPELINE_CRON` disable or worker scale to zero).
2. Revert deployment to previous image tag.
3. Validate `/api/health/ready` and `/api/health/metrics`.
4. Replay failed publish window only after stability is restored.
5. Record incident timeline and postmortem link in go-live artifacts.

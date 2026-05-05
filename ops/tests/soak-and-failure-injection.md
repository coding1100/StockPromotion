# Soak And Failure-Injection Plan

## Soak (Staging, 7 Days)
- Keep scheduler enabled.
- Monitor:
  - pipeline run success count,
  - publish success/failure ratio,
  - dead-letter queue growth,
  - connector freshness.

## Failure Injection Scenarios
1. Disable one connector temporarily and confirm fallback.
2. Force one publish account to quarantine and validate replacement flow.
3. Trigger controlled publish failures and validate DLQ + replay flow.
4. Trigger retention run manually and verify cleanup summary.

## Pass Criteria
- No unbounded queue growth.
- Replay recovers failed windows without data corruption.
- No stuck drafts after replay.

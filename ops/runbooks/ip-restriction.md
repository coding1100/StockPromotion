# Runbook: IP-Based Restrictions

## Trigger
- Cross-account failures from same platform with network/challenge messages.
- Geo/IP blocked responses from platform endpoints.

## Immediate Actions
1. Pause scheduler-triggered runs (temporarily disable `PIPELINE_CRON`).
2. Confirm failures are IP-related across multiple accounts.
3. Stop replay operations until traffic path is stable.

## Mitigation
- Rotate egress IP / proxy pool outside application config.
- Re-validate session bootstrap for StockTwits.
- Resume scheduler with reduced cadence.

## Recovery
- Replay only the failed time window after successful smoke publish.
- Keep DLQ replay batch conservative to avoid immediate re-blocking.

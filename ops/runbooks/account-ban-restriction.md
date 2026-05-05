# Runbook: Account Ban / Restriction

## Trigger
- Restriction signals (captcha, blocked, suspended, locked).
- Rapid drop in account health score and quarantine events.

## Immediate Actions
1. Inspect account dashboard: `GET /api/accounts`.
2. Quarantine affected account if not already quarantined:
   - `PATCH /api/accounts/:id/quarantine`
3. Request replacement:
   - `POST /api/accounts/:id/replacement-request`

## Recovery
1. Activate replacement credentials:
   - `POST /api/accounts/replacement`
2. Replay failed dead-letter entries:
   - `GET /api/orchestration/publish/dlq`
   - `POST /api/orchestration/publish/dlq/:id/replay`
3. Monitor publish success and restriction events for 24h.

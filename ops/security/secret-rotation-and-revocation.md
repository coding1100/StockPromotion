# Secret Rotation And Revocation Playbook

## Scope
- `ADMIN_API_KEY`
- `STOCKTWITS_ACCOUNTS_JSON` credentials
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_BOT_ACCOUNTS_JSON`
- connector API keys (`REDDIT_RAPIDAPI_KEY`, `NEWS_SENTIMENT_API_KEY`)

## Rotation Cadence
- High-risk credentials: every 30 days.
- Connector/read-only keys: every 60-90 days.
- Immediate rotation on suspected leak.

## Rotation Procedure
1. Provision new secret values in secret manager.
2. Update runtime environment references.
3. Restart workers/API processes in staging.
4. Validate health + smoke pipeline run.
5. Promote to production.
6. Revoke old credentials.

## Emergency Revocation
1. Disable scheduler-triggered publishing.
2. Revoke compromised keys immediately.
3. Re-issue credentials and update config.
4. Validate account accessibility and connector health.
5. Replay failed window if needed.

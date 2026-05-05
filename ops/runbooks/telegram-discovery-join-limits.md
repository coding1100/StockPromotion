# Runbook: Telegram Discovery / Join Limits

## Trigger
- `joined=false` for approved candidates.
- Frequent `Bot cannot access chat yet` notes.

## Immediate Actions
1. Review candidate queue:
   - `GET /api/orchestration/telegram/candidates`
2. Sync approved joins:
   - `POST /api/orchestration/telegram/candidates/sync-join`
3. Verify bot permissions in target channels/groups.

## Mitigation
- Prefer stable chat IDs over invite links.
- Keep `TELEGRAM_DISCOVERY_SEEDS` clean and low-noise.
- Use approved/joined filtering before scheduling.

## Recovery
- Replay only Telegram failed jobs for impacted window:
  - `POST /api/orchestration/publish/replay-window` with `platform=TELEGRAM`.

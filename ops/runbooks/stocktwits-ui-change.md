# Runbook: StockTwits UI Changes

## Trigger
- Publish failures with selector, element, or timeout errors on StockTwits.

## Immediate Actions
1. Set `STOCKTWITS_HEADLESS=false` in staging.
2. Run `POST /api/orchestration/stocktwits/session/bootstrap`.
3. Reproduce one failed publish job with `POST /api/orchestration/publish/jobs/:id/rerun-now`.

## Triage
- Capture screenshot/evidence URI from failed publish attempts.
- Validate login session state (`GET /api/orchestration/stocktwits/session`).
- Identify broken selectors in `stocktwits.publisher.ts`.

## Mitigation
- Patch selectors and release to staging first.
- Replay failed window via `POST /api/orchestration/publish/replay-window`.
- Monitor DLQ size until it stabilizes.

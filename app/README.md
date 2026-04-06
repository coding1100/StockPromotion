# Stock Promotion Automation - Phase 1 + Phase 2 + Phase 3 Hardening Backend

Production-oriented NestJS backend implementing the client-directed Phase 1 pipeline plus Phase 2 scale automation:
- multi-source ingestion (Reddit + additional connectors),
- mockable Reddit ingestion for demo/staging when live Reddit API access is unavailable,
- trend detection for equities and crypto,
- LLM draft generation with strict structured outputs (OpenAI + Anthropic),
- StockTwits browser automation publishing via Playwright,
- Telegram publishing with discovery candidate approval flow,
- multi-account routing, health scoring, quarantine, and replacement workflow,
- connector health, weighting, and fallback-aware trend inputs,
- duplicate and near-duplicate suppression before publish,
- dead-letter queue triage + replay tooling for failed windows,
- retention controls for operational data lifecycle,
- queue-based orchestration and auditability.

## Stack
- NestJS 11
- PostgreSQL + Prisma
- Redis + BullMQ
- Playwright
- OpenAI + Anthropic
- Docker Compose

## Local Setup
1. Copy env:
```bash
cp .env.example .env
```
2. Start infrastructure:
```bash
docker compose up -d postgres redis
```
3. Install and prepare:
```bash
npm install
npm run prisma:generate
npx prisma migrate deploy
```
4. Run app:
```bash
npm run start:dev
```

Base URL: `http://localhost:3000/api`  
Swagger: `http://localhost:3000/api/docs`  
Health: `GET /api/health/live`, `GET /api/health/ready`
Metrics: `GET /api/health/metrics`

## Key Endpoints
- `POST /api/orchestration/run` with body `{ "mode": "sync" | "async" }`
- `GET /api/orchestration/trends`
- `GET /api/orchestration/drafts`
- `POST /api/orchestration/drafts/:id/approve`
- `GET /api/orchestration/connectors`
- `GET /api/orchestration/dashboard/operations`
- `GET /api/orchestration/telegram/candidates`
- `POST /api/orchestration/telegram/candidates/:id/approve`
- `POST /api/orchestration/telegram/candidates/sync-join`
- `GET /api/orchestration/publish/jobs`
- `GET /api/orchestration/publish/jobs/:id`
- `POST /api/orchestration/publish/jobs/:id/retry`
- `GET /api/orchestration/publish/dlq`
- `POST /api/orchestration/publish/dlq/:id/replay`
- `POST /api/orchestration/publish/dlq/:id/dismiss`
- `POST /api/orchestration/publish/replay-window`
- `GET /api/orchestration/retention/policy`
- `POST /api/orchestration/retention/run`
- `GET /api/accounts`
- `PATCH /api/accounts/:id/quarantine`
- `POST /api/accounts/:id/replacement-request`
- `POST /api/accounts/replacement`

## Development Mock Data Mode
- When `NODE_ENV=development`, ingestion uses mock payload envs automatically:
  - `REDDIT_MOCK_DATA_JSON`
  - `STOCKTWITS_SIGNAL_MOCK_DATA_JSON`
  - `NEWS_MOCK_DATA_JSON`
- Outside development (`test`/`production`), ingestion uses live connector endpoints only.
- In non-development environments, keep at least one secondary live connector configured (`STOCKTWITS_SIGNAL_API_URL` or `NEWS_SENTIMENT_API_URL`).

Example:
```json
[
  {
    "id": "mock-1",
    "title": "AAPL discussion volume is climbing",
    "body": "Retail traders are mentioning AAPL and NVDA more often today.",
    "author": "demo-user",
    "score": 42,
    "createdAt": "2026-03-31T09:30:00.000Z"
  }
]
```

## Phase 2 Configuration
- `TELEGRAM_BOT_ACCOUNTS_JSON` supports multiple Telegram bot identities.
- `PUBLISH_RETRY_DELAY_SECONDS` controls retry delay after manual retry.
- `PUBLISH_DEAD_LETTER_ENABLED` toggles dead-letter recording after retry exhaustion.
- `PUBLISH_REPLAY_BATCH_SIZE` caps failed-window replay size.
- `CONTENT_PROMPT_VERSION` and `CONTENT_DISCLOSURE_VERSION` version generated content.
- `RETENTION_*` variables configure scheduled lifecycle cleanup.
- `PHASE2_PER_ACCOUNT_QUOTA` and `PHASE2_GLOBAL_QUOTA` enforce conservative dispatch limits.
- `PHASE2_QUIET_HOURS_START` and `PHASE2_QUIET_HOURS_END` pause scheduling during configured hours.
- `PHASE2_MIN_DELAY_MINUTES` and `PHASE2_MAX_DELAY_MINUTES` control randomized dispatch windows.
- `PHASE2_ADAPTIVE_COOLDOWN_MINUTES` delays reroutes after soft failures or restrictions.
- `PHASE2_DUPLICATE_SIMILARITY_THRESHOLD` blocks near-duplicate posts before publish.
- `SOURCE_CONNECTOR_WEIGHTS_JSON` and `SOURCE_CONNECTOR_PRIORITIES_JSON` control source weighting and failover ordering.

## StockTwits Session Reuse
- Set `STOCKTWITS_HEADLESS=false` for supervised local testing.
- Set `STOCKTWITS_USER_DATA_DIR` to a persistent directory so Chromium keeps session cookies/local storage.
- Set `STOCKTWITS_BROWSER_BINARY` if Playwright should use a non-default browser executable.
- Use `POST /api/orchestration/stocktwits/session/bootstrap` to open the reusable session and complete login/challenge manually.
- Use `GET /api/orchestration/stocktwits/session` to verify whether the saved session is still authenticated before dispatching publish jobs.

## Commands
```bash
npm run build
npm test
npm run prisma:generate
npm run prisma:migrate
npm run prisma:deploy
npm run ops:backup-db
npm run ops:restore-db -- -BackupFile .\backups\<file>.dump -DropExisting
npm run ops:verify-restore
npm run ops:replay-window -- -FromIso 2026-04-01T00:00:00Z -ToIso 2026-04-01T06:00:00Z -Platform STOCKTWITS
```

## Production Notes
- Queue workers run in the same process for Phase 1.
- StockTwits automation is UI-dependent and still subject to platform anti-bot challenges; selector maintenance and supervised testing are expected.
- Use real secret management and regular key rotation in production.
- Keep conservative publish cadence and monitor account health events.
- Protect all non-health endpoints with `x-api-key` (`ADMIN_API_KEY`).
- In production, set `SWAGGER_ENABLED=false` unless docs access is explicitly required.
- Use `../ops` runbooks/checklists for promotion, rollback, and incident response.

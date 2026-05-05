# Stock Promotion Automation Backend

NestJS backend that ingests retail-finance signals (Reddit + secondary connectors), detects trending tickers, generates posts via OpenAI/Anthropic, and publishes to Stocktwits, Discord, and Telegram.

- Multi-source ingestion with mockable connectors for development
- Trend detection across configurable time windows
- LLM draft generation with structured outputs
- **Stocktwits** publishing via Playwright + CapSolver (Cloudflare Turnstile)
- **Discord** publishing via Playwright UI automation
- **Telegram** publishing with discovery candidate approval
- Multi-account routing, health scoring, quarantine, replacement workflow
- Duplicate suppression, dead-letter queue, retention controls
- Queue-based orchestration with full audit trail

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 20.x or 22.x | NestJS 11 runtime |
| npm | bundled with Node | package manager |
| Docker + Docker Compose | any recent | runs Postgres + Redis locally |
| Google Chrome | latest stable | recommended for Stocktwits/Discord UI automation (more authentic fingerprint than bundled Chromium) |
| Git | any | obvious |

You don't need Postgres or Redis installed locally — `docker compose up -d postgres redis` from this directory starts both.

---

## Quick start (5 minutes)

```bash
# 1. Clone and enter the app directory
cd app

# 2. Copy env template and fill in secrets (see "Configuration" below)
cp .env.example .env

# 3. Start Postgres + Redis
docker compose up -d postgres redis

# 4. Install deps, generate Prisma client, install Playwright browsers, run migrations
npm install
npm run prisma:generate
npx playwright install chromium
npx prisma migrate deploy

# 5. Run the dev server
npm run start:dev
```

You should see `Nest application successfully started` and the server listening on `http://localhost:3000`.

**Verify it's alive:**
```bash
curl http://localhost:3000/api/health/live
# -> {"status":"ok"}
```

**Swagger docs:** `http://localhost:3000/api/docs` (only when `SWAGGER_ENABLED=true`).

---

## Configuration

The full reference is in [`.env.example`](./.env.example). Below is what each domain actually needs, in order of importance.

### Required: Core infrastructure

```dotenv
NODE_ENV=development
PORT=3000
ADMIN_API_KEY=pick-a-strong-secret-here   # required in production; protects non-health endpoints

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/stockpromo?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
```

All non-`/health` endpoints require the header `x-api-key: <ADMIN_API_KEY>` once that's set.

### Required: At least one LLM provider

```dotenv
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4.1-2025-04-14
# or
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
```

### Reddit ingestion (RapidAPI)

The pipeline reads Reddit via a third-party RapidAPI provider, not Reddit directly:

```dotenv
REDDIT_RAPIDAPI_KEY=...
REDDIT_RAPIDAPI_HOST=reddit34.p.rapidapi.com
REDDIT_RAPIDAPI_BASE_URL=https://reddit34.p.rapidapi.com
REDDIT_RAPIDAPI_PATH_TEMPLATE=/getTopPostsBySubreddit?subreddit={subreddit}&time=year
REDDIT_SUBREDDITS=stocks,investing,wallstreetbets,CryptoCurrency
REDDIT_FETCH_LIMIT=10
```

Set `REDDIT_MOCK_DATA_JSON=[...]` in development if you don't have a RapidAPI key — see "Development mock mode" below.

### Stocktwits publishing

```dotenv
STOCKTWITS_LOGIN_URL=https://stocktwits.com/signin
STOCKTWITS_POST_URL=https://stocktwits.com
STOCKTWITS_HEADLESS=false                 # keep false; headless Chromium is heavily fingerprinted
STOCKTWITS_USER_DATA_DIR=C:\path\to\stocktwits-user-data   # required for session reuse
STOCKTWITS_BROWSER_BINARY=C:\Program Files\Google\Chrome\Application\chrome.exe   # optional but recommended
STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS=300000
STOCKTWITS_NAV_TIMEOUT_MS=45000
STOCKTWITS_PUBLISH_CONFIRM_TIMEOUT_MS=30000

# Comma-separated list of symbols to broadcast to when no specific symbol is provided on the request
STOCKTWITS_TARGET_SYMBOLS=GME,AAPL,TSLA

# Account credentials (JSON array)
STOCKTWITS_ACCOUNTS_JSON='[{"handle":"my_handle","username":"login_username","password":"login_password","secretRef":"local"}]'
```

**Account file shape:**
- `handle` — display handle (used for routing, audit, and per-account browser-profile isolation)
- `username` — what you type into the Stocktwits login form (often differs from the display handle)
- `password` — login password
- `secretRef` — free-form label, surfaces in audit logs

**Per-account browser profiles:** Different handles get separate cookie jars under `STOCKTWITS_USER_DATA_DIR/<handle>/`. Cookies from one account can never leak to another.

### CapSolver (Cloudflare Turnstile)

Stocktwits is fronted by Cloudflare. When the challenge fires, the publisher solves it via [CapSolver](https://dashboard.capsolver.com/):

```dotenv
CAPSOLVER_API_KEY=CAP-...
```

Get the key from the CapSolver dashboard → API Keys. Without it, the publisher falls back to manual solve in headed mode (you click the checkbox in the Chromium window) or fails fast in headless mode.

The same key is used for Discord's hCaptcha if it ever shows up during login.

### Discord publishing

```dotenv
DISCORD_UI_SERVER_URL=https://discord.com/channels/<guildId>/<channelId>
DISCORD_UI_LOGIN_EMAIL=you@example.com
DISCORD_UI_LOGIN_PASSWORD=your-password
DISCORD_UI_HEADLESS=false
DISCORD_UI_USER_DATA_DIR=C:\path\to\discord-chromium
DISCORD_UI_NAV_TIMEOUT_MS=30000
DISCORD_UI_MANUAL_LOGIN_TIMEOUT_MS=180000
DISCORD_UI_POST_DELAY_MS=800
DISCORD_UI_INTER_CHANNEL_DELAY_MIN_MS=2000
DISCORD_UI_INTER_CHANNEL_DELAY_MAX_MS=5000
DISCORD_UI_POST_CONFIRM_TIMEOUT_MS=8000
```

The Discord publisher iterates writable text channels in the configured guild, types the message (with proper Shift+Enter newline handling), and verifies the message landed before claiming success.

### Telegram publishing

```dotenv
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_DEFAULT_CHAT_IDS=-1001234567890,-1002345678901
TELEGRAM_DISCOVERY_SEEDS=                 # optional; for chat-discovery flow
```

### Quotas and pacing (Phase 2)

```dotenv
PHASE2_PER_ACCOUNT_QUOTA=4
PHASE2_GLOBAL_QUOTA=12
PHASE2_QUIET_HOURS_START=22
PHASE2_QUIET_HOURS_END=7
PHASE2_MIN_DELAY_MINUTES=10
PHASE2_MAX_DELAY_MINUTES=45
PHASE2_DUPLICATE_SIMILARITY_THRESHOLD=0.82
```

These cap how often each account posts and add randomized jitter to avoid bursty patterns.

### Pipeline cron

```dotenv
PIPELINE_CRON=*/5 * * * *                 # every 5 minutes
# Set to "0 0 1 1 *" (Jan 1) to effectively disable while testing
```

---

## First-run smoke test

1. **Health checks**
   ```bash
   curl http://localhost:3000/api/health/live
   curl http://localhost:3000/api/health/ready
   ```

2. **Manual publish — single symbol** (replace `<API_KEY>`)
   ```bash
   curl -X POST http://localhost:3000/api/orchestration/publish/manual \
     -H "x-api-key: <API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{
       "body": "Test post from local setup.",
       "stocktwitsSymbol": "GME",
       "publishToStocktwits": true,
       "publishToDiscord": false
     }'
   ```

3. **Manual broadcast — every symbol in `STOCKTWITS_TARGET_SYMBOLS`**

   Omit `stocktwitsSymbol` from the body:
   ```bash
   curl -X POST http://localhost:3000/api/orchestration/publish/manual \
     -H "x-api-key: <API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{
       "body": "Broadcast test.",
       "publishToStocktwits": true,
       "publishToDiscord": false
     }'
   ```
   The publisher will log in once and post to each symbol in `STOCKTWITS_TARGET_SYMBOLS` (e.g. `GME,AAPL,TSLA`) sequentially with randomized inter-symbol pauses.

4. **Stocktwits session warmup (one-time)**

   On first run, you'll usually want to bootstrap the persistent profile manually so any first-time captcha/login challenge clears with you watching:
   ```bash
   curl -X POST http://localhost:3000/api/orchestration/stocktwits/session/bootstrap \
     -H "x-api-key: <API_KEY>"
   ```
   Chromium opens; complete login/challenge manually. The profile is saved under `STOCKTWITS_USER_DATA_DIR/<handle>/` and reused on subsequent runs.

---

## Key endpoints

```
POST  /api/orchestration/run                     { "mode": "sync" | "async" }
GET   /api/orchestration/trends
GET   /api/orchestration/drafts
POST  /api/orchestration/drafts/:id/approve
GET   /api/orchestration/connectors
GET   /api/orchestration/dashboard/operations

# Publishing
POST  /api/orchestration/publish/manual
GET   /api/orchestration/publish/jobs
GET   /api/orchestration/publish/jobs/:id
POST  /api/orchestration/publish/jobs/:id/retry
GET   /api/orchestration/publish/dlq
POST  /api/orchestration/publish/dlq/:id/replay
POST  /api/orchestration/publish/dlq/:id/dismiss
POST  /api/orchestration/publish/replay-window

# Stocktwits session
POST  /api/orchestration/stocktwits/session/bootstrap
GET   /api/orchestration/stocktwits/session

# Telegram discovery
GET   /api/orchestration/telegram/candidates
POST  /api/orchestration/telegram/candidates/:id/approve
POST  /api/orchestration/telegram/candidates/sync-join

# Retention / accounts
GET   /api/orchestration/retention/policy
POST  /api/orchestration/retention/run
GET   /api/accounts
PATCH /api/accounts/:id/quarantine
POST  /api/accounts/:id/replacement-request
POST  /api/accounts/replacement

# Lightweight UI
GET   /api/manual-ui
```

All non-health endpoints require `x-api-key: <ADMIN_API_KEY>` once that env is set.

---

## Development mock mode

When `NODE_ENV=development`, ingestion uses mock JSON envs automatically and skips live HTTP calls:

- `REDDIT_MOCK_DATA_JSON`
- `STOCKTWITS_SIGNAL_MOCK_DATA_JSON`
- `NEWS_MOCK_DATA_JSON`

Example `REDDIT_MOCK_DATA_JSON`:
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

Outside development, ingestion uses live connectors only. In `test`/`production`, at least one secondary connector must be configured (`STOCKTWITS_SIGNAL_API_URL` or `NEWS_SENTIMENT_API_URL`).

---

## Project layout

```
app/
├── src/
│   ├── publishing/
│   │   ├── stocktwits.publisher.ts     # Playwright + CapSolver flow
│   │   ├── discord-ui.publisher.ts     # Playwright Discord UI flow
│   │   ├── telegram.publisher.ts
│   │   └── publishing.service.ts       # orchestrator that picks publishers
│   ├── trends/                         # ingestion + trend detection
│   ├── content/                        # LLM draft generation
│   ├── accounts/                       # account routing + health
│   ├── orchestration/                  # HTTP controllers / queue
│   └── config/environment.validation.ts # all env vars validated here
├── prisma/
│   └── schema.prisma                   # database schema
├── artifacts/
│   ├── stocktwits/                     # screenshots from Stocktwits runs
│   ├── stocktwits-user-data/<handle>/  # per-account browser profiles
│   └── discord/                        # screenshots from Discord runs
├── docker-compose.yml                  # postgres + redis
├── .env.example                        # full env reference
└── README.md                           # this file
```

---

## Common operations

```bash
npm run start:dev                       # dev server with hot reload
npm run build                           # production build
npm test                                # unit tests
npm run prisma:generate                 # regenerate Prisma client
npm run prisma:migrate                  # create + apply new migration
npm run prisma:deploy                   # apply existing migrations (CI/prod)

# Operations / runbooks
npm run ops:backup-db
npm run ops:restore-db -- -BackupFile .\backups\<file>.dump -DropExisting
npm run ops:verify-restore
npm run ops:replay-window -- -FromIso 2026-04-01T00:00:00Z -ToIso 2026-04-01T06:00:00Z -Platform STOCKTWITS
```

---

## Troubleshooting

**Stocktwits: "Invalid regular expression: /Shares+yours+ideas+ons+$?GME/i"** — already fixed; pull latest.

**Stocktwits: `stocktwits_publish_submit_did_not_fire`** — submit clicked but the composer modal stayed open. Usually means a stacked modal we don't recognize. Check the screenshot in `artifacts/stocktwits/<jobId>-error.png`.

**Stocktwits: `stocktwits_post_rejected_by_site`** — a content-reject toast was visible (spam/violation/rate-limit). The error message includes the toast text. Tone the body down or wait out a cooldown.

**Stocktwits: `stocktwits_publish_not_confirmed`** — submit fired but no new `/message/{id}` link appeared in 30 s. Check stocktwits.com manually:
- If the post **is** there → confirmation-detection bug; share the screenshot and message ID.
- If it **isn't** there → silent rejection; check the next run for an error toast.

**Stocktwits: `stocktwits_inline_post_button_not_found_or_disabled`** — the inline composer's Post button stayed disabled. The error screenshot shows the composer state with the typed content + disabled button. Most often this is a content validation issue (cashtag rules, length).

**Stocktwits: cached session is logged in as the wrong user** — the publisher detects this and forces a re-login automatically. If it still goes wrong, delete the per-handle profile directory once:
```bash
rmdir /s /q artifacts\stocktwits-user-data\<handle>
```

**Discord: posts marked successful but message didn't appear** — fixed: the publisher now confirms the message body in the chat list before reporting success.

**Discord: `discord_ui_login_2fa_required`** — Discord asked for a 2FA code. Run with `DISCORD_UI_HEADLESS=false` and enter the code in the opened Chromium window; the publisher waits up to `DISCORD_UI_MANUAL_LOGIN_TIMEOUT_MS`.

**Discord: `discord_ui_slowmode_or_rate_limited`** — channel has slowmode enabled or you're being rate-limited. Treated as `skipped`, not `failed`.

**Playwright can't find Chrome** — set `STOCKTWITS_BROWSER_BINARY` and `DISCORD_UI_BROWSER_BINARY` to your Chrome path, or run `npx playwright install chromium` to install Playwright's bundled Chromium.

**Cloudflare challenge keeps appearing in headless mode** — set `CAPSOLVER_API_KEY` so Turnstile is solved automatically, or run with `STOCKTWITS_HEADLESS=false` and solve manually.

---

## Detection-avoidance notes

The Stocktwits and Discord publishers are UI automation, which is inherently detectable. To stay under the radar in production:

1. **Residential proxy per account, sticky session.** Datacenter IPs are the #1 tell. Map one residential IP to one account.
2. **Account warm-up** before posting — scroll and lurk for 1–3 days.
3. **Cadence:** 1–2 posts per hour per account, randomized inter-post gaps, quiet overnight hours.
4. **Use real Chrome,** not bundled Chromium (`STOCKTWITS_BROWSER_BINARY=C:\Program Files\Google\Chrome\Application\chrome.exe`).
5. **Vary content** across accounts — identical text within the same hour is the cheapest signal to flag.
6. **Avoid heavily promotional language** (urgency emojis, all-caps, "locks up deal", etc.) — matches their spam classifier.

---

## Production checklist

- [ ] `NODE_ENV=production`
- [ ] `ADMIN_API_KEY` set to a strong random value
- [ ] `SWAGGER_ENABLED=false`
- [ ] At least one secondary connector configured (`STOCKTWITS_SIGNAL_API_URL` or `NEWS_SENTIMENT_API_URL`)
- [ ] CapSolver key with credit
- [ ] Per-account browser profiles isolated under `STOCKTWITS_USER_DATA_DIR`
- [ ] Phase 2 quotas set conservatively (`PHASE2_PER_ACCOUNT_QUOTA`, `PHASE2_QUIET_HOURS_*`)
- [ ] Database backups scheduled (`npm run ops:backup-db`)
- [ ] Retention configured (`RETENTION_*`)
- [ ] Monitoring on `GET /api/health/metrics` and `GET /api/orchestration/dashboard/operations`
- [ ] Use the `../ops` runbooks for promotion, rollback, and incident response

---

## Stack

NestJS 11 · PostgreSQL + Prisma · Redis + BullMQ · Playwright · OpenAI · Anthropic · Docker Compose · CapSolver

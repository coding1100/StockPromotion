# Stock Promotion Automation - Phase 1 Backend

Production-oriented NestJS backend implementing Phase 1 pipeline:
- multi-source ingestion (Reddit + additional connectors),
- trend detection for equities and crypto,
- LLM draft generation with strict structured outputs (OpenAI + Anthropic),
- StockTwits browser automation publishing,
- Telegram publishing with discovery candidate approval flow,
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
- `GET /api/orchestration/telegram/candidates`
- `POST /api/orchestration/telegram/candidates/:id/approve`
- `POST /api/orchestration/telegram/candidates/sync-join`
- `GET /api/orchestration/publish/jobs`
- `GET /api/orchestration/publish/jobs/:id`
- `POST /api/orchestration/publish/jobs/:id/retry`

## Commands
```bash
npm run build
npm test
npm run prisma:generate
npm run prisma:migrate
npm run prisma:deploy
```

## Production Notes
- Queue workers run in the same process for Phase 1.
- StockTwits automation is UI-dependent; selector maintenance is expected.
- Use real secret management and regular key rotation in production.
- Keep conservative publish cadence and monitor account health events.
- Protect all non-health endpoints with `x-api-key` (`ADMIN_API_KEY`).
- In production, set `SWAGGER_ENABLED=false` unless docs access is explicitly required.

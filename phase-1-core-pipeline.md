# Phase 1: Core Pipeline (Client-Visible Delivery)

## Objective
Build the first production-capable pipeline that:
- extracts stock trends from Reddit and other relevant sources,
- generates content from those trends,
- publishes to StockTwits and Telegram,
- and records posting status plus account health events.

## Scope
- In scope:
  - Reddit data extraction from a curated subreddit allowlist.
  - Additional relevant source extraction for trend context:
    - StockTwits trend/symbol signal ingestion from approved endpoints.
    - One market news/sentiment API connector (provider-configurable).
  - Trend detection for US equities and crypto symbols.
  - Content generation using dual LLM providers behind one routing layer.
  - StockTwits posting via browser automation (Playwright).
  - Telegram posting automation to owned/admin-controlled channels or groups.
  - Telegram group discovery and join automation where technically possible, with explicit approval gates.
  - End-to-end workflow orchestration and audit logging.
- Out of scope:
  - Account farming or evasion behavior.
  - Autonomous mass account creation.
  - Any posting to unapproved third-party Telegram destinations.

## Required Workflow
Implement this exact workflow:
1. Extract trending discussions.
2. Process and filter relevant data.
3. Generate content.
4. Assign content to accounts.
5. Publish on StockTwits and Telegram.
6. Monitor posting status and account health.

## Implementation Blueprint
- Backend services:
  - `api`: control plane and admin endpoints.
  - `source-ingestor-reddit`: pulls posts/comments and normalizes events.
  - `source-ingestor-stocktwits-signal`: ingests stock trend/symbol signals.
  - `source-ingestor-news`: ingests market news/sentiment signals.
  - `trend-engine`: scores trend topics by velocity + engagement + sentiment.
  - `content-generator`: creates structured drafts.
  - `policy-engine`: applies educational-only and safety checks.
  - `publisher-stocktwits`: Playwright posting worker.
  - `publisher-telegram`: Bot API posting worker with discovery/join workflow.
  - `scheduler`: queues jobs with conservative randomized cadence.
- Data and infra:
  - PostgreSQL for source events, trends, drafts, jobs, and audit data.
  - Redis/BullMQ for scheduling, retries, and idempotent jobs.
  - Docker Compose deployment on Hostinger VPS.

## Codex Execution Tasks
1. Scaffold service layout and shared contracts.
2. Implement Reddit + additional-source ingestion and normalized storage.
3. Implement trend scoring windows (1h, 6h, 24h) across all enabled sources.
4. Implement structured content generation and policy validation.
5. Implement StockTwits Playwright post flow with evidence screenshots.
6. Implement Telegram discovery/join flow with approval gates, then posting flow with allowlist.
7. Implement job lifecycle states, retries, and error taxonomy.
8. Implement admin endpoints for trends, drafts, approvals, discovery candidates, and publish status.
9. Add baseline observability (logs, metrics, error tracking hooks).

## Acceptance Criteria
- A full run succeeds in staging:
  - ingest -> trend -> draft -> policy -> publish -> monitor.
- At least two sources are active in phase 1:
  - Reddit plus one additional relevant source connector.
- StockTwits and Telegram publishers both function.
- Telegram discovery/join path works for approved candidates where platform permits.
- Flagged drafts are not auto-published.
- Each publish attempt stores:
  - account used,
  - content hash,
  - timestamp,
  - result,
  - evidence artifact URI.
- No duplicate post is published within configured cooldown windows.

## Tests
- Unit:
  - symbol extraction,
  - trend scoring,
  - policy checks,
  - scheduler jitter/cooldown.
- Integration:
  - Reddit adapter,
  - additional-source adapter(s),
  - LLM routing adapter,
  - Telegram discovery/join + posting adapter.
- E2E:
  - StockTwits Playwright login/post/failure recovery.
  - Telegram discovery -> approval -> join -> post flow.
  - End-to-end workflow with retries and idempotency.

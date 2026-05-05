# Runbook: Source API / Schema Changes

## Trigger
- Ingestion connector flips to unhealthy.
- Payload parsing errors or sudden event volume collapse.

## Immediate Actions
1. Confirm connector health: `GET /api/orchestration/connectors`.
2. Capture raw payload samples in `app/artifacts`.
3. Temporarily reduce connector weight/priority if data is degraded.

## Triage
- Compare payload shape against parser expectations in `ingestion.service.ts`.
- Validate timestamp and symbol extraction behavior.
- Confirm fallback connector freshness remains acceptable.

## Mitigation
- Update parser mapping for changed schema.
- Run one sync pipeline (`POST /api/orchestration/run` with `mode=sync`).
- Validate trend output count and evidence consistency.

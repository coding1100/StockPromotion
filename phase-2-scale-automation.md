# Phase 2: Scale Automation, Multi-Account Control, and Risk Management

## Objective
Scale the Phase 1 system to support robust multi-account operations, deeper anti-blocking behavior, and higher-volume source/publishing reliability while preserving platform-safe execution.

## Scope
- In scope:
  - Multi-account pools for StockTwits and Telegram posting identities.
  - Automatic account switching and routing by health score.
  - Account restriction detection and quarantine lifecycle.
  - Account replacement workflow (manual or semi-automated intake).
  - Expansion from baseline phase-1 source connectors to additional relevant sources as needed.
  - Anti-blocking controls:
    - posting frequency control,
    - activity randomization,
    - multi-environment support where required.
  - Telegram discovery/join optimization at scale (priority scoring, throttling, and review queues).
- Out of scope:
  - Full autonomous account creation at scale.
  - Any implementation that violates platform terms.

## Implementation Blueprint
- Account management domain:
  - `account_profile`,
  - `account_credentials_ref`,
  - `account_health_state`,
  - `restriction_event`,
  - `rotation_policy`.
- Scheduler upgrades:
  - per-account quota,
  - global quota,
  - quiet hours,
  - randomized dispatch windows.
- Anti-blocking behavior:
  - adaptive cooldown after soft failures,
  - duplicate and near-duplicate content suppression,
  - staggered campaign dispatch across account pool.
- Source expansion behavior:
  - connector health checks and failover priorities,
  - source weighting and deduplication across connectors.
- Telegram expansion:
  - discovery candidate ranking,
  - queue-based manual approval operations,
  - join/post audit events and throttling.

## Codex Execution Tasks
1. Implement account pool tables and repository layer.
2. Build health scoring from publish outcomes and restriction signals.
3. Implement automatic account switch on failure classes.
4. Add quarantine and replacement workflow endpoints.
5. Extend scheduler with randomized conservative cadence policy.
6. Add duplicate/near-duplicate suppression checks.
7. Scale Telegram discovery/join operations with ranking, quotas, and review queues.
8. Add connector health monitoring, source weighting, and fallback logic.
9. Add account operations dashboard APIs.

## Acceptance Criteria
- System auto-routes around restricted accounts without stopping campaigns.
- Quarantined accounts are never selected for posting.
- Conservative limits are enforced per account and globally.
- Near-duplicate posts are blocked before publish.
- Telegram discovery/join throughput scales with review controls and full auditability.
- Source expansion does not degrade trend quality beyond defined thresholds.

## Tests
- Unit:
  - health score transitions,
  - rotation policy decisions,
  - cooldown backoff logic.
- Integration:
  - restriction handling,
  - quarantine and replacement flow,
  - source connector failover and weighting.
- E2E:
  - campaign execution across multiple accounts with simulated failures.
  - high-volume Telegram discovery to approved posting path.

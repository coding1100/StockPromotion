/**
 * PostingPolicyService — centralised posting discipline for StockTwits.
 *
 * Enforces the same hygiene that keeps official API clients like dlvr.it
 * out of trouble:
 *
 *   1. Token-bucket rate limit  — cap posts/hour per account
 *   2. Minimum inter-post gap   — randomised jitter so timing is not robotic
 *   3. Exponential backoff      — on 429 / rate-limit responses
 *   4. Content deduplication    — SHA-256 hash in a rolling window
 *
 * State is in-process (Map). Single BullMQ worker = safe. If you ever scale
 * to multiple worker processes, move the bucket + dedup state to Redis.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

type BucketState = {
  tokens: number;
  lastCheckedAt: number;
};

type BackoffState = {
  blockedUntil: number;
  consecutiveErrors: number;
};

type PostRecord = {
  hash: string;
  postedAt: number;
};

@Injectable()
export class PostingPolicyService {
  private readonly logger = new Logger(PostingPolicyService.name);

  private readonly buckets = new Map<string, BucketState>();
  private readonly backoffs = new Map<string, BackoffState>();
  private readonly recentPosts = new Map<string, PostRecord[]>();
  // Global cross-account dedup — prevents multiple accounts posting the same
  // content within the window (coordinated posting = spam signal to StockTwits).
  private readonly globalHashes = new Map<string, { postedAt: number; postedBy: string }>();

  constructor(private readonly configService: ConfigService) {}

  // ── Config ──────────────────────────────────────────────────────────────────

  private get postsPerHour(): number {
    return (
      this.configService.get<number>('STOCKTWITS_API_RATE_LIMIT_PER_HOUR') ?? 10
    );
  }

  private get minInterPostMs(): number {
    return (
      this.configService.get<number>('STOCKTWITS_API_MIN_INTER_POST_MS') ??
      300_000
    );
  }

  private get maxInterPostMs(): number {
    return (
      this.configService.get<number>('STOCKTWITS_API_MAX_INTER_POST_MS') ??
      600_000
    );
  }

  private get dedupWindowMs(): number {
    const minutes =
      this.configService.get<number>('STOCKTWITS_API_DEDUP_WINDOW_MINUTES') ??
      60;
    return minutes * 60_000;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** SHA-256 fingerprint of normalised message text (first 16 hex chars). */
  hashContent(message: string): string {
    return createHash('sha256')
      .update(message.trim().toLowerCase())
      .digest('hex')
      .slice(0, 16);
  }

  // ── Market hours ────────────────────────────────────────────────────────────

  /**
   * Return true if the current time is within the StockTwits active window
   * (Mon–Fri, 8 AM–6 PM Eastern Time, covering pre-market through post-market).
   * Off-hours posting looks robotic and attracts less engagement; combined with
   * automated accounts it raises the spam-signal score.
   */
  isMarketHours(now: Date = new Date()): boolean {
    const day = now.getUTCDay(); // 0=Sun, 6=Sat
    if (day === 0 || day === 6) return false;

    // Approximate ET offset: March–November = EDT (UTC-4), otherwise EST (UTC-5)
    const month = now.getUTCMonth() + 1;
    const etOffset = month >= 3 && month <= 11 ? -4 : -5;
    const etHour = ((now.getUTCHours() + etOffset) + 24) % 24;

    // 8 AM – 6 PM ET (includes pre-market and extended post-market)
    return etHour >= 8 && etHour < 18;
  }

  // ── Cross-account global dedup ───────────────────────────────────────────────

  /**
   * Throw if this content hash was already posted by ANY account within the
   * dedup window. Multiple accounts posting identical content simultaneously
   * is a coordinated-promotion spam signal — it burns all involved accounts.
   */
  checkGlobalDedup(contentHash: string): void {
    const now = Date.now();
    const existing = this.globalHashes.get(contentHash);
    if (existing && now - existing.postedAt < this.dedupWindowMs) {
      const ageMin = Math.round((now - existing.postedAt) / 60_000);
      throw new Error(
        `stocktwits_posting_policy_global_duplicate: content hash "${contentHash}" ` +
          `was already posted by account "${existing.postedBy}" ${ageMin} min ago. ` +
          `Multiple accounts posting identical content is a coordinated-spam signal — ` +
          `each account must post unique content.`,
      );
    }
  }

  /**
   * Record the global post hash after a confirmed successful send.
   * Call this once per post, alongside recordPost().
   */
  recordGlobalPost(contentHash: string, accountHandle: string): void {
    const now = Date.now();
    // Prune stale entries
    for (const [hash, entry] of this.globalHashes.entries()) {
      if (now - entry.postedAt >= this.dedupWindowMs) {
        this.globalHashes.delete(hash);
      }
    }
    this.globalHashes.set(contentHash, { postedAt: now, postedBy: accountHandle });
  }

  // ── Per-account policy ───────────────────────────────────────────────────────

  /**
   * Assert that posting is permitted right now.
   * Throws a descriptive error if blocked by backoff, token bucket, or dedup.
   * Does NOT mutate state — call recordPost() after a confirmed send.
   */
  checkPolicy(accountHandle: string, contentHash: string): void {
    const now = Date.now();

    // 1. Backoff gate — set by handleRateLimitResponse() after a 429
    const backoff = this.backoffs.get(accountHandle);
    if (backoff && now < backoff.blockedUntil) {
      const waitSec = Math.ceil((backoff.blockedUntil - now) / 1_000);
      throw new Error(
        `stocktwits_posting_policy_backoff: "${accountHandle}" is in backoff ` +
          `after a rate-limit response. Retry in ${waitSec}s ` +
          `(${backoff.consecutiveErrors} consecutive error(s)).`,
      );
    }

    // 2. Token-bucket gate
    const available = this.readTokens(accountHandle, now);
    if (available < 1) {
      const tokenIntervalMs = 3_600_000 / this.postsPerHour;
      const bucket = this.buckets.get(accountHandle);
      const waitMs = bucket
        ? Math.max(0, tokenIntervalMs - (now - bucket.lastCheckedAt))
        : tokenIntervalMs;
      throw new Error(
        `stocktwits_posting_policy_rate_limit: token bucket empty for ` +
          `"${accountHandle}". Next token in ~${Math.ceil(waitMs / 1_000)}s. ` +
          `Limit: ${this.postsPerHour} posts/hour.`,
      );
    }

    // 3. Content dedup gate — duplicate messages are a primary mute trigger
    const posts = (this.recentPosts.get(accountHandle) ?? []).filter(
      (p) => now - p.postedAt < this.dedupWindowMs,
    );
    if (posts.some((p) => p.hash === contentHash)) {
      throw new Error(
        `stocktwits_posting_policy_duplicate: content hash "${contentHash}" ` +
          `was already posted by "${accountHandle}" within the last ` +
          `${Math.round(this.dedupWindowMs / 60_000)} min. ` +
          `Duplicate content is a primary mute trigger — skipping.`,
      );
    }
  }

  /**
   * Record a confirmed post: consume one token, clear backoff streak, store hash.
   * Call ONLY after the transport (dlvr.it / API) confirms the post was accepted.
   */
  recordPost(accountHandle: string, contentHash: string): void {
    const now = Date.now();

    const available = this.readTokens(accountHandle, now);
    this.buckets.set(accountHandle, {
      tokens: Math.max(0, available - 1),
      lastCheckedAt: now,
    });

    const backoff = this.backoffs.get(accountHandle);
    if (backoff) {
      backoff.consecutiveErrors = 0;
      backoff.blockedUntil = 0;
    }

    const posts = (this.recentPosts.get(accountHandle) ?? []).filter(
      (p) => now - p.postedAt < this.dedupWindowMs,
    );
    posts.push({ hash: contentHash, postedAt: now });
    this.recentPosts.set(accountHandle, posts);

    // Record globally so other accounts don't post the same content
    this.recordGlobalPost(contentHash, accountHandle);

    this.logger.debug(
      `PostingPolicy: recorded post for "${accountHandle}" ` +
        `(tokens remaining: ${Math.max(0, available - 1).toFixed(2)}, ` +
        `dedup window entries: ${posts.length})`,
    );
  }

  /**
   * Apply exponential backoff after a 429 or rate-limit response.
   * @param retryAfterSeconds - value from Retry-After header if present
   */
  handleRateLimitResponse(
    accountHandle: string,
    retryAfterSeconds?: number,
  ): void {
    const now = Date.now();
    const existing = this.backoffs.get(accountHandle) ?? {
      blockedUntil: 0,
      consecutiveErrors: 0,
    };
    existing.consecutiveErrors += 1;

    let waitMs: number;
    if (retryAfterSeconds && retryAfterSeconds > 0) {
      // Honor Retry-After header + small jitter
      waitMs = retryAfterSeconds * 1_000 + Math.floor(Math.random() * 10_000);
    } else {
      // Exponential: 60 s × 2^(n-1) + jitter, cap at 30 min
      const base = 60_000 * Math.pow(2, existing.consecutiveErrors - 1);
      const jitter = Math.floor(Math.random() * 30_000);
      waitMs = Math.min(base + jitter, 30 * 60_000);
    }

    existing.blockedUntil = now + waitMs;
    this.backoffs.set(accountHandle, existing);

    this.logger.warn(
      `[PostingPolicy BACKOFF] "${accountHandle}" rate-limited ` +
        `(error #${existing.consecutiveErrors}). ` +
        `Blocked ${Math.round(waitMs / 1_000)}s until ` +
        `${new Date(existing.blockedUntil).toISOString()}.`,
    );
  }

  /**
   * Randomised inter-post delay respecting the configured min/max window.
   * Use between consecutive symbol posts in a manual multi-symbol batch.
   */
  getInterPostDelayMs(): number {
    const min = this.minInterPostMs;
    const max = Math.max(min, this.maxInterPostMs);
    return min + Math.floor(Math.random() * (max - min));
  }

  /**
   * True when the error string indicates the ACCOUNT ITSELF is muted/banned —
   * distinct from a transient rate-limit or network error.
   *
   * These errors MUST halt posting and MUST NOT trigger an account reroute.
   * Rerouting on a mute burns more accounts on identical content and signals
   * coordinated spam to StockTwits moderation.
   */
  static isAccountRestrictionError(message: string): boolean {
    return /stocktwits_account_muted|stocktwits_account_restricted|stocktwits_account_posting_restricted/i.test(
      message,
    );
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  /**
   * Read-only token count at `now`. Tokens refill continuously at
   * postsPerHour / hour, capped at postsPerHour (no burst).
   */
  private readTokens(accountHandle: string, now: number): number {
    const bucket = this.buckets.get(accountHandle);
    if (!bucket) {
      this.buckets.set(accountHandle, {
        tokens: this.postsPerHour,
        lastCheckedAt: now,
      });
      return this.postsPerHour;
    }
    const elapsed = now - bucket.lastCheckedAt;
    const tokenIntervalMs = 3_600_000 / this.postsPerHour;
    const accrued = elapsed / tokenIntervalMs;
    return Math.min(this.postsPerHour, bucket.tokens + accrued);
  }
}

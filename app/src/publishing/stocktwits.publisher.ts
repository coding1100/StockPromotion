import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { existsSync } from 'fs';
import { mkdir, readFile, readlink, rm, unlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
// patchright is a patched Playwright fork that fixes CDP-level detection vectors
// that playwright-extra + stealth cannot address (Runtime.enable, Page.enable CDP
// commands are visible to Cloudflare bot detection at the protocol level).
// It is a drop-in replacement — same API, different underlying Chromium patches.
// Import types from patchright too (it's a superset of Playwright types).
import { chromium, BrowserContext, Page, Locator } from 'patchright';

type StocktwitsAccountConfig = {
  username: string;
  password: string;
  handle?: string;
};

type StocktwitsRuntimeOverrides = {
  proxy?: string;
};

type RankedSymbolCandidate = {
  rank: number;
  symbol: string;
};

type CapSolverCreateTaskResponse = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: 'idle' | 'processing' | 'ready' | 'failed';
  taskId?: string;
};

type CapSolverTaskResult = {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: 'idle' | 'processing' | 'ready' | 'failed';
  taskId?: string;
  solution?: {
    token?: string;
    userAgent?: string;
    type?: string;
    /** Populated by AntiCloudflareTask — map of cookie name → value */
    cookies?: Record<string, string>;
  };
};

const CAPSOLVER_CREATE_TASK_URL = 'https://api.capsolver.com/createTask';
const CAPSOLVER_GET_TASK_RESULT_URL = 'https://api.capsolver.com/getTaskResult';

const DEFAULT_TRENDING_SYMBOL_LIMIT = 10;

@Injectable()
export class StocktwitsPublisher {
  private readonly logger = new Logger(StocktwitsPublisher.name);

  // Tracks per-proxy server health. Proxies with 3+ consecutive failures are
  // skipped for 15 minutes to avoid sending traffic through a flagged IP.
  private readonly proxyHealthMap = new Map<
    string,
    { failures: number; lastFailAt: number }
  >();

  constructor(private readonly configService: ConfigService) {}

  private get publishConfirmTimeoutMs(): number {
    return (
      this.configService.get<number>('STOCKTWITS_PUBLISH_CONFIRM_TIMEOUT_MS') ??
      30_000
    );
  }

  async bootstrapSession(account: StocktwitsAccountConfig): Promise<{
    authenticated: boolean;
    challengeVisible: boolean;
    userDataDir: string | null;
  }> {
    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>(
      'STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS',
    );
    const { context, page, userDataDir } = await this.createBrowserSession(
      account.handle,
    );

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs);
      await this.waitForAuthenticatedOrTimeout(page, manualLoginTimeoutMs);

      return {
        authenticated: await this.isAuthenticated(page),
        challengeVisible: await this.isChallengeVisible(page),
        userDataDir: userDataDir || null,
      };
    } finally {
      await context.close();
    }
  }

  async getSessionStatus(): Promise<{
    configured: boolean;
    authenticated: boolean;
    challengeVisible: boolean;
    userDataDir: string | null;
    currentUrl: string;
  }> {
    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    const userDataDir =
      this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() || '';

    if (!userDataDir) {
      return {
        configured: false,
        authenticated: false,
        challengeVisible: false,
        userDataDir: null,
        currentUrl: '',
      };
    }

    const { context, page } = await this.createBrowserSession();
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      return {
        configured: true,
        authenticated: await this.isAuthenticated(page),
        challengeVisible: await this.isChallengeVisible(page),
        userDataDir,
        currentUrl: page.url(),
      };
    } finally {
      await context.close();
    }
  }

  async discoverTopTrendingSymbols(
    account: StocktwitsAccountConfig,
    limit = DEFAULT_TRENDING_SYMBOL_LIMIT,
  ): Promise<string[]> {
    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    const postUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_POST_URL',
    );
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>(
      'STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS',
    );

    const { context, page } = await this.createBrowserSession(account.handle);
    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs);

      if (!(await this.isAuthenticated(page))) {
        throw new Error('stocktwits_session_refresh_required');
      }

      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.openTrendingPage(page, postUrl);
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.ensureTrendingAllView(page);

      const symbols = await this.waitForTopTrendingSymbols(page, limit, 20_000);
      if (symbols.length === 0) {
        throw new Error('stocktwits_trending_symbols_not_found');
      }

      return symbols;
    } finally {
      await context.close();
    }
  }

  /**
   * Run a pure engagement session for an account that is still in warm-up phase.
   * Opens a browser session, browses the home feed + 3-5 symbol pages, and likes
   * posts naturally — building account trust without posting any content.
   *
   * This does NOT produce a publishable post. It exists solely to build the
   * behavioural trust score StockTwits uses before an account is allowed to post
   * promotional content without triggering spam detection.
   *
   * Returns: number of likes performed and symbols visited.
   */
  async runEngagementSession(account: StocktwitsAccountConfig): Promise<{
    likesPerformed: number;
    symbolsVisited: number;
    durationMs: number;
  }> {
    const postUrl = this.configService.getOrThrow<string>('STOCKTWITS_POST_URL');
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');
    const start = Date.now();

    const { context, page } = await this.createBrowserSession(account.handle);
    let likesPerformed = 0;
    let symbolsVisited = 0;

    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs);

      if (!(await this.isAuthenticated(page))) {
        throw new Error('stocktwits_session_refresh_required');
      }

      // Run the full warm-up session (home feed + random symbols + likes)
      // warmUpSession already browses 1-2 symbol pages and likes 2-4 posts
      await this.warmUpSession(page, postUrl, []);

      // Additional browsing for accounts that need deeper warm-up
      const extraSymbols = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMD', 'AMZN'];
      const shuffled = extraSymbols.sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 3));
      for (const sym of shuffled) {
        try {
          const symbolUrl = this.resolveSymbolUrl(postUrl, sym);
          await page.goto(symbolUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          await this.dismissCookieBanner(page);
          await this.humanDelay(2_000, 4_000);
          await this.humanScroll(page, { direction: 'down', count: 2 + Math.floor(Math.random() * 3) });
          await this.humanDelay(1_000, 2_500);
          await this.likeRandomPostsInFeed(page, 1 + Math.floor(Math.random() * 2));
          likesPerformed += 1 + Math.floor(Math.random() * 2);
          symbolsVisited += 1;
          await this.humanDelay(1_500, 3_000);
        } catch { /* non-fatal — continue to next symbol */ }
      }

      this.logger.log(
        `Engagement session for @${account.handle}: ` +
          `${likesPerformed} likes, ${symbolsVisited} symbols, ` +
          `${Math.round((Date.now() - start) / 1_000)}s`,
      );
    } finally {
      await context.close();
    }

    return { likesPerformed, symbolsVisited, durationMs: Date.now() - start };
  }

  async publishToTargetSymbols(
    account: StocktwitsAccountConfig,
    message: string,
    jobId: string,
  ): Promise<{
    totalCount: number;
    successCount: number;
    failedCount: number;
    results: Array<{
      symbol: string;
      success: boolean;
      externalPostId: string | null;
      evidenceUri: string | null;
      error: string | null;
    }>;
  }> {
    const symbols = this.parseTargetSymbolsFromEnv();
    if (symbols.length === 0) {
      throw new Error(
        'stocktwits_no_target_symbols_configured: set STOCKTWITS_TARGET_SYMBOLS to a comma-separated list (e.g. GME,AAPL,TSLA).',
      );
    }

    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    const postUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_POST_URL',
    );
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>(
      'STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS',
    );

    const artifactsDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(artifactsDir, { recursive: true });

    const { context, page } = await this.createBrowserSession(account.handle);
    const proxyServerTarget = this.pickProxyForAccount(account.handle)?.server;
    const results: Array<{
      symbol: string;
      success: boolean;
      externalPostId: string | null;
      evidenceUri: string | null;
      error: string | null;
    }> = [];

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs);

      if (!(await this.isAuthenticated(page))) {
        throw new Error('stocktwits_session_refresh_required');
      }
      await this.checkAccountMutedStatus(page);

      // Brief pause after login before landing on the post feed
      await this.humanDelay(1_000, 2_500);
      await this.humanMouseDrift(page);

      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      // Glance at the home feed before starting the symbol loop
      await this.humanReadFeed(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);

      for (let i = 0; i < symbols.length; i += 1) {
        const symbol = symbols[i];
        const successImg = join(artifactsDir, `${jobId}-${symbol}.png`);
        const errorImg = join(artifactsDir, `${jobId}-${symbol}-error.png`);

        try {
          this.logger.log(
            `Stocktwits target symbol ${i + 1}/${symbols.length}: $${symbol}`,
          );
          const externalPostId = await this.postOnSymbolFeed(
            page,
            postUrl,
            symbol,
            message,
          );
          if (!externalPostId) {
            throw new Error(
              'stocktwits_publish_not_confirmed. Submit was clicked but no post confirmation/message ID was detected.',
            );
          }

          await page
            .screenshot({ path: successImg, fullPage: true })
            .catch(() => undefined);
          results.push({
            symbol,
            success: true,
            externalPostId,
            evidenceUri: successImg,
            error: null,
          });
        } catch (error) {
          const reason =
            error instanceof Error
              ? error.message
              : 'stocktwits_publish_failed';
          await page
            .screenshot({ path: errorImg, fullPage: true })
            .catch(() => undefined);
          this.logger.warn(
            `Stocktwits publish failed for $${symbol}: ${reason}`,
          );
          results.push({
            symbol,
            success: false,
            externalPostId: null,
            evidenceUri: errorImg,
            error: `${reason} | evidence:${errorImg}`,
          });
        }

        if (i < symbols.length - 1) {
          // Human inter-symbol cadence: 30-90 s. Same reasoning as batch path.
          const roll = Math.random();
          let baseDelay: number;
          if (roll < 0.25) {
            baseDelay = 30_000 + Math.floor(Math.random() * 15_000);
          } else if (roll < 0.7) {
            baseDelay = 45_000 + Math.floor(Math.random() * 30_000);
          } else {
            baseDelay = 75_000 + Math.floor(Math.random() * 15_000);
          }
          this.logger.debug(
            `Inter-symbol pause: ${Math.round(baseDelay / 1000)}s (roll=${roll.toFixed(2)})`,
          );
          await this.humanInterSymbolBrowse(page, postUrl);
          await this.delay(baseDelay);
        }
      }

      if (proxyServerTarget) this.recordProxySuccess(proxyServerTarget);
      return {
        totalCount: results.length,
        successCount: results.filter((r) => r.success).length,
        failedCount: results.filter((r) => !r.success).length,
        results,
      };
    } catch (targetErr) {
      if (proxyServerTarget) this.recordProxyFailure(proxyServerTarget);
      throw targetErr;
    } finally {
      await context.close();
    }
  }

  private parseTargetSymbolsFromEnv(): string[] {
    const raw =
      this.configService.get<string>('STOCKTWITS_TARGET_SYMBOLS')?.trim() ?? '';
    if (!raw) {
      return [];
    }
    const out: string[] = [];
    for (const token of raw.split(',')) {
      const normalized = normalizeStocktwitsSymbol(token.trim());
      if (normalized && !out.includes(normalized)) {
        out.push(normalized);
      }
    }
    return out;
  }

  async publish(
    account: StocktwitsAccountConfig,
    message: string,
    jobId: string,
    targetSymbol?: string,
    runtimeOverrides?: StocktwitsRuntimeOverrides,
  ): Promise<{ externalPostId: string; evidenceUri: string }> {
    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    const postUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_POST_URL',
    );
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>(
      'STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS',
    );

    const artifactsDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(artifactsDir, { recursive: true });
    const successImg = join(artifactsDir, `${jobId}.png`);
    const errorImg = join(artifactsDir, `${jobId}-error.png`);

    // Resolve the symbol: explicit param wins, otherwise fall back to the
    // first entry in STOCKTWITS_TARGET_SYMBOLS. The homepage composer flow is
    // intentionally NOT a fallback — every post must land on a /symbol/{X}
    // page. If neither source provides a symbol, fail loudly.
    let normalizedTarget = normalizeStocktwitsSymbol(targetSymbol ?? '');
    if (!normalizedTarget) {
      const envSymbols = this.parseTargetSymbolsFromEnv();
      if (envSymbols.length === 0) {
        throw new Error(
          'stocktwits_no_target_symbol: pass `targetSymbol` to publish() or set STOCKTWITS_TARGET_SYMBOLS in .env. The homepage composer flow has been removed.',
        );
      }
      normalizedTarget = envSymbols[0];
      this.logger.warn(
        `Stocktwits publish() called without targetSymbol — using "${normalizedTarget}" from STOCKTWITS_TARGET_SYMBOLS. For multi-symbol broadcast, call publishToTargetSymbols() instead.`,
      );
    }

    const { context, page, userDataDir, isTemp } = await this.createBrowserSession(
      account.handle,
      runtimeOverrides?.proxy,
    );
    const proxyServer = this.pickProxyForAccount(account.handle, runtimeOverrides?.proxy)?.server;

    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs, runtimeOverrides?.proxy);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs, runtimeOverrides?.proxy);

      if (!(await this.isAuthenticated(page))) {
        throw new Error('stocktwits_session_refresh_required');
      }
      await this.checkAccountMutedStatus(page);

      // Comprehensive session warm-up before posting.
      await this.warmUpSession(page, postUrl, [normalizedTarget]);

      const externalPostId = await this.postOnSymbolFeed(
        page,
        postUrl,
        normalizedTarget,
        message,
      );

      if (!externalPostId) {
        throw new Error(
          'stocktwits_publish_not_confirmed. Submit was clicked but no post confirmation/message ID was detected.',
        );
      }

      // Browse naturally after posting — sessions that close immediately after
      // posting score poorly in Stocktwits behavioural trust signals.
      await this.browseAfterPost(page, postUrl);

      if (proxyServer) this.recordProxySuccess(proxyServer);
      await page.screenshot({ path: successImg, fullPage: true });
      return {
        externalPostId,
        evidenceUri: successImg,
      };
    } catch (error) {
      if (proxyServer) this.recordProxyFailure(proxyServer);
      try {
        await page.screenshot({ path: errorImg, fullPage: true });
      } catch {
        this.logger.error('Failed to capture error screenshot.');
      }
      const msgText = error instanceof Error ? error.message : 'publish_failed';
      throw new Error(`${msgText} | evidence:${errorImg}`);
    } finally {
      await context.close();
      if (isTemp) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Publish a batch of symbol-specific messages inside a **single** browser
   * session. Login happens once; each symbol gets its own post. This is the
   * correct path for all manual-UI multi-symbol publishes — it avoids the
   * multiple rapid re-login events that a per-item session produces, and
   * ensures the proxy (when provided) covers login and every post identically.
   */
  async publishBatchForManual(
    account: StocktwitsAccountConfig,
    items: Array<{ symbol: string; message: string; jobId: string }>,
    runtimeProxy?: string,
  ): Promise<Array<{
    symbol: string;
    success: boolean;
    externalPostId: string | null;
    evidenceUri: string | null;
    error: string | null;
  }>> {
    if (items.length === 0) return [];

    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const postUrl  = this.configService.getOrThrow<string>('STOCKTWITS_POST_URL');
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');

    const artifactsDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(artifactsDir, { recursive: true });

    const { context, page, userDataDir, isTemp } = await this.createBrowserSession(
      account.handle,
      runtimeProxy,
    );
    const proxyServer = this.pickProxyForAccount(account.handle, runtimeProxy)?.server;

    const results: Array<{
      symbol: string;
      success: boolean;
      externalPostId: string | null;
      evidenceUri: string | null;
      error: string | null;
    }> = [];

    try {
      // ── Login once for the entire batch ────────────────────────────────────
      // Navigate to the HOME feed, NOT to /signin. If the persistent profile
      // has valid session cookies, Stocktwits will show the feed directly and
      // we skip the login form entirely. Navigating straight to /signin forces
      // a login attempt every run even when cookies are still good, and causes
      // the reload loop (networkidle + WebSocket timeout → catch → navigate again).
      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs, runtimeProxy);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs, runtimeProxy);

      if (!(await this.isAuthenticated(page))) {
        throw new Error('stocktwits_session_refresh_required');
      }
      await this.checkAccountMutedStatus(page);

      // Comprehensive session warm-up: browse home feed + 1-2 unrelated symbol
      // pages before posting. This is the most effective way to avoid blocks —
      // Stocktwits behavioural scoring expects users to browse before posting.
      const targetSymbolsForWarmUp = items.map((it) => it.symbol);
      await this.warmUpSession(page, postUrl, targetSymbolsForWarmUp);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs, runtimeProxy);

      // ── Post to each symbol in one session ────────────────────────────────
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const successImg = join(artifactsDir, `${item.jobId}.png`);
        const errorImg   = join(artifactsDir, `${item.jobId}-error.png`);

        try {
          this.logger.log(`Stocktwits batch ${i + 1}/${items.length}: $${item.symbol}`);
          const externalPostId = await this.postOnSymbolFeed(page, postUrl, item.symbol, item.message);
          if (!externalPostId) {
            throw new Error('stocktwits_publish_not_confirmed. Submit was clicked but no post confirmation/message ID was detected.');
          }
          await page.screenshot({ path: successImg, fullPage: true }).catch(() => undefined);
          results.push({ symbol: item.symbol, success: true, externalPostId, evidenceUri: successImg, error: null });
          // Post-publish natural browsing for the last item (intermediate items
          // get humanInterSymbolBrowse + delay which already covers this).
          if (i === items.length - 1) {
            await this.browseAfterPost(page, postUrl);
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'stocktwits_publish_failed';
          await page.screenshot({ path: errorImg, fullPage: true }).catch(() => undefined);
          this.logger.warn(`Stocktwits batch failed for $${item.symbol}: ${reason}`);
          results.push({ symbol: item.symbol, success: false, externalPostId: null, evidenceUri: errorImg, error: `${reason} | evidence:${errorImg}` });
        }

        if (i < items.length - 1) {
          // Human inter-symbol cadence: 30-90 s. Rapid-fire posting across
          // multiple tickers is the #1 behavioural signal for account muting.
          // Short delays (< 10 s) were the previous values — they are unsafe.
          const roll = Math.random();
          let baseDelay: number;
          if (roll < 0.25) {
            // Short window ~25% of the time: 30-45 s
            baseDelay = 30_000 + Math.floor(Math.random() * 15_000);
          } else if (roll < 0.7) {
            // Medium window ~45% of the time: 45-75 s
            baseDelay = 45_000 + Math.floor(Math.random() * 30_000);
          } else {
            // Long window ~30% of the time: 75-90 s
            baseDelay = 75_000 + Math.floor(Math.random() * 15_000);
          }
          this.logger.debug(
            `Inter-symbol pause: ${Math.round(baseDelay / 1000)}s (roll=${roll.toFixed(2)})`,
          );
          await this.humanInterSymbolBrowse(page, postUrl);
          await this.delay(baseDelay);
        }
      }

      if (proxyServer) this.recordProxySuccess(proxyServer);
      return results;
    } catch (batchError) {
      if (proxyServer) this.recordProxyFailure(proxyServer);
      throw batchError;
    } finally {
      await context.close();
      if (isTemp) {
        await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  // ============ CAPSOLVER INTEGRATION ============

  private async extractTurnstileParams(page: Page): Promise<{
    sitekey: string | null;
    cData: string | null;
    chlPageData: string | null;
    action: string | null;
    userAgent: string;
  }> {
    const userAgent = await page.evaluate(() => navigator.userAgent);

    // ── Pre-extraction: wait for Cloudflare's JS to inject the challenge ──────
    // The initial "Just a moment..." HTML is a bare shell — the Turnstile
    // iframe and any widget attributes are added dynamically by a script
    // loaded from challenges.cloudflare.com. We wait up to 10 s for the
    // iframe to appear before falling back to content-based strategies.
    await page
      .waitForSelector(
        'iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-sitekey]',
        { timeout: 10_000 },
      )
      .catch(() => undefined); // non-fatal — continue with remaining strategies

    // ── Strategy 1: DOM widget attributes (.cf-turnstile or [data-sitekey]) ──
    const fromDom = await page
      .evaluate(() => {
        const el =
          document.querySelector('.cf-turnstile') ||
          document.querySelector('[data-sitekey]');
        if (!el) return null;
        return {
          sitekey: el.getAttribute('data-sitekey'),
          cData: el.getAttribute('data-cdata'),
          action: el.getAttribute('data-action'),
        };
      })
      .catch(() => null);

    let sitekey: string | null = fromDom?.sitekey ?? null;

    // ── Strategy 2: Playwright locator for [data-sitekey] ──
    if (!sitekey) {
      sitekey = await page
        .locator('[data-sitekey]')
        .first()
        .getAttribute('data-sitekey', { timeout: 1_000 })
        .catch(() => null);
    }

    // ── Strategy 3: HTML source — attribute pattern ──
    const pageContent = await page.content().catch(() => '');
    if (!sitekey) {
      const m = pageContent.match(/data-sitekey=["']([^"']{10,}?)["']/);
      sitekey = m?.[1] ?? null;
    }

    // ── Strategy 4: Challenge iframe src URL (?k= or /k/ path segment) ────────
    // Cloudflare embeds the sitekey in the iframe URL. Examples:
    //   ?k=0x4AAAAAAAA...         (query param)
    //   /k/0x4AAAAAAAA.../        (path segment in newer CF pages)
    // We try a fresh getAttribute after already waiting above; if the iframe
    // still hasn't appeared we waitForSelector once more with a short budget.
    if (!sitekey) {
      const iframeSrc = await page
        .locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]')
        .first()
        .getAttribute('src', { timeout: 3_000 })
        .catch(() => null);
      if (iframeSrc) {
        try {
          const kParam = new URL(iframeSrc).searchParams.get('k');
          if (kParam) sitekey = kParam;
        } catch { /* invalid URL — fall through */ }
        if (!sitekey) {
          const pathMatch = iframeSrc.match(/[?&/]k[=/]([0-9A-Za-z_-]{10,})/);
          if (pathMatch) sitekey = pathMatch[1];
        }
        this.logger.debug(`Challenge iframe src: ${iframeSrc.slice(0, 200)}`);
      }
    }

    // ── Strategy 5: Inline <script> tags ──
    // Cloudflare injects scripts with patterns like:
    //   turnstile.render('#el', { sitekey: '...' })
    //   window._cf_chl_opt = { cTplV: ..., cvId: ..., cRay: ..., cSiteKey: '...' }
    if (!sitekey) {
      const fromScript = await page
        .evaluate(() => {
          const patterns = [
            /(?:sitekey|siteKey|websiteKey)\s*[:=]\s*["']([0-9A-Za-z_-]{10,})["']/,
            /cSiteKey\s*:\s*["']([0-9A-Za-z_-]{10,})["']/,
          ];
          for (const script of Array.from(document.querySelectorAll('script'))) {
            const src = script.textContent ?? '';
            for (const re of patterns) {
              const m = src.match(re);
              if (m?.[1]) return m[1];
            }
          }
          return null;
        })
        .catch(() => null);
      if (fromScript) sitekey = fromScript;
    }

    // ── Strategy 6: HTML source — JS pattern (catches server-rendered markup) ──
    if (!sitekey) {
      const patterns = [
        /(?:sitekey|siteKey|websiteKey)\s*[:=]\s*["']([0-9A-Za-z_-]{10,})["']/,
        /cSiteKey["']?\s*:\s*["']([0-9A-Za-z_-]{10,})["']/,
        /turnstile\.render\([^)]*["']([0-9A-Za-z_-]{10,})["']/,
      ];
      for (const re of patterns) {
        const m = pageContent.match(re);
        if (m?.[1]) { sitekey = m[1]; break; }
      }
    }

    // ── Strategy 7: window._cf_chl_opt global ──
    if (!sitekey) {
      sitekey = await page
        .evaluate(() => {
          const opt = (window as any)._cf_chl_opt as Record<string, unknown> | undefined;
          return (opt?.cSiteKey as string) ?? null;
        })
        .catch(() => null);
    }

    // ── Intercept future turnstile.render() calls for cData / chlPageData ──
    const intercepted = await page.evaluate(() => {
      return new Promise<{
        cData: string | null;
        chlPageData: string | null;
        action: string | null;
      }>((resolve) => {
        const result = {
          cData: null as string | null,
          chlPageData: null as string | null,
          action: null as string | null,
        };

        const checkTurnstile = () => {
          if ((window as any).turnstile) {
            const originalRender = (window as any).turnstile.render;
            (window as any).turnstile.render = function (a: any, b: any) {
              result.cData = b?.cData ?? null;
              result.chlPageData = b?.chlPageData ?? null;
              result.action = b?.action ?? null;
              if (b?.callback) {
                (window as any).__turnstileCallback = b.callback;
              }
              return originalRender?.apply(this, arguments);
            };
            resolve(result);
            return true;
          }
          return false;
        };

        if (checkTurnstile()) return;

        const interval = setInterval(() => {
          if (checkTurnstile()) clearInterval(interval);
        }, 50);

        setTimeout(() => {
          clearInterval(interval);
          resolve(result);
        }, 3_000);
      });
    });

    return {
      sitekey,
      cData: fromDom?.cData ?? intercepted.cData,
      chlPageData: intercepted.chlPageData,
      action: fromDom?.action ?? intercepted.action,
      userAgent,
    };
  }

  private async createCapSolverTask(params: {
    sitekey: string;
    pageUrl: string;
    cData?: string | null;
    action?: string | null;
  }): Promise<string> {
    const apiKey = this.configService.getOrThrow<string>('CAPSOLVER_API_KEY');

    const taskPayload: Record<string, unknown> = {
      type: 'AntiTurnstileTaskProxyLess',
      websiteURL: params.pageUrl,
      websiteKey: params.sitekey,
    };

    const metadata: Record<string, string> = {};
    if (params.action) {
      metadata.action = params.action;
    }
    if (params.cData) {
      metadata.cdata = params.cData;
    }
    if (Object.keys(metadata).length > 0) {
      taskPayload.metadata = metadata;
    }

    const response = await fetch(CAPSOLVER_CREATE_TASK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: taskPayload,
      }),
    });

    if (!response.ok) {
      throw new Error(`capsolver createTask failed: HTTP ${response.status}`);
    }

    const data = (await response.json()) as CapSolverCreateTaskResponse;

    if (data.errorId !== 0) {
      throw new Error(
        `capsolver createTask error: ${data.errorCode} - ${data.errorDescription}`,
      );
    }

    if (!data.taskId) {
      throw new Error('capsolver createTask returned no taskId');
    }

    this.logger.log(`capsolver task created: ${data.taskId}`);
    return data.taskId;
  }

  private async getCapSolverResult(
    taskId: string,
    maxWaitMs = 120_000,
  ): Promise<CapSolverTaskResult> {
    const apiKey = this.configService.getOrThrow<string>('CAPSOLVER_API_KEY');
    const startedAt = Date.now();
    const pollInterval = 1_000;

    while (Date.now() - startedAt < maxWaitMs) {
      const response = await fetch(CAPSOLVER_GET_TASK_RESULT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: apiKey,
          taskId,
        }),
      });

      if (!response.ok) {
        throw new Error(
          `capsolver getTaskResult failed: HTTP ${response.status}`,
        );
      }

      const data = (await response.json()) as CapSolverTaskResult;

      if (data.errorId !== 0) {
        throw new Error(
          `capsolver getTaskResult error: ${data.errorCode} - ${data.errorDescription}`,
        );
      }

      if (data.status === 'ready') {
        this.logger.log(`capsolver task ${taskId} solved`);
        return data;
      }

      if (data.status === 'failed') {
        throw new Error(
          `capsolver task ${taskId} failed: ${data.errorCode} - ${data.errorDescription}`,
        );
      }

      this.logger.debug(
        `capsolver task ${taskId} status=${data.status ?? 'unknown'}, retrying in ${pollInterval}ms...`,
      );
      await this.delay(pollInterval);
    }

    throw new Error(`capsolver task ${taskId} timed out after ${maxWaitMs}ms`);
  }

  private formatProxyForCapSolver(runtimeProxy: string): string | undefined {
    const parsed = this.parseProxyConnectionString(runtimeProxy);
    if (!parsed) return undefined;
    const server = parsed.server.replace(/^https?:\/\//, '');
    if (parsed.username && parsed.password) {
      return `http://${parsed.username}:${parsed.password}@${server}`;
    }
    return `http://${server}`;
  }

  /**
   * Inject a cf_clearance cookie returned by AntiCloudflareTask into the
   * browser context, then reload so Cloudflare honours it.
   */
  private async injectCloudflareClearanceCookie(
    page: Page,
    solution: NonNullable<CapSolverTaskResult['solution']>,
  ): Promise<void> {
    const context = page.context();
    const cookieMap: Record<string, string> = {};

    // Prefer the structured cookies map if present
    if (solution.cookies && typeof solution.cookies === 'object') {
      Object.assign(cookieMap, solution.cookies);
    }

    // token field may be "cf_clearance=<value>" or just the raw value
    if (!cookieMap['cf_clearance'] && solution.token) {
      const raw = solution.token;
      cookieMap['cf_clearance'] = raw.startsWith('cf_clearance=')
        ? raw.slice('cf_clearance='.length)
        : raw;
    }

    if (Object.keys(cookieMap).length === 0) {
      throw new Error('capsolver_anticloudflare_no_cookies_in_solution');
    }

    await context.addCookies(
      Object.entries(cookieMap).map(([name, value]) => ({
        name,
        value,
        domain: '.stocktwits.com',
        path: '/',
        httpOnly: name === 'cf_clearance',
        secure: true,
        sameSite: 'None' as const,
      })),
    );

    this.logger.log(
      `Injected CapSolver cookies: ${Object.keys(cookieMap).join(', ')} — navigating to login page`,
    );
    // Navigate explicitly to the login URL rather than reloading — reload can
    // follow a Cloudflare redirect to the homepage, putting us off /signin before
    // performLoginIfNeeded runs.
    const loginUrl =
      this.configService.get<string>('STOCKTWITS_LOGIN_URL') ??
      'https://stocktwits.com/signin';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.waitForTimeout(2_000);
  }

  private async solveChallengeWithCapSolver(
    page: Page,
    runtimeProxy?: string,
  ): Promise<void> {
    this.logger.log(
      'Attempting to solve Cloudflare challenge via CapSolver...',
    );

    // Wait up to 8 s for a Turnstile iframe — it can load later than the
    // surrounding challenge shell, so a 4 s window was too narrow.
    const hasTurnstileIframe = await page
      .locator(
        'iframe[src*="challenges.cloudflare.com"], ' +
        'iframe[src*="turnstile"], ' +
        'iframe[title*="Widget containing a Cloudflare security challenge" i]',
      )
      .first()
      .isVisible({ timeout: 8_000 })
      .catch(() => false);

    if (!hasTurnstileIframe) {
      // ── Managed JS challenge — use AntiCloudflareTask ──────────────────────
      // This is an IUAM fingerprint/PoW check, not a Turnstile widget.
      // CapSolver's AntiCloudflareTask uses a real browser at our proxy IP
      // and returns a cf_clearance cookie that bypasses the check.
      if (!runtimeProxy) {
        // Without a proxy, CapSolver would solve from their own IP which won't
        // match our session IP — the cookie would be rejected. Log and bail so
        // the caller can fall through to the manual/human flow.
        this.logger.warn(
          'Managed JS challenge detected and no proxy provided — ' +
          'AntiCloudflareTask requires a proxy to generate an IP-matched ' +
          'cf_clearance cookie. Skipping CapSolver; falling back to manual.',
        );
        throw new Error(
          'capsolver_skipped_no_proxy_for_anticloudflare',
        );
      }

      this.logger.log(
        'Managed JS challenge — trying CapSolver AntiCloudflareTask with proxy…',
      );
      const apiKey = this.configService.getOrThrow<string>('CAPSOLVER_API_KEY');
      const proxyStr = this.formatProxyForCapSolver(runtimeProxy);
      const pageUrl = page.url();

      const createResp = await fetch(CAPSOLVER_CREATE_TASK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: apiKey,
          task: {
            type: 'AntiCloudflareTask',
            websiteURL: pageUrl,
            ...(proxyStr ? { proxy: proxyStr } : {}),
          },
        }),
      });
      if (!createResp.ok) {
        const body = await createResp.text().catch(() => '(unreadable)');
        this.logger.error(`CapSolver AntiCloudflareTask HTTP ${createResp.status}: ${body}`);
        throw new Error(`capsolver AntiCloudflareTask HTTP ${createResp.status}: ${body}`);
      }
      const createData = (await createResp.json()) as CapSolverCreateTaskResponse;
      if (createData.errorId) {
        throw new Error(
          `capsolver AntiCloudflareTask error: ${createData.errorCode ?? createData.errorDescription}`,
        );
      }
      if (!createData.taskId) {
        throw new Error('capsolver AntiCloudflareTask: no taskId returned');
      }
      this.logger.log(`CapSolver AntiCloudflareTask created: ${createData.taskId}`);

      const result = await this.getCapSolverResult(createData.taskId);
      if (!result.solution) {
        throw new Error('capsolver AntiCloudflareTask: empty solution');
      }
      await this.injectCloudflareClearanceCookie(page, result.solution);
      this.logger.log('Cloudflare IUAM solved via CapSolver AntiCloudflareTask');
      return;
    }

    // ── Network-intercept sitekey (earliest possible signal) ─────────────────
    // Cloudflare's challenge JS requests the Turnstile iframe URL which always
    // contains the sitekey as a `k` query / path parameter. By listening to
    // outgoing requests we can grab it before the DOM is fully rendered.
    let networkSitekey: string | null = null;
    const onRequest = (req: { url: () => string }) => {
      const u = req.url();
      if (!u.includes('challenges.cloudflare.com')) return;
      // Query param: ?k=0x4AAAA...
      try {
        const kParam = new URL(u).searchParams.get('k');
        if (kParam && kParam.length >= 10) { networkSitekey = kParam; return; }
      } catch { /* ignore invalid URL */ }
      // Path segment: /k/0x4AAAA... or ?k=0x4AAAA
      const m = u.match(/[?&/]k[=/](0x[0-9A-Fa-f]{8,}|[0-9A-Za-z_-]{20,})/);
      if (m) networkSitekey = m[1];
    };
    page.on('request', onRequest);
    // Give the page's challenge JS a moment to fire its first requests
    await page.waitForTimeout(2_000);
    page.off('request', onRequest);

    const extracted = await this.extractTurnstileParams(page);
    // Prefer the network-intercepted key — it's available before DOM renders
    const resolvedSitekey = extracted.sitekey ?? networkSitekey;
    if (!extracted.sitekey && networkSitekey) {
      this.logger.debug(`Using network-intercepted sitekey: ${networkSitekey}`);
    }
    const params = { ...extracted, sitekey: resolvedSitekey };
    const pageUrl = page.url();

    this.logger.debug(
      `Turnstile extraction — sitekey: ${params.sitekey ?? 'NOT FOUND'}, action: ${params.action ?? 'none'}, cData: ${params.cData ? 'present' : 'missing'}, url: ${pageUrl}`,
    );

    if (!params.sitekey) {
      // Dump a snippet of page source to help diagnose where the key is hidden
      const snippet = await page.content().catch(() => '');
      this.logger.debug(
        `Challenge page snippet (first 800 chars): ${snippet.slice(0, 800)}`,
      );
      throw new Error('capsolver_turnstile_sitekey_not_found');
    }

    const taskId = await this.createCapSolverTask({
      sitekey: params.sitekey,
      pageUrl,
      cData: params.cData,
      action: params.action,
    });

    const result = await this.getCapSolverResult(taskId);

    if (!result.solution?.token) {
      throw new Error('capsolver_turnstile_token_missing_in_response');
    }

    await this.injectTurnstileToken(
      page,
      result.solution.token,
      result.solution.userAgent,
    );

    this.logger.log('Cloudflare challenge solved via CapSolver');
  }

  private async injectTurnstileToken(
    page: Page,
    token: string,
    returnedUserAgent?: string,
  ): Promise<void> {
    await page.evaluate((t) => {
      const setValue = (name: string) => {
        const input = document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
        if (input) {
          input.value = t;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      setValue('cf-turnstile-response');
      setValue('g-recaptcha-response');

      const textareas = document.querySelectorAll(
        'textarea.g-recaptcha-response',
      );
      textareas.forEach((ta) => {
        (ta as HTMLTextAreaElement).value = t;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }, token);

    await page.evaluate((t) => {
      const callback = (window as any).__turnstileCallback;
      if (typeof callback === 'function') {
        callback(t);
      }
    }, token);

    if (returnedUserAgent) {
      this.logger.debug(`CapSolver returned userAgent: ${returnedUserAgent}`);
    }

    await page.waitForTimeout(2_000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ============ HUMAN BEHAVIOR HELPERS ============

  /**
   * Random delay within a range — the core building block for all human pacing.
   */
  private humanDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.floor(Math.random() * (maxMs - minMs + 1));
    return this.delay(ms);
  }

  /**
   * Move the mouse from one point to another along a quadratic Bézier curve.
   * The random control point produces a natural arc rather than a straight
   * teleport. Speed is eased — slower at start and end, faster through the
   * middle — matching the acceleration profile of a human wrist.
   */
  private async bezierMouseMove(
    page: Page,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<void> {
    const steps = 14 + Math.floor(Math.random() * 12);
    const cpX = (fromX + toX) / 2 + (Math.random() - 0.5) * 200;
    const cpY = (fromY + toY) / 2 + (Math.random() - 0.5) * 140;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const x = Math.round((1 - t) ** 2 * fromX + 2 * (1 - t) * t * cpX + t ** 2 * toX);
      const y = Math.round((1 - t) ** 2 * fromY + 2 * (1 - t) * t * cpY + t ** 2 * toY);
      await page.mouse.move(x, y).catch(() => undefined);
      // Ease-in-out: sin curve makes middle of path fastest
      const eased = Math.sin(t * Math.PI) + 0.25;
      await this.delay(Math.max(4, Math.round(18 / eased + Math.random() * 12)));
    }
  }

  /**
   * Natural mouse drift: wander through 2–4 waypoints via Bézier curves,
   * mimicking a human moving the cursor while reading the page.
   */
  private async humanMouseDrift(page: Page): Promise<void> {
    const waypointCount = 2 + Math.floor(Math.random() * 3);
    let curX = 300 + Math.floor(Math.random() * 600);
    let curY = 200 + Math.floor(Math.random() * 400);
    await page.mouse.move(curX, curY).catch(() => undefined);
    for (let i = 0; i < waypointCount; i += 1) {
      const targetX = 150 + Math.floor(Math.random() * 900);
      const targetY = 100 + Math.floor(Math.random() * 500);
      await this.bezierMouseMove(page, curX, curY, targetX, targetY);
      curX = targetX;
      curY = targetY;
      await this.humanDelay(60, 280);
    }
  }

  /**
   * Human-like scrolling: varied amounts, occasional micro-reversal (scroll up
   * a bit as if re-reading something) with natural pauses between scrolls.
   */
  private async humanScroll(
    page: Page,
    opts?: { direction?: 'down' | 'up' | 'mixed'; count?: number },
  ): Promise<void> {
    const direction = opts?.direction ?? 'down';
    const count = opts?.count ?? 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < count; i += 1) {
      const baseAmount = 120 + Math.floor(Math.random() * 320);
      let deltaY: number;
      if (direction === 'up') {
        deltaY = -baseAmount;
      } else if (direction === 'mixed') {
        deltaY =
          Math.random() > 0.72 ? -Math.floor(baseAmount * 0.4) : baseAmount;
      } else {
        deltaY = baseAmount;
      }
      // Move mouse to a plausible reading zone before each scroll
      const mx = 350 + Math.floor(Math.random() * 600);
      const my = 250 + Math.floor(Math.random() * 350);
      await page.mouse.move(mx, my, { steps: 4 }).catch(() => undefined);
      await page.mouse.wheel(0, deltaY).catch(() => undefined);
      await this.humanDelay(280, 820);
    }
  }

  /**
   * Simulate a human reading the feed before acting: scroll down, pause, maybe
   * scroll back a bit, drift mouse as if hovering over posts.
   */
  private async humanReadFeed(page: Page): Promise<void> {
    // Initial landing pause — absorb the page like a human would
    await this.humanDelay(900, 2_400);
    await this.humanScroll(page, {
      direction: 'down',
      count: 1 + Math.floor(Math.random() * 2),
    });
    await this.humanDelay(800, 2_800);
    // ~45% chance: scroll up a bit as if re-reading something
    if (Math.random() > 0.55) {
      await this.humanScroll(page, { direction: 'up', count: 1 });
      await this.humanDelay(500, 1_400);
    }
    await this.humanMouseDrift(page);
    await this.humanDelay(600, 1_600);
  }

  /**
   * Approach an element along a curved Bézier path before clicking — no
   * teleport-clicks. Starts from outside the element boundary and curves into
   * the click target the way a hand naturally moves toward a button.
   */
  private async humanHoverBeforeClick(
    page: Page,
    locator: Locator,
  ): Promise<void> {
    try {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        const targetX = box.x + box.width  * (0.2 + Math.random() * 0.6);
        const targetY = box.y + box.height * (0.2 + Math.random() * 0.6);
        const startX  = targetX - 60 - Math.random() * 80;
        const startY  = targetY - 40 - Math.random() * 50;
        await this.bezierMouseMove(page, startX, startY, targetX, targetY);
        await this.humanDelay(120, 380);
      } else {
        await locator.hover({ timeout: 2_000 }).catch(() => undefined);
        await this.humanDelay(100, 300);
      }
    } catch {
      // Non-fatal — skip hover if element is gone
    }
  }

  /**
   * Type text as a human does: burst a few characters, pause to think, very
   * occasionally "mistype and fix" one character. No uniform machine-gun delay.
   */
  private async humanTypeText(page: Page, text: string): Promise<void> {
    const chars = text.split('');
    let idx = 0;
    while (idx < chars.length) {
      // Burst: 2–9 chars typed fast (simulates keyboard feel)
      const burstLen = 2 + Math.floor(Math.random() * 8);
      const chunk = chars.slice(idx, idx + burstLen).join('');
      await page.keyboard.type(chunk, {
        delay: 28 + Math.floor(Math.random() * 75),
      });
      idx += burstLen;

      // Occasional thinking pause between bursts (~60% of the time)
      if (Math.random() > 0.4) {
        await this.humanDelay(150, 750);
      }

      // Rare micro-correction: delete last char and retype (~6% chance)
      if (Math.random() > 0.94 && idx > 0 && idx < chars.length) {
        await this.humanDelay(180, 440);
        await page.keyboard.press('Backspace').catch(() => undefined);
        await this.humanDelay(200, 520);
        const replayChar = chars[idx - 1] ?? '';
        if (replayChar) {
          await page.keyboard.type(replayChar, {
            delay: 55 + Math.floor(Math.random() * 60),
          });
        }
      }
    }
  }

  /**
   * Simulate a human reviewing what they just typed before hitting Post:
   * brief pause, possible selection/re-read mouse movement over composer.
   */
  private async humanReviewBeforePost(
    page: Page,
    composerLocator: Locator,
  ): Promise<void> {
    await this.humanDelay(600, 1_800);
    // Drift mouse over the composed text as if re-reading it
    try {
      const box = await composerLocator.boundingBox().catch(() => null);
      if (box) {
        const startX = box.x + box.width * 0.1;
        const endX = box.x + box.width * 0.85;
        const y = box.y + box.height * (0.3 + Math.random() * 0.4);
        await page.mouse.move(startX, y, { steps: 3 }).catch(() => undefined);
        await this.humanDelay(200, 500);
        await page.mouse
          .move(endX, y, { steps: 8 + Math.floor(Math.random() * 8) })
          .catch(() => undefined);
        await this.humanDelay(300, 900);
      }
    } catch {
      // Non-fatal
    }
    await this.humanDelay(300, 800);
  }

  /**
   * Between-symbol idle: browse the home feed, scroll a bit, as a human would
   * do between posting to different tickers rather than immediately navigating.
   */
  private async humanInterSymbolBrowse(
    page: Page,
    postUrl: string,
  ): Promise<void> {
    // ~60% chance: wander to home feed and browse briefly
    if (Math.random() > 0.4) {
      await page
        .goto(postUrl, { waitUntil: 'domcontentloaded' })
        .catch(() => undefined);
      await this.dismissCookieBanner(page);
      await this.humanReadFeed(page);
      // ~50% chance: like a post spotted during the inter-symbol home-feed visit
      if (Math.random() > 0.5) {
        await this.likeRandomPostsInFeed(page, 1 + Math.floor(Math.random() * 2));
        await this.humanDelay(400, 900);
      }
    } else {
      // Otherwise just idle on current page with random scrolling
      await this.humanDelay(1_200, 3_500);
      await this.humanScroll(page, {
        direction: 'mixed',
        count: 1 + Math.floor(Math.random() * 2),
      });
      await this.humanDelay(800, 2_000);
    }
  }

  /**
   * Comprehensive session warm-up executed once per session right after login.
   *
   * Mimics a real user who just logged in and browsed the platform for ~40-70
   * seconds before posting. This is the single most effective anti-block
   * technique short of using a persistent profile (which we now also do).
   *
   * Strategy:
   *  1. Glance at home feed — scroll naturally, hover over a couple of posts.
   *  2. Visit 1-2 high-activity symbols from a warm-up pool (never the target).
   *  3. On each warm-up symbol page, scroll through a handful of posts.
   *  4. Return to home feed for a final glance.
   *
   * Total elapsed: ~40-70 s depending on randomization.
   */
  private async warmUpSession(
    page: Page,
    postUrl: string,
    targetSymbols: string[],
    discoveredTrending?: string[],
  ): Promise<void> {
    // Large, diverse pool — high-volume liquid names across sectors.
    // Blending real trending symbols (when available) makes the browsing pattern
    // indistinguishable from a human who just checked the trending page.
    const staticPool = [
      'SPY', 'QQQ', 'IWM', 'DIA', 'VTI',
      'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'AMD',
      'NFLX', 'ORCL', 'CRM', 'ADBE', 'INTC', 'QCOM', 'TXN',
      'JPM', 'BAC', 'WFC', 'GS', 'MS',
      'JNJ', 'PFE', 'MRK', 'ABBV', 'UNH',
      'XOM', 'CVX', 'COP', 'SLB',
      'WMT', 'COST', 'TGT', 'AMZN',
      'DIS', 'CMCSA', 'T', 'VZ',
      'GE', 'BA', 'CAT', 'MMM', 'HON',
      'COIN', 'MSTR', 'RIOT', 'MARA',
      'BTC.X', 'ETH.X',
    ];
    const targets = new Set(targetSymbols.map((s) => s.toUpperCase()));

    // Seed with discovered trending symbols that are not our targets —
    // visiting the actual trending list is exactly what real users do.
    const trendingSeeds = (discoveredTrending ?? [])
      .map((s) => s.toUpperCase())
      .filter((s) => !targets.has(s))
      .slice(0, 6);

    const combined = [...new Set([...trendingSeeds, ...staticPool])];
    const available = combined.filter((s) => !targets.has(s));
    // Fisher-Yates shuffle for true randomness
    for (let i = available.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    const warmSymbols = available.slice(0, 1 + Math.floor(Math.random() * 2));

    this.logger.log(`Session warm-up START: home feed → ${warmSymbols.map((s) => '$' + s).join(' → ')} → home feed`);

    // ── Phase 1: Home feed ─────────────────────────────────────────────────────
    this.logger.log('Warm-up [1/3]: navigating to home feed');
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.dismissCookieBanner(page);
      this.logger.log(`Warm-up [1/3]: landed on home feed — ${page.url()}`);
      await this.humanDelay(1_800, 3_200);
      const scrollCount = 3 + Math.floor(Math.random() * 3);
      this.logger.debug(`Warm-up [1/3]: scrolling home feed ${scrollCount} times`);
      for (let i = 0; i < scrollCount; i += 1) {
        await this.humanScroll(page, { direction: 'down', count: 1 });
        await this.humanDelay(900, 2_400);
        if (Math.random() > 0.6) {
          await this.humanMouseDrift(page);
          await this.humanDelay(800, 1_800);
        }
      }
      if (Math.random() > 0.5) {
        await this.humanScroll(page, { direction: 'up', count: 1 + Math.floor(Math.random() * 2) });
        await this.humanDelay(600, 1_400);
      }
      await this.humanMouseDrift(page);
      await this.humanDelay(1_000, 2_000);
      // Engage: like 2-4 posts — builds genuine activity history that Stocktwits
      // trust-scoring weights. Accounts that only post without engaging get flagged.
      await this.likeRandomPostsInFeed(page, 2 + Math.floor(Math.random() * 3));
      await this.humanDelay(600, 1_200);
      this.logger.log('Warm-up [1/3]: home feed done');
    } catch (err) {
      this.logger.warn(`Warm-up [1/3]: home feed failed (${err instanceof Error ? err.message : err}) — continuing`);
    }

    // ── Phase 2: Warm-up symbol pages ─────────────────────────────────────────
    for (let wi = 0; wi < warmSymbols.length; wi += 1) {
      const sym = warmSymbols[wi];
      this.logger.log(`Warm-up [2/${warmSymbols.length}]: navigating to $${sym} symbol feed`);
      try {
        const symbolUrl = this.resolveSymbolUrl(postUrl, sym);
        await page.goto(symbolUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await this.dismissCookieBanner(page);
        this.logger.log(`Warm-up: landed on $${sym} — ${page.url()}`);
        await this.humanDelay(1_500, 3_000);

        const symScrolls = 2 + Math.floor(Math.random() * 3);
        this.logger.debug(`Warm-up: scrolling $${sym} feed ${symScrolls} times`);
        for (let i = 0; i < symScrolls; i += 1) {
          await this.humanScroll(page, { direction: 'down', count: 1 });
          await this.humanDelay(1_000, 2_500);
          if (Math.random() > 0.65) {
            await this.humanMouseDrift(page);
            await this.humanDelay(500, 1_200);
          }
        }
        if (Math.random() > 0.55) {
          await this.humanScroll(page, { direction: 'up', count: 1 });
          await this.humanDelay(700, 1_500);
        }
        await this.humanDelay(800, 1_800);
        // ~60% chance: like a post on this symbol page
        if (Math.random() > 0.4) {
          await this.likeRandomPostsInFeed(page, 1 + Math.floor(Math.random() * 2));
          await this.humanDelay(400, 900);
        }
        this.logger.log(`Warm-up: $${sym} done`);
      } catch (err) {
        this.logger.warn(`Warm-up: $${sym} failed (${err instanceof Error ? err.message : err}) — continuing`);
      }
    }

    // ── Phase 3: Final home-feed glance ───────────────────────────────────────
    this.logger.log('Warm-up [3/3]: final home-feed glance');
    try {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await this.dismissCookieBanner(page);
      await this.humanDelay(1_200, 2_500);
      await this.humanScroll(page, { direction: 'down', count: 1 + Math.floor(Math.random() * 2) });
      await this.humanDelay(800, 1_800);
      await this.humanMouseDrift(page);
      await this.humanDelay(600, 1_200);
      this.logger.log('Warm-up [3/3]: done');
    } catch (err) {
      this.logger.warn(`Warm-up [3/3]: final home glance failed (${err instanceof Error ? err.message : err}) — continuing`);
    }

    this.logger.log('Session warm-up COMPLETE — proceeding to post');
  }

  /**
   * Like 1-4 random, un-liked posts visible in the current viewport.
   * Uses page.evaluate + coordinate clicks so React re-renders can't
   * invalidate the locator between hover and click.
   * Always resolves — failures are logged at debug level only.
   */
  private async likeRandomPostsInFeed(page: Page, maxLikes = 3): Promise<void> {
    try {
      const coords = await page.evaluate((): Array<{ x: number; y: number }> => {
        const isActive = (el: Element): boolean =>
          el.getAttribute('aria-pressed') === 'true' ||
          el.classList.contains('active') ||
          el.classList.contains('liked') ||
          el.classList.contains('bullish') ||
          (el as HTMLButtonElement).disabled === true;

        const isLikeBtn = (btn: Element): boolean => {
          const label = (btn.getAttribute('aria-label') || '').toLowerCase();
          const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
          const svgLabel = (btn.querySelector('svg')?.getAttribute('aria-label') || '').toLowerCase();
          return (
            label.includes('like') || label.includes('bull') || label.includes('heart') ||
            testId.includes('like') || testId.includes('bull') ||
            svgLabel.includes('like') || svgLabel.includes('bull') || svgLabel.includes('heart')
          );
        };

        return Array.from(document.querySelectorAll('button'))
          .filter(btn => isLikeBtn(btn) && !isActive(btn))
          .map(btn => {
            const r = btn.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })
          .filter(({ x, y }) => x > 0 && y > 60 && y < window.innerHeight - 60);
      }).catch(() => [] as Array<{ x: number; y: number }>);

      if (coords.length === 0) {
        this.logger.debug('No likeable posts in viewport — skipping engagement');
        return;
      }

      // Fisher-Yates shuffle
      for (let i = coords.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [coords[i], coords[j]] = [coords[j], coords[i]];
      }
      const targets = coords.slice(0, Math.min(maxLikes, coords.length));

      let liked = 0;
      for (const { x, y } of targets) {
        try {
          await this.bezierMouseMove(page, x - 55, y - 25, x, y);
          await this.humanDelay(180, 450);
          await page.mouse.click(x, y);
          liked++;
          await this.humanDelay(700, 1_600);
        } catch { /* non-fatal */ }
      }

      if (liked > 0) {
        this.logger.log(`Engaged: liked ${liked} post(s) in current feed`);
      }
    } catch (err) {
      this.logger.debug(`likeRandomPostsInFeed skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Post-publish natural browsing: scroll the feed after posting, optionally
   * like a post or two, optionally glance at the home feed. Mimics a human who
   * posted and kept using the platform — a strong anti-mute trust signal since
   * Stocktwits scores sessions that end immediately after posting as suspicious.
   */
  private async browseAfterPost(page: Page, postUrl: string): Promise<void> {
    try {
      await this.humanDelay(1_500, 3_500);
      await this.humanScroll(page, { direction: 'down', count: 2 + Math.floor(Math.random() * 3) });
      await this.humanDelay(900, 2_200);
      if (Math.random() > 0.3) {
        await this.likeRandomPostsInFeed(page, 1 + Math.floor(Math.random() * 2));
      }
      await this.humanMouseDrift(page);
      await this.humanDelay(800, 1_800);
      // 35% chance: wander to home feed for a final glance
      if (Math.random() > 0.65) {
        await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
        await this.dismissCookieBanner(page);
        await this.humanDelay(1_200, 2_800);
        await this.humanScroll(page, { direction: 'down', count: 1 + Math.floor(Math.random() * 2) });
        await this.humanDelay(600, 1_400);
      }
      this.logger.debug('Post-publish browsing complete');
    } catch { /* always non-fatal */ }
  }

  /**
   * Load the persisted fingerprint for this account, or create and save one on
   * first run. A real user always has the same hardware — picking a random
   * fingerprint every session means the "computer" changes on every run, which
   * is a strong bot signal on a persistent profile. We store the chosen profile
   * in `.account-fingerprint.json` inside the user-data directory so it
   * survives across container restarts.
   */
  private async getOrCreateFingerprint(
    userDataDir: string,
  ): Promise<ReturnType<typeof this.pickHumanFingerprint>> {
    const fpPath = join(userDataDir, '.account-fingerprint.json');
    try {
      const raw = await readFile(fpPath, 'utf8');
      const stored = JSON.parse(raw) as ReturnType<typeof this.pickHumanFingerprint>;
      if (stored?.userAgent && stored?.viewport?.width) {
        this.logger.debug(
          `Loaded persisted fingerprint: ${stored.userAgent.slice(0, 60)}…`,
        );
        return stored;
      }
    } catch { /* first run or corrupt file */ }

    const fp = this.pickHumanFingerprint();
    await writeFile(fpPath, JSON.stringify(fp, null, 2)).catch(() => undefined);
    this.logger.log(
      `Created new persisted fingerprint: ${fp.userAgent.slice(0, 60)}…`,
    );
    return fp;
  }

  /**
   * Pick a coherent hardware + software fingerprint bundle. Every property
   * within a bundle is internally consistent (UA matches GPU, RAM matches CPU
   * tier, device-pixel-ratio matches platform) so cross-property fingerprint
   * checks can't flag inconsistencies.
   */
  private pickHumanFingerprint(): {
    viewport: { width: number; height: number };
    userAgent: string;
    locale: string;
    timezoneId: string;
    hardwareConcurrency: number;
    deviceMemory: number;
    devicePixelRatio: number;
    webglVendor: string;
    webglRenderer: string;
    audioNoise: number;
    canvasNoise: number;
  } {
    const profiles = [
      // Windows 10 — mid-range Intel desktop
      {
        viewport: { width: 1920, height: 1080 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        locale: 'en-US', timezoneId: 'America/New_York',
        hardwareConcurrency: 8, deviceMemory: 8, devicePixelRatio: 1,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // Windows 10 — high-end NVIDIA gaming rig
      {
        viewport: { width: 2560, height: 1440 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        locale: 'en-US', timezoneId: 'America/Chicago',
        hardwareConcurrency: 16, deviceMemory: 16, devicePixelRatio: 1,
        webglVendor: 'Google Inc. (NVIDIA)',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // MacBook Pro M1 — Retina display
      {
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        locale: 'en-US', timezoneId: 'America/Los_Angeles',
        hardwareConcurrency: 10, deviceMemory: 16, devicePixelRatio: 2,
        webglVendor: 'Google Inc. (Apple)',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      },
      // Windows 10 — budget Intel laptop
      {
        viewport: { width: 1366, height: 768 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        locale: 'en-US', timezoneId: 'America/Denver',
        hardwareConcurrency: 4, deviceMemory: 4, devicePixelRatio: 1,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // Windows 10 — AMD Radeon mid-range
      {
        viewport: { width: 1600, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        locale: 'en-US', timezoneId: 'America/New_York',
        hardwareConcurrency: 12, deviceMemory: 16, devicePixelRatio: 1,
        webglVendor: 'Google Inc. (AMD)',
        webglRenderer: 'ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // MacBook Air M2 — Retina, West Coast
      {
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        locale: 'en-CA', timezoneId: 'America/Los_Angeles',
        hardwareConcurrency: 8, deviceMemory: 8, devicePixelRatio: 2,
        webglVendor: 'Google Inc. (Apple)',
        webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)',
      },
      // Windows 11 — 13th-gen Intel, HiDPI
      {
        viewport: { width: 1536, height: 864 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        locale: 'en-US', timezoneId: 'America/Chicago',
        hardwareConcurrency: 6, deviceMemory: 8, devicePixelRatio: 1.25,
        webglVendor: 'Google Inc. (Intel)',
        webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
      // Windows 10 — GTX 1660, wide monitor
      {
        viewport: { width: 1680, height: 1050 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        locale: 'en-GB', timezoneId: 'America/New_York',
        hardwareConcurrency: 8, deviceMemory: 8, devicePixelRatio: 1,
        webglVendor: 'Google Inc. (NVIDIA)',
        webglRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      },
    ];
    const base = profiles[Math.floor(Math.random() * profiles.length)];
    return {
      ...base,
      // Session-stable noise seeds: integers 1-255, unique per launch.
      audioNoise:  1 + Math.floor(Math.random() * 254),
      canvasNoise: 1 + Math.floor(Math.random() * 254),
    };
  }

  // ============ BROWSER SESSION ============

  /**
   * Chrome uses a `SingletonLock` symlink (format: `{hostname}-{pid}`) to
   * prevent two instances from sharing the same profile. When a previous
   * automation session crashes or is killed mid-run the lock is never removed,
   * so the next launch sees "Opening in existing browser session." and exits
   * immediately (exitCode=0) — Playwright then throws "Target page…closed".
   *
   * This method reads the lock, kills the owning PID if it is still alive, and
   * removes all Singleton* files so the fresh launch can take ownership.
   */
  private async releaseStaleChromeProfileLock(userDataDir: string): Promise<void> {
    const lockPath = join(userDataDir, 'SingletonLock');
    try {
      const target = await readlink(lockPath); // e.g. "myhostname-12345"
      const pidMatch = target.match(/-(\d+)$/);
      if (pidMatch) {
        const stalePid = parseInt(pidMatch[1], 10);
        try {
          process.kill(stalePid, 'SIGTERM');
          this.logger.debug(
            `Sent SIGTERM to stale Chrome process pid=${stalePid} holding profile lock`,
          );
          await this.delay(600); // give it time to exit cleanly
          // Force-kill if still alive
          try { process.kill(stalePid, 'SIGKILL'); } catch { /* already gone */ }
        } catch { /* process no longer exists — lock is a leftover */ }
      }
    } catch { /* lock file doesn't exist — nothing to do */ }

    // Remove every Chrome singleton file regardless
    for (const file of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await unlink(join(userDataDir, file)).catch(() => undefined);
    }
  }

  /** Empty or missing file → Playwright’s bundled Chromium (required in Docker). */
  private resolveStocktwitsBrowserBinary(): string {
    const configured =
      this.configService.get<string>('STOCKTWITS_BROWSER_BINARY')?.trim() || '';
    if (!configured) {
      return '';
    }
    if (!existsSync(configured)) {
      this.logger.warn(
        `STOCKTWITS_BROWSER_BINARY points to "${configured}" which does not exist on this machine; using Playwright bundled Chromium.`,
      );
      return '';
    }
    return configured;
  }

  private async createBrowserSession(
    accountHandle?: string,
    runtimeProxy?: string,
    opts?: { isolateProfile?: boolean },
  ): Promise<{
    context: BrowserContext;
    page: Page;
    userDataDir: string;
    isTemp: boolean;
  }> {
    const rawHeadless = this.configService.get('STOCKTWITS_HEADLESS');
    // Explicit true/false wins. When unset, auto-detect: headless on Linux
    // without a display (Docker / headless server) so the process never tries
    // to open a Chrome window that can't render and immediately crashes.
    const isHeadless =
      rawHeadless === true || rawHeadless === 'true'
        ? true
        : rawHeadless === false || rawHeadless === 'false'
          ? false
          : process.platform === 'linux' && !process.env.DISPLAY?.trim();

    // Always use a persistent per-account profile even when a runtime proxy is
    // provided. The proxy is applied at the browser-context level, so all
    // requests (including the initial TLS handshake) flow through it regardless.
    // Creating a throw-away profile every run was the #1 cause of account blocks:
    // Stocktwits / Cloudflare flags cold-login events from fresh fingerprints as
    // bots, especially when the IP suddenly changes to a residential proxy range.
    // A persistent profile keeps session cookies alive across runs, meaning
    // Stocktwits sees a returning, warm user — not a new cold session every time.
    const isolate = opts?.isolateProfile ?? false;

    const baseUserDataDir =
      this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() ||
      join(process.cwd(), '.pw-stocktwits');
    const safeHandle = accountHandle
      ? accountHandle.replace(/[^a-zA-Z0-9_-]/g, '_')
      : '_default';
    const userDataDir = isolate
      ? join(tmpdir(), `stocktwits-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
      : join(baseUserDataDir, safeHandle);

    const browserBinary = this.resolveStocktwitsBrowserBinary();
    await mkdir(userDataDir, { recursive: true });
    await this.releaseStaleChromeProfileLock(userDataDir);

    const fingerprint = await this.getOrCreateFingerprint(userDataDir);
    const { viewport, userAgent } = fingerprint;

    // Override timezone + locale to match the proxy's residential IP location.
    // A mismatch between JS timezone and IP geolocation is one of the strongest
    // bot signals Cloudflare and Stocktwits both score. If no geo override is
    // configured, fall back to the randomly selected US-profile values which
    // are correct when using US residential proxies.
    const geoTimezone =
      this.configService.get<string>('STOCKTWITS_PROXY_GEO_TIMEZONE')?.trim() ||
      fingerprint.timezoneId;
    const geoLocale =
      this.configService.get<string>('STOCKTWITS_PROXY_GEO_LOCALE')?.trim() ||
      fingerprint.locale;

    const proxy = this.pickProxyForAccount(accountHandle, runtimeProxy);
    const acceptInsecureCerts =
      this.configService.get<boolean>('STOCKTWITS_PROXY_ACCEPT_INSECURE_CERTS') === true;

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: isHeadless,
      executablePath: browserBinary || undefined,
      viewport,
      locale: geoLocale,
      timezoneId: geoTimezone,
      deviceScaleFactor: fingerprint.devicePixelRatio,
      proxy: proxy || undefined,
      ignoreHTTPSErrors: acceptInsecureCerts,
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--disable-sync',
        '--export-tagged-pdf',
        '--generate-pdf-document-outline',
        '--metrics-recording-only',
        '--no-service-autorun',
        '--password-store=basic',
        '--safebrowsing-disable-auto-update',
        '--use-mock-keychain',
      ],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--profile-directory=Default',
        '--no-default-browser-check',
        // Patches navigator.webdriver at the Blink engine level — the most
        // reliable single flag for removing the "controlled by automation" signal.
        // Note: playwright-extra/stealth may already inject this; having it once
        // via args is harmless and guarantees it even without the plugin.
        '--disable-blink-features=AutomationControlled',
        // Match the Accept-Language header to the JS navigator.languages value.
        '--lang=en-US,en',
        '--disable-features=ChromeWhatsNewUI,PasswordLeakDetection,AutoDeElevate',
        ...(isHeadless ? [] : ['--start-maximized']),
      ],
      userAgent,
    });

    // ── Deep stealth init script ──────────────────────────────────────────────
    // Runs before ANY page script. Fingerprint values are passed as a plain
    // object so hardware/GPU properties are coherent with the chosen UA/platform
    // profile rather than being static or obviously headless.
    await context.addInitScript(
      (fp: {
        hardwareConcurrency: number;
        deviceMemory: number;
        devicePixelRatio: number;
        webglVendor: string;
        webglRenderer: string;
        viewportWidth: number;
        viewportHeight: number;
        audioNoise: number;
        canvasNoise: number;
        userAgent: string;
      }) => {
        // 1. navigator.webdriver — primary automation signal
        try {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
        } catch { /* already locked */ }

        // 2. window.chrome — absent in headless Chromium builds
        try {
          if (!(window as any).chrome) {
            (window as any).chrome = {
              app: { isInstalled: false },
              csi: () => ({}),
              loadTimes: () => ({}),
              runtime: {},
            };
          }
        } catch { /* ignore */ }

        // 3. navigator.languages — headless often only exposes one entry
        try {
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
            configurable: true,
          });
        } catch { /* ignore */ }

        // 4. navigator.permissions.query — headless returns 'denied' for notifications
        try {
          const orig = navigator.permissions?.query?.bind(navigator.permissions);
          if (orig) {
            navigator.permissions.query = (desc: PermissionDescriptor) =>
              desc.name === 'notifications'
                ? Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
                : orig(desc);
          }
        } catch { /* ignore */ }

        // 5. Remove Playwright global markers
        try {
          for (const k of ['__playwright', '__pw_manual', '__PW_inspect']) {
            delete (window as any)[k];
          }
        } catch { /* ignore */ }

        // 6. Hardware concurrency — headless default is 0 or 1
        try {
          Object.defineProperty(navigator, 'hardwareConcurrency', {
            get: () => fp.hardwareConcurrency,
            configurable: true,
          });
        } catch { /* ignore */ }

        // 7. Device memory — headless exposes undefined
        try {
          Object.defineProperty(navigator, 'deviceMemory', {
            get: () => fp.deviceMemory,
            configurable: true,
          });
        } catch { /* ignore */ }

        // 8. WebGL vendor + renderer — the highest-entropy GPU fingerprint
        try {
          const patchWebGL = (Ctor: typeof WebGLRenderingContext) => {
            const origGet = Ctor.prototype.getParameter;
            Ctor.prototype.getParameter = function (parameter: number) {
              if (parameter === 37445) return fp.webglVendor;   // UNMASKED_VENDOR_WEBGL
              if (parameter === 37446) return fp.webglRenderer; // UNMASKED_RENDERER_WEBGL
              return origGet.call(this, parameter);
            };
            const origExt = Ctor.prototype.getExtension;
            (Ctor.prototype as any).getExtension = function (name: string) {
              const ext = (origExt as any).call(this, name);
              if (name === 'WEBGL_debug_renderer_info') {
                return ext ?? { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
              }
              return ext;
            };
          };
          if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext);
          if (typeof WebGL2RenderingContext !== 'undefined') {
            patchWebGL(WebGL2RenderingContext as unknown as typeof WebGLRenderingContext);
          }
        } catch { /* ignore */ }

        // 9. Screen dimensions must match viewport or mismatches get flagged
        try {
          Object.defineProperty(screen, 'width',       { get: () => fp.viewportWidth,       configurable: true });
          Object.defineProperty(screen, 'height',      { get: () => fp.viewportHeight,      configurable: true });
          Object.defineProperty(screen, 'availWidth',  { get: () => fp.viewportWidth,       configurable: true });
          Object.defineProperty(screen, 'availHeight', { get: () => fp.viewportHeight - 40, configurable: true });
        } catch { /* ignore */ }

        // 10. devicePixelRatio — must match context-level deviceScaleFactor
        try {
          Object.defineProperty(window, 'devicePixelRatio', {
            get: () => fp.devicePixelRatio,
            configurable: true,
          });
        } catch { /* ignore */ }

        // 11. Plugins — empty list in headless; real Chrome always has PDF viewer
        try {
          if ((navigator.plugins as any).length === 0) {
            const base = { length: 1, item: () => null, namedItem: () => null };
            const list = [
              { ...base, name: 'PDF Viewer',      filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { ...base, name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
              { ...base, name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            ];
            Object.defineProperty(navigator, 'plugins', {
              get: () => Object.assign(list, {
                item: (i: number) => list[i] ?? null,
                namedItem: (n: string) => list.find((p) => p.name === n) ?? null,
                refresh: () => {},
                [Symbol.iterator]: list[Symbol.iterator].bind(list),
              }),
              configurable: true,
            });
          }
        } catch { /* ignore */ }

        // 12. navigator.connection — headless has undefined; real Chrome exposes
        //     NetworkInformation with typical broadband values.
        try {
          if (!(navigator as any).connection) {
            const conn = {
              effectiveType: '4g',
              downlink: 10 + Math.floor(Math.random() * 15),
              rtt: 40 + Math.floor(Math.random() * 60),
              saveData: false,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              dispatchEvent: () => true,
            };
            Object.defineProperty(navigator, 'connection', { get: () => conn, configurable: true });
            Object.defineProperty(navigator, 'mozConnection', { get: () => conn, configurable: true });
            Object.defineProperty(navigator, 'webkitConnection', { get: () => conn, configurable: true });
          }
        } catch { /* ignore */ }

        // 13. window.outerWidth / outerHeight — headless returns values equal to
        //     viewport (no browser chrome). Real Chrome adds ~80-120 px for the
        //     toolbar. Inconsistency between inner and outer is a bot signal.
        try {
          const toolbarH = 80 + Math.floor(Math.random() * 40);
          Object.defineProperty(window, 'outerWidth',  { get: () => fp.viewportWidth,              configurable: true });
          Object.defineProperty(window, 'outerHeight', { get: () => fp.viewportHeight + toolbarH,  configurable: true });
        } catch { /* ignore */ }

        // 14. AudioContext fingerprint noise — headless and headed Chrome produce
        //     different float arrays from the oscillator/analyser. A tiny,
        //     session-stable noise offset makes the fingerprint indistinguishable
        //     from a real desktop browser.
        try {
          const audioNoise = fp.audioNoise;
          const OrigAudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
          if (OrigAudioContext) {
            const OrigAnalyser = OrigAudioContext.prototype.createAnalyser;
            OrigAudioContext.prototype.createAnalyser = function (...args: any[]) {
              const node = OrigAnalyser.apply(this, args);
              const origGetFloat = node.getFloatFrequencyData.bind(node);
              const origGetByte  = node.getByteFrequencyData.bind(node);
              node.getFloatFrequencyData = (arr: Float32Array) => {
                origGetFloat(arr);
                for (let i = 0; i < arr.length; i++) arr[i] += audioNoise * 0.0001;
              };
              node.getByteFrequencyData = (arr: Uint8Array) => {
                origGetByte(arr);
                const delta = Math.round(audioNoise % 2);
                for (let i = 0; i < arr.length; i++) arr[i] = Math.min(255, arr[i] + delta);
              };
              return node;
            };
          }
        } catch { /* ignore */ }

        // 15. Canvas 2D fingerprint noise — inject a ±1 noise on getImageData
        //     so every session produces a unique but human-plausible canvas hash.
        try {
          const canvasNoise = fp.canvasNoise;
          const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
          CanvasRenderingContext2D.prototype.getImageData = function (...args: Parameters<typeof origGetImageData>) {
            const imageData = origGetImageData.apply(this, args);
            for (let i = 0; i < imageData.data.length; i += 51) {
              imageData.data[i] = Math.min(255, Math.max(0, imageData.data[i] + (canvasNoise % 3) - 1));
            }
            return imageData;
          };
        } catch { /* ignore */ }

        // 16. User-Agent Client Hints (navigator.userAgentData) — Chrome 89+
        //     exposes brands, mobile flag, and platform. Headless Chromium either
        //     omits this entirely or returns an empty brands list, which is a
        //     high-confidence bot signal on any site that calls getHighEntropyValues().
        try {
          const uaFull = fp.userAgent;
          const chromeVerMatch = uaFull.match(/Chrome\/([\d]+)/);
          const chromeVer = chromeVerMatch ? chromeVerMatch[1] : '136';
          const majorVer = chromeVer.split('.')[0];
          const isWin = uaFull.includes('Windows');
          const isMac = uaFull.includes('Macintosh');

          const brands = [
            { brand: 'Chromium',        version: majorVer },
            { brand: 'Google Chrome',   version: majorVer },
            { brand: 'Not_A Brand',     version: '24' },
          ];

          const uaData = {
            brands,
            mobile: false,
            platform: isWin ? 'Windows' : isMac ? 'macOS' : 'Linux',
            getHighEntropyValues: (hints: string[]) => {
              const result: Record<string, string | boolean | {brand: string; version: string}[]> = {};
              for (const hint of hints) {
                if (hint === 'architecture')    result[hint] = 'x86';
                if (hint === 'bitness')         result[hint] = '64';
                if (hint === 'brands')          result[hint] = brands;
                if (hint === 'fullVersionList') result[hint] = brands.map(b => ({ ...b, version: chromeVer }));
                if (hint === 'mobile')          result[hint] = false;
                if (hint === 'model')           result[hint] = '';
                if (hint === 'platform')        result[hint] = isWin ? 'Windows' : isMac ? 'macOS' : 'Linux';
                if (hint === 'platformVersion') result[hint] = isWin ? '10.0.0' : isMac ? '13.0.0' : '5.15.0';
                if (hint === 'uaFullVersion')   result[hint] = chromeVer;
              }
              return Promise.resolve(result);
            },
            toJSON: () => ({ brands, mobile: false }),
          };

          Object.defineProperty(navigator, 'userAgentData', {
            get: () => uaData,
            configurable: true,
          });
        } catch { /* ignore */ }

        // 17. navigator.mediaDevices.enumerateDevices() — returns empty array in
        //     headless; real Chrome returns a list of (label-redacted) devices.
        //     Sites check for the *presence* of devices, not their labels.
        try {
          if (navigator.mediaDevices) {
            const orig = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
            navigator.mediaDevices.enumerateDevices = async () => {
              const real = await orig().catch(() => []);
              if (real.length > 0) return real;
              // Return two stub devices so the list is non-empty
              return [
                { deviceId: 'default', kind: 'audioinput',  label: '', groupId: 'default' } as MediaDeviceInfo,
                { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'default' } as MediaDeviceInfo,
              ];
            };
          }
        } catch { /* ignore */ }

        // 18. document.hasFocus() — headless windows return false because there is
        //     no real OS focus event. Scripts that gate interactions on focus (e.g.
        //     form composing) may behave differently; returning true is safe.
        try {
          const origHasFocus = document.hasFocus.bind(document);
          document.hasFocus = () => {
            try { return origHasFocus() || true; } catch { return true; }
          };
        } catch { /* ignore */ }

        // 19. navigator.maxTouchPoints — must be 0 for a desktop session.
        //     Some headless builds expose 1 or 5 (touch device), which triggers
        //     mobile-bot heuristics even on a "desktop" UA string.
        try {
          Object.defineProperty(navigator, 'maxTouchPoints', {
            get: () => 0,
            configurable: true,
          });
        } catch { /* ignore */ }
      },
      {
        hardwareConcurrency: fingerprint.hardwareConcurrency,
        deviceMemory:        fingerprint.deviceMemory,
        devicePixelRatio:    fingerprint.devicePixelRatio,
        webglVendor:         fingerprint.webglVendor,
        webglRenderer:       fingerprint.webglRenderer,
        viewportWidth:       fingerprint.viewport.width,
        viewportHeight:      fingerprint.viewport.height,
        audioNoise:          fingerprint.audioNoise,
        canvasNoise:         fingerprint.canvasNoise,
        userAgent:           fingerprint.userAgent,
      },
    );

    const navTimeoutMs =
      this.configService.get<number>('STOCKTWITS_NAV_TIMEOUT_MS') ?? 45_000;
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultNavigationTimeout(navTimeoutMs);

    // ── OAuth token capture ────────────────────────────────────────────────────
    // Once the SPA is logged in it makes requests to api.stocktwits.com that
    // carry the user's OAuth access_token. We sniff every outgoing request on
    // the context level and persist the first valid token we see. Subsequent
    // runs load the saved token and post via the official REST API directly —
    // no browser session required, full sentiment support, zero muting risk.
    if (!isolate) {
      context.on('request', (request) => {
        const url = request.url();
        if (!url.includes('api.stocktwits.com/api/2/')) return;
        let token: string | null = null;
        try {
          token = new URL(url).searchParams.get('access_token');
        } catch { /* malformed URL */ }
        if (!token) {
          const auth = request.headers()['authorization'] ?? '';
          if (auth.startsWith('Bearer ')) token = auth.slice(7);
        }
        if (token && token.length > 10) {
          // Fire-and-forget — don't block the request pipeline
          this.saveStocktwitsTokenSafe(userDataDir, token);
        }
      });
    }

    return { context, page, userDataDir, isTemp: isolate };
  }

  private saveStocktwitsTokenSafe(userDataDir: string, token: string): void {
    const path = require('path').join(userDataDir, '.stocktwits-token');
    const data = JSON.stringify({ token, savedAt: Date.now() });
    require('fs/promises').writeFile(path, data, 'utf8').catch(() => undefined);
    this.logger.log(`Captured Stocktwits OAuth token (${token.slice(0, 8)}…) — direct API enabled for future runs`);
  }

  /**
   * Opens a separate Chrome window through the same Stocktwits proxy settings
   * as publishing, navigates to an IP/location check page, and leaves the
   * window open for manual verification. Does not reuse account profiles.
   *
   * On Linux without $DISPLAY (Docker, headless servers), runs **headless**:
   * confirms IP via ipify, then opens whoer (or STOCKTWITS_PROXY_TEST_VISUAL_URL),
   * returns a **screenshot** in JSON for the manual UI (no real monitor window
   * inside Docker). With a desktop `$DISPLAY`, opens a real Chrome window on whoer.
   */
  async openProxyVerificationWindow(
    manualProxyOverride?: string,
  ): Promise<{
    ok: boolean;
    message: string;
    testUrl: string;
    proxyServer?: string;
    headless?: boolean;
    detectedPublicIp?: string;
    visualCheckUrl?: string;
    screenshotMimeType?: string;
    screenshotBase64?: string;
    /** When Chromium fails auth but Node axios succeeds */
    verification?: 'playwright' | 'nodejs_axios_fallback';
    chromeError?: string;
    manualProxyOverrideUsed?: boolean;
    error?: string;
  }> {
    const headless = this.resolveHeadlessForProxyProbe();
    const testUrlInteractive =
      this.configService.get<string>('STOCKTWITS_PROXY_TEST_URL')?.trim() ||
      'https://whoer.net';
    const testUrlHeadless =
      this.configService.get<string>('STOCKTWITS_PROXY_TEST_URL_HEADLESS')?.trim() ||
      'https://api.ipify.org?format=json';
    const testUrl = headless ? testUrlHeadless : testUrlInteractive;

    const bypassFromEnv =
      this.configService.get<string>('STOCKTWITS_PROXY_BYPASS')?.trim() || undefined;
    const manual = manualProxyOverride?.trim();

    let proxy: {
      server: string;
      username?: string;
      password?: string;
      bypass?: string;
    } | null = null;

    if (manual) {
      const parsed = this.parseProxyConnectionString(manual);
      if (!parsed) {
        return {
          ok: false,
          message:
            'Invalid proxy in the manual field. Use: login:password@host:port (DataImpulse example: f076…__cr.us:secret@gw.dataimpulse.com:10001) or http://user:pass@host:port — no spaces.',
          testUrl: testUrlInteractive,
          error: 'invalid_manual_proxy_format',
          manualProxyOverrideUsed: true,
        };
      }
      proxy = bypassFromEnv ? { ...parsed, bypass: bypassFromEnv } : parsed;
    } else {
      proxy = this.pickProxyForAccount();
    }

    if (!proxy) {
      return {
        ok: false,
        message:
          'No proxy is configured. Paste user:pass@host:port in the manual proxy field, or set STOCKTWITS_PROXY / STOCKTWITS_PROXY_SERVER + username + password, or STOCKTWITS_PROXIES_JSON.',
        testUrl: testUrlInteractive,
        error: 'missing_proxy',
        manualProxyOverrideUsed: Boolean(manual),
      };
    }

    const manualProxyOverrideUsed = Boolean(manual);
    const browserBinary = this.resolveStocktwitsBrowserBinary();
    const userDataDir = join(
      tmpdir(),
      `stocktwits-proxy-probe-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    );
    await mkdir(userDataDir, { recursive: true });
    await this.releaseStaleChromeProfileLock(userDataDir);

    const { viewport, userAgent, locale, timezoneId } =
      this.pickHumanFingerprint();
    const navTimeoutMs =
      this.configService.get<number>('STOCKTWITS_NAV_TIMEOUT_MS') ?? 45_000;

    let context: BrowserContext | undefined;
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        executablePath: browserBinary || undefined,
        viewport,
        locale,
        timezoneId,
        proxy,
        ignoreHTTPSErrors:
          this.configService.get<boolean>('STOCKTWITS_PROXY_ACCEPT_INSECURE_CERTS') === true,
        ignoreDefaultArgs: [
          '--enable-automation',
          '--disable-background-networking',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-extensions',
          '--disable-hang-monitor',
          '--disable-popup-blocking',
          '--disable-prompt-on-repost',
          '--disable-sync',
          '--export-tagged-pdf',
          '--generate-pdf-document-outline',
          '--metrics-recording-only',
          '--no-service-autorun',
          '--password-store=basic',
          '--safebrowsing-disable-auto-update',
          '--use-mock-keychain',
        ],
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--profile-directory=Default',
          '--no-default-browser-check',
          '--disable-features=ChromeWhatsNewUI,PasswordLeakDetection',
          '--start-maximized',
        ],
        userAgent,
      });

      await context!.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
        } catch { /* ignore */ }
      });

      const page = context!.pages()[0] ?? (await context!.newPage());
      page.setDefaultNavigationTimeout(navTimeoutMs);
      await page.goto(testUrl, { waitUntil: 'domcontentloaded' });

      if (headless) {
        let detectedPublicIp: string | undefined;
        try {
          const text = (await page.textContent('body'))?.trim() ?? '';
          const parsed = JSON.parse(text) as { ip?: string };
          if (parsed.ip && typeof parsed.ip === 'string') {
            detectedPublicIp = parsed.ip;
          }
        } catch {
          const text = (await page.textContent('body'))?.trim() ?? '';
          const m = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
          if (m) {
            detectedPublicIp = m[1];
          }
        }

        const visualUrl =
          this.configService.get<string>('STOCKTWITS_PROXY_TEST_VISUAL_URL')?.trim() ||
          'https://whoer.net';
        const visualWaitMs =
          this.configService.get<number>('STOCKTWITS_PROXY_TEST_VISUAL_WAIT_MS') ??
          5_000;

        let screenshotBase64: string | undefined;
        let screenshotMimeType: string | undefined;
        try {
          await page.goto(visualUrl, {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(navTimeoutMs, 90_000),
          });
          if (visualWaitMs > 0) {
            await page.waitForTimeout(visualWaitMs).catch(() => undefined);
          }
          const jpeg = await page.screenshot({
            type: 'jpeg',
            quality: 78,
            fullPage: false,
          });
          const maxBytes = 900_000;
          if (jpeg.length <= maxBytes) {
            screenshotBase64 = Buffer.from(jpeg).toString('base64');
            screenshotMimeType = 'image/jpeg';
          } else {
            this.logger.warn(
              `Whoer screenshot omitted (${jpeg.length} bytes > ${maxBytes}); increase compression or lower resolution manually if needed.`,
            );
          }
        } catch (visualErr) {
          this.logger.warn(
            `Whoer/visual page failed (proxy may still work): ${visualErr instanceof Error ? visualErr.message : String(visualErr)}`,
          );
        }

        try {
          await context!.close();
        } catch {
          /* ignore */
        }

        this.logger.log(
          `Proxy verification (headless) OK proxy=${proxy.server} testUrl=${testUrl} ip=${detectedPublicIp ?? 'unknown'} visual=${visualUrl}`,
        );

        const hasShot = Boolean(screenshotBase64);
        return {
          ok: true,
          message: detectedPublicIp
            ? hasShot
              ? `Proxy works. Your IP through the proxy is ${detectedPublicIp}. A picture of ${visualUrl} is shown below (like opening that site in Chrome — here the server has no screen, so we send a screenshot instead).`
              : `Proxy works. Your IP through the proxy is ${detectedPublicIp}. (${visualUrl} could not be captured as an image; try again or open that URL on your own PC in a browser using the same proxy.)`
            : hasShot
              ? 'Browser used the proxy and loaded the check sites; see the image below. IP was not read from ipify JSON.'
              : 'Browser reached the test URL through the proxy in headless mode, but the response body was not recognized as JSON with an "ip" field.',
          testUrl,
          proxyServer: proxy.server,
          headless: true,
          detectedPublicIp,
          visualCheckUrl: visualUrl,
          screenshotMimeType,
          screenshotBase64,
          verification: 'playwright',
          manualProxyOverrideUsed,
        };
      }

      this.logger.log(
        `Proxy verification window opened (proxy server=${proxy.server}, testUrl=${testUrl}). Close the window when done.`,
      );

      return {
        ok: true,
        message:
          'Chrome opened using your configured proxy. The whoer.net tab (or your STOCKTWITS_PROXY_TEST_URL) shows IP and location — close the window when finished.',
        testUrl,
        proxyServer: proxy.server,
        headless: false,
        visualCheckUrl: testUrl,
        verification: 'playwright',
        manualProxyOverrideUsed,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Proxy verification launch failed: ${msg}`);
      try {
        await context?.close();
      } catch {
        /* ignore */
      }

      if (
        /ERR_PROXY_AUTH_UNSUPPORTED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/i.test(
          msg,
        )
      ) {
        const axiosIp = await this.fetchIpifyThroughHttpProxyWithAxios(proxy);
        if (axiosIp) {
          return {
            ok: true,
            message:
              `Your proxy login works (outbound IP ${axiosIp} via a server-side check). Chromium/Playwright still reported a proxy error (${msg.split('\n')[0]}). This often happens with some residential proxies in headless Chrome — posting may still work from your desktop with real Chrome, or try another proxy port from your provider.`,
            testUrl: testUrlHeadless,
            proxyServer: proxy.server,
            headless,
            detectedPublicIp: axiosIp,
            verification: 'nodejs_axios_fallback',
            chromeError: msg,
            manualProxyOverrideUsed,
          };
        }
      }

      return {
        ok: false,
        message: 'Could not open Chrome or load the test URL through the proxy.',
        testUrl,
        proxyServer: proxy.server,
        headless,
        manualProxyOverrideUsed,
        error: msg,
      };
    }
  }

  /**
   * Same proxy object as Playwright; uses Node+axios CONNECT (Basic auth) which
   * some Chromium builds reject with ERR_PROXY_AUTH_UNSUPPORTED.
   */
  private async fetchIpifyThroughHttpProxyWithAxios(proxy: {
    server: string;
    username?: string;
    password?: string;
  }): Promise<string | null> {
    try {
      const normalized = /^https?:\/\//i.test(proxy.server)
        ? proxy.server
        : `http://${proxy.server}`;
      const u = new URL(normalized);
      const portNum = u.port
        ? parseInt(u.port, 10)
        : u.protocol === 'https:'
          ? 443
          : 80;

      const res = await axios.get<{ ip?: string }>(
        'https://api.ipify.org/?format=json',
        {
          timeout: 25_000,
          proxy: {
            protocol: 'http',
            host: u.hostname,
            port: portNum,
            ...(proxy.username != null
              ? {
                  auth: {
                    username: proxy.username,
                    password: proxy.password ?? '',
                  },
                }
              : {}),
          },
          validateStatus: (s) => s === 200,
        },
      );
      const ip = res.data?.ip;
      return typeof ip === 'string' ? ip : null;
    } catch (e) {
      this.logger.warn(
        `Axios proxy check failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Headless in Docker / Linux CI (no X11); headed on desktop with a display. */
  private resolveHeadlessForProxyProbe(): boolean {
    const raw = this.configService.get('STOCKTWITS_PROXY_TEST_HEADLESS');
    if (raw === true || raw === 'true') {
      return true;
    }
    if (raw === false || raw === 'false') {
      return false;
    }
    if (process.platform === 'linux' && !process.env.DISPLAY?.trim()) {
      return true;
    }
    return false;
  }

  private recordProxySuccess(server: string): void {
    this.proxyHealthMap.delete(server);
  }

  private recordProxyFailure(server: string): void {
    const entry = this.proxyHealthMap.get(server) ?? { failures: 0, lastFailAt: 0 };
    this.proxyHealthMap.set(server, {
      failures: entry.failures + 1,
      lastFailAt: Date.now(),
    });
    if (entry.failures + 1 >= 3) {
      this.logger.warn(
        `Proxy ${server} has ${entry.failures + 1} consecutive failures — skipping for 15 min.`,
      );
    }
  }

  private isProxyHealthy(server: string): boolean {
    const entry = this.proxyHealthMap.get(server);
    if (!entry) return true;
    if (entry.failures < 3) return true;
    // Clear the quarantine after 15 minutes so the proxy gets a fresh chance.
    if (Date.now() - entry.lastFailAt >= 15 * 60_000) {
      this.proxyHealthMap.delete(server);
      return true;
    }
    return false;
  }

  /**
   * Build a deterministic sticky-session token for a given account and time
   * bucket. The token changes every STOCKTWITS_PROXY_SESSION_ROTATION_MINUTES
   * minutes so Stocktwits never sees the same session token across days, but
   * within one posting session (login → post) the token is constant —
   * guaranteeing the same residential IP is used from start to finish.
   */
  private buildStickySessionToken(accountHandle: string): string {
    const rotationMinutes =
      this.configService.get<number>('STOCKTWITS_PROXY_SESSION_ROTATION_MINUTES') ?? 60;
    const bucket = Math.floor(Date.now() / (rotationMinutes * 60_000));
    const raw = `${accountHandle}-${bucket}`;
    // Simple djb2 hash → 8 hex chars (enough to be unique, short enough for proxy providers)
    let hash = 5381;
    for (let i = 0; i < raw.length; i += 1) {
      hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  /**
   * Apply sticky-session suffix to the proxy username when configured.
   * Mutates and returns the proxy object.
   */
  private applyStickySuffix(
    proxy: { server: string; username?: string; password?: string; bypass?: string },
    accountHandle?: string,
  ): { server: string; username?: string; password?: string; bypass?: string } {
    const suffix = this.configService.get<string>('STOCKTWITS_PROXY_STICKY_SUFFIX')?.trim();
    if (!suffix || !proxy.username || !accountHandle) {
      return proxy;
    }
    // Don't double-inject — check if the suffix is already present
    if (proxy.username.includes(suffix)) {
      return proxy;
    }
    const token = this.buildStickySessionToken(accountHandle);
    return {
      ...proxy,
      username: `${proxy.username}${suffix}${token}`,
    };
  }

  private pickProxyForAccount(
    accountHandle?: string,
    runtimeProxy?: string,
  ): { server: string; username?: string; password?: string; bypass?: string } | null {
    const runtime = runtimeProxy?.trim();
    if (runtime) {
      const parsedRuntime = this.parseProxyConnectionString(runtime);
      if (!parsedRuntime) {
        throw new Error('stocktwits_invalid_manual_proxy_format');
      }
      const bypass = this.configService.get<string>('STOCKTWITS_PROXY_BYPASS')?.trim();
      const base = { ...parsedRuntime, bypass: bypass || undefined };
      return this.applyStickySuffix(base, accountHandle);
    }

    // Prefer the rotating pool if provided
    const poolRaw = this.configService.get<string>('STOCKTWITS_PROXIES_JSON')?.trim();
    if (poolRaw) {
      try {
        const parsed = JSON.parse(poolRaw) as Array<{
          server: string;
          username?: string;
          password?: string;
          bypass?: string;
        }>;
        const pool = (Array.isArray(parsed) ? parsed : []).filter(
          (p) => p && typeof p.server === 'string' && p.server.trim().length > 0,
        );

        if (pool.length > 0) {
          // Consistent hashing: sort the pool by server string first so the
          // account→proxy mapping is stable even when entries are added or
          // removed. Without sorting, removing any proxy shifts every account
          // to a different proxy, triggering IP-change events on Stocktwits.
          const sorted = [...pool].sort((a, b) => a.server.localeCompare(b.server));
          const key = (accountHandle || '_default').toLowerCase();
          let hash = 0;
          for (let i = 0; i < key.length; i += 1) {
            hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
          }

          // Walk the ring starting at the preferred slot and skip any proxy
          // that is currently quarantined due to repeated failures.
          let chosen = sorted[hash % sorted.length];
          for (let offset = 0; offset < sorted.length; offset += 1) {
            const candidate = sorted[(hash + offset) % sorted.length];
            if (this.isProxyHealthy(candidate.server.trim())) {
              chosen = candidate;
              break;
            }
          }

          if (!this.isProxyHealthy(chosen.server.trim())) {
            this.logger.warn(
              'All proxies in STOCKTWITS_PROXIES_JSON are quarantined — using the preferred slot anyway and hoping it recovered.',
            );
          }

          const poolProxy = {
            server: chosen.server.trim(),
            username: chosen.username?.trim() || undefined,
            password: chosen.password?.trim() || undefined,
            bypass: chosen.bypass?.trim() || undefined,
          };
          return this.applyStickySuffix(poolProxy, accountHandle);
        }
      } catch {
        // Invalid JSON — fall back to single-proxy env vars
      }
    }

    const inline = this.configService.get<string>('STOCKTWITS_PROXY')?.trim();
    if (inline) {
      const parsed = this.parseProxyConnectionString(inline);
      if (parsed) {
        // Single-proxy with multiple accounts means every account shares one IP.
        // Stocktwits will correlate them and may mute all accounts simultaneously.
        if (accountHandle && accountHandle !== '_default') {
          this.logger.warn(
            `STOCKTWITS_PROXY is a single-proxy and is being used for account "${accountHandle}". ` +
            'All accounts share one IP — use STOCKTWITS_PROXIES_JSON (pool) to assign distinct IPs per account.',
          );
        }
        const bypass = this.configService
          .get<string>('STOCKTWITS_PROXY_BYPASS')
          ?.trim();
        const inlineProxy = { ...parsed, bypass: bypass || undefined };
        return this.applyStickySuffix(inlineProxy, accountHandle);
      }
    }

    const server = this.configService.get<string>('STOCKTWITS_PROXY_SERVER')?.trim();
    if (!server) return null;
    if (accountHandle && accountHandle !== '_default') {
      this.logger.warn(
        `STOCKTWITS_PROXY_SERVER is a single-proxy and is being used for account "${accountHandle}". ` +
        'All accounts share one IP — use STOCKTWITS_PROXIES_JSON (pool) to assign distinct IPs per account.',
      );
    }
    const username = this.configService.get<string>('STOCKTWITS_PROXY_USERNAME')?.trim();
    const password = this.configService.get<string>('STOCKTWITS_PROXY_PASSWORD')?.trim();
    const bypass = this.configService.get<string>('STOCKTWITS_PROXY_BYPASS')?.trim();
    const envProxy = {
      server,
      username: username || undefined,
      password: password || undefined,
      bypass: bypass || undefined,
    };
    return this.applyStickySuffix(envProxy, accountHandle);
  }

  /**
   * Parses `user:pass@host:port` or `http://user:pass@host:port` (DataImpulse style).
   */
  private parseProxyConnectionString(
    raw: string,
  ): { server: string; username?: string; password?: string } | null {
    let s = raw.trim();
    const schemeMatch = s.match(/^https?:\/\//i);
    if (schemeMatch) {
      s = s.slice(schemeMatch[0].length);
    }
    const at = s.lastIndexOf('@');
    if (at > 0 && at < s.length - 1) {
      const creds = s.slice(0, at);
      const hostPort = s.slice(at + 1);
      const colonInCreds = creds.indexOf(':');
      if (colonInCreds <= 0 || colonInCreds === creds.length - 1) {
        return null;
      }
      const username = creds.slice(0, colonInCreds);
      const password = creds.slice(colonInCreds + 1) || undefined;

      const hostColon = hostPort.lastIndexOf(':');
      if (hostColon <= 0 || hostColon === hostPort.length - 1) {
        return null;
      }
      const host = hostPort.slice(0, hostColon);
      const port = hostPort.slice(hostColon + 1).split('/')[0]?.trim();
      if (!host || !/^\d+$/.test(port)) {
        return null;
      }

      return {
        server: `http://${host}:${port}`,
        username,
        password,
      };
    }

    const hostColon = s.lastIndexOf(':');
    if (hostColon <= 0 || hostColon === s.length - 1) {
      return null;
    }
    const host = s.slice(0, hostColon);
    const port = s.slice(hostColon + 1).split('/')[0]?.trim();
    if (!host || !/^\d+$/.test(port)) {
      return null;
    }

    return {
      server: `http://${host}:${port}`,
    };
  }

  // ============ LOGIN & AUTH ============

  private async performLoginIfNeeded(
    page: Page,
    account: StocktwitsAccountConfig,
    timeout: number,
    runtimeProxy?: string,
  ): Promise<void> {
    // ── Fast path: persistent session is still alive ───────────────────────────
    if (await this.isAuthenticated(page)) {
      const mismatched = await this.detectAccountMismatch(page, account);
      if (!mismatched) {
        this.logger.log('Persistent session active — skipping login form');
        return;
      }
      this.logger.warn(
        `Session belongs to "${mismatched}", expected "${account.handle ?? account.username}" — forcing re-login`,
      );
      await this.forceLogoutAndReload(page);
    }

    const loginUrl =
      this.configService.get<string>('STOCKTWITS_LOGIN_URL') ??
      'https://stocktwits.com/signin';

    // ── Navigate to /signin exactly ONCE — only if not already there ──────────
    // NEVER use 'networkidle' on Stocktwits: they keep persistent WebSocket
    // connections open, so networkidle NEVER fires and always hits the 30 s
    // timeout. The catch clause then fires ANOTHER goto, and the post-challenge
    // re-navigation guard fires a THIRD. That three-navigation chain is the
    // "reloading signup page" loop the user sees. Use domcontentloaded + an
    // explicit wait for the password input instead.
    const currentUrl = page.url();
    if (!/\/(signin|login)/i.test(currentUrl)) {
      this.logger.log(`Navigating to login page: ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(() => undefined);
      await this.dismissCookieBanner(page);
    } else {
      this.logger.log('Already on login page — skipping navigation');
    }

    // ── Handle any Cloudflare challenge before touching the form ──────────────
    await this.handlePossibleChallenge(page, timeout, runtimeProxy);

    // Challenge resolution may have redirected straight to the feed
    if (await this.isAuthenticated(page)) {
      this.logger.log('Authenticated after challenge resolution — login complete');
      return;
    }

    // ── Wait for React to mount the login form ────────────────────────────────
    // This replaces the networkidle wait: React renders the form inputs after
    // the JS bundle executes. We just wait for the password field to appear.
    this.logger.log('Waiting for login form to mount…');
    await page
      .waitForSelector('input[type="password"], input[autocomplete="current-password"]', {
        timeout: 15_000,
      })
      .catch(() => undefined);

    const loginField    = await this.findLoginField(page);
    const passwordField = await this.findPasswordField(page);

    if (!loginField || !passwordField) {
      if (await this.isAuthenticated(page)) return;
      const debugDir = join(process.cwd(), 'artifacts', 'stocktwits');
      await mkdir(debugDir, { recursive: true }).catch(() => undefined);
      const debugImg = join(debugDir, `login-form-missing-${Date.now()}.png`);
      await page.screenshot({ path: debugImg, fullPage: true }).catch(() => undefined);
      this.logger.error(`Login form not found — URL: ${page.url()} | screenshot: ${debugImg}`);
      throw new Error(`stocktwits_login_form_not_found | url:${page.url()}`);
    }

    // ── Type credentials character-by-character (React onChange per keystroke) ─
    this.logger.log('Typing credentials into login form…');
    await loginField.click();
    await loginField.pressSequentially(account.username, { delay: 60 });
    await this.humanDelay(400, 700);
    await passwordField.click();
    await passwordField.pressSequentially(account.password, { delay: 60 });
    await this.humanDelay(400, 600);

    const loginVal    = await loginField.inputValue().catch(() => '?');
    const passwordVal = await passwordField.inputValue().catch(() => '?');
    this.logger.log(`Fields before submit — login: "${loginVal}", password length: ${passwordVal.length}`);

    if (!loginVal || !passwordVal) {
      throw new Error('stocktwits_login_fields_empty_before_submit: credentials were lost before submit');
    }

    // Debug screenshot
    const debugDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(debugDir, { recursive: true }).catch(() => undefined);
    await page.screenshot({
      path: join(debugDir, `before-submit-${Date.now()}.png`),
      fullPage: false,
    }).catch(() => undefined);

    // ── Submit ─────────────────────────────────────────────────────────────────
    const submitSelectors = [
      'button[data-testid="log-in-submit"]',
      'button[type="submit"]',
      'button:has-text("Log In")',
    ];
    const submit = await this.findFirstVisible(page, submitSelectors);
    if (submit) {
      await this.humanHoverBeforeClick(page, submit);
      await submit.click();
    }

    // Wait for redirect away from /signin
    await page
      .waitForURL((url) => !/\/(signin|login)/i.test(url.pathname), { timeout: 15_000 })
      .catch(() => undefined);

    await this.humanDelay(1_200, 2_200);
    await this.handlePossibleChallenge(page, timeout, runtimeProxy);

    const result = await this.waitForAuthenticatedOrTimeout(page, timeout);
    if (result !== 'authenticated' && !(await this.isAuthenticated(page))) {
      const debugImg = join(debugDir, `login-failed-${Date.now()}.png`);
      await page.screenshot({ path: debugImg, fullPage: true }).catch(() => undefined);
      this.logger.error(`Login failed — URL: ${page.url()} | screenshot: ${debugImg}`);
      throw new Error('stocktwits_login_not_confirmed');
    }

    this.logger.log('Login confirmed successfully');
  }

  /**
   * Returns the *other* account's handle if the current session belongs to
   * someone other than the expected account. Returns null if the session
   * belongs to the expected account or if the handle can't be read (in which
   * case we trust isAuthenticated()'s yes/no answer).
   */
  private async detectAccountMismatch(
    page: Page,
    account: StocktwitsAccountConfig,
  ): Promise<string | null> {
    const expectedTokens = [account.handle, account.username]
      .filter((v): v is string => Boolean(v && v.trim()))
      .map((v) => v.replace(/^@/, '').toLowerCase());

    if (expectedTokens.length === 0) {
      return null;
    }

    const sessionHandle = await this.readLoggedInHandle(page);
    if (!sessionHandle) {
      return null;
    }

    const normalized = sessionHandle.replace(/^@/, '').toLowerCase();
    if (expectedTokens.includes(normalized)) {
      return null;
    }
    return sessionHandle;
  }

  /**
   * Reads the logged-in user's handle from the Stocktwits page chrome.
   * Returns null if it can't be determined.
   */
  private async readLoggedInHandle(page: Page): Promise<string | null> {
    return page
      .evaluate(() => {
        // Profile / settings links carry the handle in their href.
        const candidates = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href]'),
        );
        for (const anchor of candidates) {
          const href = anchor.getAttribute('href') || '';
          const profileMatch = href.match(/^\/([A-Za-z0-9_]{2,30})$/);
          if (!profileMatch) continue;
          const slug = profileMatch[1];
          // Skip non-profile slugs that share the same shape.
          const reserved = new Set([
            'home',
            'signin',
            'signup',
            'symbol',
            'sentiment',
            'trending',
            'news',
            'earnings',
            'about',
            'help',
            'privacy',
            'rules',
            'careers',
            'terms',
            'disclaimer',
            'shop',
            'disclosures',
            'enterprise',
            'subscriptions',
            'widgets',
            'advertise',
            'newsletters',
          ]);
          if (reserved.has(slug.toLowerCase())) continue;

          const text = (anchor.textContent || '').trim();
          // Prefer anchors that look like a profile link (small visible text
          // or a settings menu entry).
          if (text.length === 0 || text.length > 30) continue;
          return slug;
        }
        return null;
      })
      .catch(() => null);
  }

  private async forceLogoutAndReload(page: Page): Promise<void> {
    const context = page.context();
    try {
      await context.clearCookies();
    } catch {
      // ignore — clearing cookies isn't always permitted on persistent
      // contexts, but the next step will still log us in fresh.
    }
    try {
      await page.evaluate(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    // After clearing cookies, navigate to /signin directly — the caller
    // (performLoginIfNeeded) will check page.url() and skip re-navigation.
    const loginUrl = this.configService.get<string>('STOCKTWITS_LOGIN_URL') ?? 'https://stocktwits.com/signin';
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await this.dismissCookieBanner(page);
  }

  // ============ CHALLENGE HANDLING ============

  private async handlePossibleChallenge(
    page: Page,
    timeout: number,
    runtimeProxy?: string,
  ): Promise<void> {
    if (!(await this.isChallengeVisible(page))) {
      return;
    }

    this.logger.log(
      'Cloudflare challenge detected — waiting for auto-resolve…',
    );

    // ── Phase 1: Auto-resolve (managed JS challenge clears itself) ────────────
    // 60 s gives Cloudflare's JS PoW challenge enough time to complete in the
    // headed browser without needing CapSolver for most managed challenges.
    const autoResolved = await this.waitForChallengeAutoResolve(page, 60_000);
    if (autoResolved) {
      this.logger.log('Cloudflare challenge auto-resolved — no solver needed.');
      return;
    }

    // ── Phase 2: CapSolver ────────────────────────────────────────────────────
    const rawHeadless = this.configService.get('STOCKTWITS_HEADLESS');
    const isHeadless =
      rawHeadless === true || rawHeadless === 'true'
        ? true
        : rawHeadless === false || rawHeadless === 'false'
          ? false
          : process.platform === 'linux' && !process.env.DISPLAY?.trim();

    const capSolverKey = this.configService
      .get<string>('CAPSOLVER_API_KEY')
      ?.trim();

    if (capSolverKey) {
      const maxAttempts = 2;
      let capSolverWorked = false;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await this.solveChallengeWithCapSolver(page, runtimeProxy);
          await page.waitForTimeout(3_000).catch(() => undefined);
          if (!(await this.isChallengeVisible(page))) {
            capSolverWorked = true;
            break;
          }
          this.logger.warn(
            `CapSolver attempt ${attempt}/${maxAttempts}: token injected but challenge still visible`,
          );
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'unknown';
          this.logger.error(
            `CapSolver attempt ${attempt}/${maxAttempts} failed: ${msg}`,
          );
        }
        if (attempt < maxAttempts) {
          await page.waitForTimeout(2_000);
        }
      }
      if (capSolverWorked) return;
      this.logger.warn(
        'CapSolver could not resolve the challenge; falling back to manual flow.',
      );
    }

    // ── Phase 3: Manual fallback ──────────────────────────────────────────────
    if (isHeadless) {
      throw new Error(
        'Cloudflare challenge detected in headless mode. Set STOCKTWITS_HEADLESS=false to solve manually, or configure CAPSOLVER_API_KEY.',
      );
    }

    this.logger.warn(
      'Waiting for a human to solve the Cloudflare challenge in the browser window…',
    );
    const result = await this.waitForAuthenticatedOrTimeout(page, timeout);
    if (result === 'timed_out' && (await this.isChallengeVisible(page))) {
      throw new Error('Challenge not resolved within timeout.');
    }
  }

  /**
   * Poll until the "Just a moment…" challenge page disappears (page navigates
   * away or the title changes) or until the timeout expires.
   * Returns true if the challenge cleared by itself.
   * All page calls are wrapped so a closed context (user closed the window or
   * a prior error cleaned up the session) doesn't throw here.
   */
  private async waitForChallengeAutoResolve(
    page: Page,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1_500).catch(() => undefined);
      try {
        // Challenge clears when the title changes away from the interstitial
        const title = await page.title().catch(() => '');
        if (!/just a moment|attention required/i.test(title)) {
          if (!(await this.isChallengeVisible(page))) {
            return true;
          }
        }
        if (await this.isAuthenticated(page)) {
          return true;
        }
      } catch {
        // Page/context closed — treat as unresolved
        return false;
      }
    }
    return false;
  }

  private async waitForAuthenticatedOrTimeout(
    page: Page,
    timeout: number,
  ): Promise<'authenticated' | 'login_required' | 'timed_out'> {
    const started = Date.now();
    // Do not signal login_required for the first 5 s — the login form stays
    // mounted in the DOM while the page is mid-redirect after submit, and
    // bailing out during that window causes a false login-failure.
    const loginRequiredGraceMs = 5_000;
    while (Date.now() - started < timeout) {
      try {
        if (await this.isAuthenticated(page)) {
          return 'authenticated';
        }
        const elapsed = Date.now() - started;
        if (
          elapsed > loginRequiredGraceMs &&
          !(await this.isChallengeVisible(page)) &&
          (await this.hasLoginForm(page))
        ) {
          return 'login_required';
        }
        await page.waitForTimeout(1_000).catch(() => undefined);
      } catch {
        // Page/context was closed externally — bail out
        return 'timed_out';
      }
    }
    return 'timed_out';
  }

  private async isChallengeVisible(page: Page): Promise<boolean> {
    const challengeIframeSelectors = [
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]',
      'iframe[title*="challenge" i]',
      'iframe[title*="Cloudflare" i]',
    ];
    for (const selector of challengeIframeSelectors) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (visible) {
        return true;
      }
    }

    const widgetVisible = await page
      .locator('.cf-turnstile, #cf-challenge, #challenge-running')
      .first()
      .isVisible({ timeout: 250 })
      .catch(() => false);
    if (widgetVisible) {
      return true;
    }

    const interstitialTitle = await page.title().catch(() => '');
    if (/just a moment|attention required/i.test(interstitialTitle)) {
      return true;
    }

    const challengeCopy = page.getByText(
      /verify (you are|that you are) (a )?human|checking your browser/i,
    );
    return challengeCopy
      .first()
      .isVisible({ timeout: 250 })
      .catch(() => false);
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (await this.isChallengeVisible(page)) {
      return false;
    }

    const url = page.url();

    // Blank or still loading — not yet confirmed
    if (!url || url === 'about:blank') {
      return false;
    }

    // Explicitly on a sign-in / sign-up page → not authenticated
    if (/\/(signin|signup|login|register)/i.test(url)) {
      return false;
    }

    if (await this.hasLoginForm(page)) {
      return false;
    }

    // Visible "Log In" / "Sign Up" calls-to-action → definitely logged out
    const unauthenticatedMarker = await this.findFirstVisible(page, [
      'a[href*="/signin"]',
      'a:has-text("Log In")',
      'button:has-text("Log In")',
      'a:has-text("Sign Up")',
      'button:has-text("Sign Up")',
    ]);
    if (unauthenticatedMarker) {
      return false;
    }

    // Positive confirmation — look for any element that only appears in the
    // authenticated shell.  Stocktwits has changed their nav text to icons
    // in recent redesigns, so we cast a wide net across text, aria-labels,
    // data-testid attributes, and structural href patterns.
    const authenticatedMarker = await this.findFirstVisible(page, [
      // Legacy text-based nav links (older UI)
      'a:has-text("Notifications")',
      'a:has-text("Messages")',
      'a:has-text("Settings")',
      'button:has-text("Post")',
      // Icon-only nav — current Stocktwits redesign uses aria-labels
      '[aria-label*="Notification" i]',
      '[aria-label*="Message" i]',
      '[aria-label*="Write" i]',
      '[aria-label*="Compose" i]',
      '[aria-label*="Create post" i]',
      '[aria-label*="New post" i]',
      '[aria-label*="Home feed" i]',
      // data-testid selectors used in their React components
      '[data-testid*="compose"]',
      '[data-testid*="post-button"]',
      '[data-testid*="create"]',
      '[data-testid*="user-menu"]',
      '[data-testid*="profile"]',
      // Home/trending feed links — only rendered when authenticated
      'a[href="/home"]',
      'a[href="/trending"]',
      // Post-composer textarea in the feed
      'textarea[placeholder*="Share" i]',
      'textarea[placeholder*="What" i]',
      '[contenteditable][placeholder*="Share" i]',
      '[contenteditable][placeholder*="What" i]',
    ]);
    if (authenticatedMarker) {
      return true;
    }

    // Last-resort URL heuristic: if we are on stocktwits.com on any page that
    // isn't a public marketing/auth page AND no login markers were found, treat
    // it as authenticated.  This handles future UI redesigns that add new nav.
    const onFeedPage =
      url.includes('stocktwits.com') &&
      !/\/(signin|signup|login|register|about|terms|privacy|careers|contact|help|download|discover)/i.test(
        url,
      );
    return onFeedPage;
  }

  /**
   * Check whether Stocktwits has muted or suspended the logged-in account.
   * A muted account can still browse but cannot post — the platform shows a
   * banner or modal with text like "Your account has been muted".
   * We also look for post-composer disabled states that indicate restrictions.
   */
  private async checkAccountMutedStatus(page: Page): Promise<void> {
    const mutedSignals = [
      // Email/banner wording Stocktwits uses
      'your account has been muted',
      'account has been muted',
      'your ability to engage',
      'account has been suspended',
      'your account has been suspended',
      'account is suspended',
    ];

    const pageText = await page
      .evaluate(() => document.body.innerText.toLowerCase())
      .catch(() => '');

    for (const signal of mutedSignals) {
      if (pageText.includes(signal)) {
        throw new Error(
          `stocktwits_account_muted: Stocktwits has restricted this account. ` +
          `Log into Stocktwits manually, check any mute/suspension notices, ` +
          `and wait for the restriction to lift before retrying.`,
        );
      }
    }

    // Post composer being explicitly disabled is another strong signal
    const composerDisabled = await page
      .locator('[aria-label*="Post"][disabled], [placeholder*="Share your idea"][aria-disabled="true"]')
      .first()
      .isVisible({ timeout: 500 })
      .catch(() => false);
    if (composerDisabled) {
      throw new Error(
        'stocktwits_account_posting_restricted: Post composer is disabled — account may be muted or rate-limited.',
      );
    }
  }

  private async hasLoginForm(page: Page): Promise<boolean> {
    const loginField = await this.findLoginField(page);
    const passwordField = await this.findPasswordField(page);
    return Boolean(loginField && passwordField);
  }

  private async findLoginField(page: Page): Promise<Locator | null> {
    return this.findFirstVisible(page, [
      'input[name*="user[login]"]',
      'input[name*="login"]',
      'input[autocomplete="username"]',
      'input[placeholder*="Username"]',
      'input[placeholder*="username"]',
      'input[placeholder*="Email"]',
      'input[placeholder*="email"]',
      'input[type="email"]',
    ]);
  }

  private async findPasswordField(page: Page): Promise<Locator | null> {
    return this.findFirstVisible(page, [
      'input[name*="user[password]"]',
      'input[name*="password"]',
      'input[autocomplete="current-password"]',
      'input[type="password"]',
    ]);
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    const btns = [
      // Stocktwits uses OneTrust — the visible button is "Your Privacy Rights"
      // but the real dismiss is an Accept/Close inside that flow. Try common
      // text variants first, then fall back to clicking outside the banner.
      'button:has-text("Accept All Cookies")',
      'button:has-text("Accept All")',
      'button:has-text("Accept Cookies")',
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      'button:has-text("OK")',
      'button[id*="accept" i]',
      'button[class*="accept" i]',
      '[aria-label*="Close" i][role="button"]',
      '[aria-label*="Dismiss" i]',
    ];
    for (const selector of btns) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
      }
    }
  }

  // ============ TRENDING SYMBOLS ============

  private async ensureTrendingAllView(page: Page): Promise<void> {
    await this.clickFirstVisibleSelector(page, [
      '[role="tab"]:has-text("All")',
      'button:has-text("All")',
      'a:has-text("All")',
    ]);

    await page.waitForTimeout(600);

    await this.clickFirstVisibleSelector(page, [
      '[role="tab"]:has-text("Trending")',
      'button:has-text("Trending")',
      'a:has-text("Trending")',
    ]);

    await page.waitForTimeout(800);
  }

  private async clickFirstVisibleSelector(
    page: Page,
    selectors: string[],
  ): Promise<boolean> {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.click().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  private resolveTrendingUrls(postUrl: string): string[] {
    return [
      new URL('/sentiment', postUrl).toString(),
      new URL('/symbol-rankings/trending', postUrl).toString(),
    ];
  }

  private async openTrendingPage(page: Page, postUrl: string): Promise<void> {
    const clicked = await this.clickFirstVisibleSelector(page, [
      'a[href*="/sentiment"]',
      'a[href*="/symbol-rankings/trending"]',
      'a:has-text("Trending")',
      '[role="link"]:has-text("Trending")',
      'button:has-text("Trending")',
    ]);

    if (clicked) {
      try {
        await page.waitForURL(/\/(sentiment|symbol-rankings\/trending)/i, {
          timeout: 8_000,
        });
      } catch {
        // fall through to direct navigation fallback
      }
    }

    if (!/\/(sentiment|symbol-rankings\/trending)/i.test(page.url())) {
      const trendingUrls = this.resolveTrendingUrls(postUrl);
      let opened = false;

      for (const trendingUrl of trendingUrls) {
        await page.goto(trendingUrl, {
          waitUntil: 'domcontentloaded',
        });
        await this.dismissCookieBanner(page);

        if (/\/(sentiment|symbol-rankings\/trending)/i.test(page.url())) {
          opened = true;
          break;
        }
      }

      if (!opened) {
        throw new Error('stocktwits_trending_page_unreachable');
      }
    }

    await page.waitForTimeout(800);
  }

  private resolveSymbolUrl(postUrl: string, symbol: string): string {
    return new URL(`/symbol/${encodeURIComponent(symbol)}`, postUrl).toString();
  }

  private async waitForTopTrendingSymbols(
    page: Page,
    limit: number,
    timeoutMs: number,
  ): Promise<string[]> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const symbols = await this.extractTopTrendingSymbols(page, limit);
      if (symbols.length > 0) {
        return symbols;
      }
      await page.waitForTimeout(700);
    }
    return [];
  }

  private async extractTopTrendingSymbols(
    page: Page,
    limit: number,
  ): Promise<string[]> {
    const rankedCandidates = await page
      .evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('tr, [role="row"], [data-rank], li, div'),
        );
        const candidates: RankedSymbolCandidate[] = [];

        for (const row of rows) {
          const rowText = (row.textContent ?? '').replace(/\s+/g, ' ').trim();
          const rankMatch = rowText.match(/^(\d{1,3})\b/);
          const rank = rankMatch ? Number(rankMatch[1]) : Number.NaN;
          if (!Number.isFinite(rank) || rank < 1 || rank > 500 || rank > 20) {
            continue;
          }

          const symbolLink = row.querySelector('a[href*="/symbol/"]');

          let symbolText = '';
          if (symbolLink) {
            const href = symbolLink.getAttribute('href') ?? '';
            const hrefMatch = href.match(/\/symbol\/([A-Za-z0-9._-]{1,12})/i);
            symbolText = hrefMatch?.[1] ?? symbolLink.textContent ?? '';
          } else {
            const tokens = rowText.match(/\b[A-Z][A-Z0-9.-]{0,10}\b/g) ?? [];
            symbolText = tokens[0] ?? '';
          }

          candidates.push({
            rank,
            symbol: symbolText,
          });
        }

        return candidates;
      })
      .catch(() => [] as RankedSymbolCandidate[]);

    const symbolsFromDom = normalizeRankedSymbols(rankedCandidates, limit);
    if (symbolsFromDom.length > 0) {
      return symbolsFromDom;
    }

    const rankedFromLinks = await page
      .evaluate(() => {
        const links = Array.from(
          document.querySelectorAll('a[href*="/symbol/"]'),
        );
        const candidates: RankedSymbolCandidate[] = [];

        for (const link of links) {
          const href = link.getAttribute('href') ?? '';
          const hrefMatch = href.match(/\/symbol\/([A-Za-z0-9._-]{1,12})/i);
          if (!hrefMatch?.[1]) {
            continue;
          }

          let node: Element | null = link;
          let rank: number | null = null;
          for (let depth = 0; depth < 8 && node; depth += 1) {
            const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            const match = text.match(/^(\d{1,3})\b/);
            const parsed = match ? Number(match[1]) : Number.NaN;
            if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 20) {
              rank = parsed;
              break;
            }
            node = node.parentElement;
          }

          if (rank !== null) {
            candidates.push({
              rank,
              symbol: hrefMatch[1],
            });
          }
        }

        return candidates;
      })
      .catch(() => [] as RankedSymbolCandidate[]);

    const symbolsFromLinks = normalizeRankedSymbols(rankedFromLinks, limit);
    if (symbolsFromLinks.length > 0) {
      return symbolsFromLinks;
    }

    const html = await page.content();
    return parseTrendingSymbolsFromHtml(html, limit);
  }

  // ============ PUBLISHING ============

  private async postOnSymbolFeed(
    page: Page,
    postUrl: string,
    symbol: string,
    message: string,
  ): Promise<string | null> {
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (attempt > 1) {
        this.logger.warn(`postOnSymbolFeed: retry ${attempt}/${maxAttempts} for $${symbol}`);
        await this.humanDelay(4_000, 6_000);
      }

      await this.navigateToSymbolFeed(page, postUrl, symbol);
      const symbolMessage = this.prepareSymbolFeedMessage(symbol, message);
      const composerScope = await this.executeStrictSymbolComposerFlow(
        page,
        symbol,
        symbolMessage,
      );
      const beforeIds = await this.snapshotMessageIds(page);

      // Start intercepting the Stocktwits message-create API response BEFORE
      // clicking Post. The response body contains the new message ID directly,
      // which is far more reliable than DOM scanning (virtual scroll means the
      // new post may not be in the DOM at the time we check).
      const apiIdPromise = this.interceptPostApiResponse(page, this.publishConfirmTimeoutMs);

      await this.humanReviewBeforePost(page, composerScope);
      await this.submitInlineSymbolPost(page, composerScope, symbol);
      await this.handlePostConfirmationModal(page);
      await this.finalizeDialogPost(page);

      // Post-submit DOM check: detect rate-limit or restriction banners that
      // Stocktwits surfaces as toast/modal text after the Post button fires.
      // This runs before awaiting the API promise so we fail fast on hard errors.
      await this.checkPostSubmitRestrictions(page);

      // Wait for API response first (fastest path).
      // interceptPostApiResponse now rejects on rate-limit / restriction errors
      // so we let the rejection propagate naturally.
      const apiId = await apiIdPromise;
      if (apiId) {
        this.logger.log(`Post confirmed via API response: messageId=${apiId}`);
        return apiId;
      }

      // Fallback: DOM scan (handles cases where the API call used a different
      // URL pattern or the response format changed)
      try {
        const domId = await this.waitForPublishConfirmation(
          page,
          10_000,
          beforeIds,
          symbolMessage,
        );
        if (domId) return domId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        // Hard errors (rate-limit, restriction) must propagate immediately.
        if (/stocktwits_rate_limited|stocktwits_account_restricted/i.test(msg)) {
          throw err;
        }
        const isTransient =
          /please try again/i.test(msg) ||
          /there was a.*posting/i.test(msg) ||
          /something went wrong/i.test(msg);
        if (isTransient && attempt < maxAttempts) {
          this.logger.warn(`Stocktwits transient error on attempt ${attempt}: ${msg}`);
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  /**
   * Listen for the Stocktwits message-create API response.
   * Resolves with the new message ID on success.
   * Rejects with a typed error on rate-limit or account-restriction responses
   * so the caller can surface the correct error class instead of a generic
   * "not confirmed" timeout.
   * Must be called BEFORE clicking Post so the listener is registered first.
   */
  private interceptPostApiResponse(
    page: Page,
    timeoutMs: number,
  ): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        page.off('response', handler);
        resolve(null);
      }, timeoutMs);

      const handler = async (response: import('patchright').Response) => {
        try {
          const url = response.url();
          const method = response.request().method();
          if (method !== 'POST') return;
          if (
            !url.includes('stocktwits.com') ||
            (!url.includes('/messages') &&
              !url.includes('/message') &&
              !url.includes('/create'))
          ) return;

          this.logger.log(`Stocktwits POST response: ${response.status()} ${url}`);
          const body = await response.text().catch(() => '');
          this.logger.log(`API response body (first 300 chars): ${body.slice(0, 300)}`);

          // ── Success path: extract the new message ID ──────────────────────────
          const idMatch =
            body.match(/"id"\s*:\s*(\d+)/) ??
            body.match(/\/message\/(\d+)/) ??
            body.match(/\/messages\/(\d+)/);
          if (idMatch?.[1]) {
            clearTimeout(timer);
            page.off('response', handler);
            resolve(idMatch[1]);
            return;
          }

          // ── Error path: classify the API error so callers can back off ────────
          if (response.status() >= 400) {
            this.logger.error(
              `Stocktwits API error ${response.status()}: ${body.slice(0, 300)}`,
            );

            const bodyLower = body.toLowerCase();

            // Rate-limit signals — 422/429 with "too frequent" or "too fast" wording.
            if (
              response.status() === 429 ||
              /posting too (frequently|fast|often)|rate.?limit|too many (requests|posts)/i.test(body)
            ) {
              clearTimeout(timer);
              page.off('response', handler);
              reject(
                new Error(
                  `stocktwits_rate_limited: Stocktwits rejected the post with HTTP ${response.status()}. ` +
                  `Wait before posting again. Raw: ${body.slice(0, 200)}`,
                ),
              );
              return;
            }

            // Account restriction / mute signals.
            if (
              /account.*muted|muted.*account|account.*suspended|suspended.*account|account.*restricted|posting.*restricted|restricted.*posting/i.test(body) ||
              bodyLower.includes('your ability to engage') ||
              bodyLower.includes('account has been')
            ) {
              clearTimeout(timer);
              page.off('response', handler);
              reject(
                new Error(
                  `stocktwits_account_restricted: Stocktwits API indicates the account is muted or restricted. ` +
                  `Raw: ${body.slice(0, 200)}`,
                ),
              );
              return;
            }

            // Duplicate-post signal.
            if (/duplicate|already posted|same message/i.test(body)) {
              clearTimeout(timer);
              page.off('response', handler);
              reject(
                new Error(
                  `stocktwits_duplicate_post: Stocktwits rejected the post as a duplicate. ` +
                  `Raw: ${body.slice(0, 200)}`,
                ),
              );
              return;
            }
          }
        } catch {
          // Non-fatal — let the timer handle the timeout fallback.
        }
      };

      page.on('response', handler);
    });
  }

  /**
   * Scan the page DOM for post-submit restriction/rate-limit banners.
   * Stocktwits can show these as toast notifications or inline modal text
   * after the Post button is clicked, independently of the API response.
   * Throws if a restriction signal is detected.
   */
  private async checkPostSubmitRestrictions(page: Page): Promise<void> {
    await page.waitForTimeout(1_200).catch(() => undefined);

    const pageText = await page
      .evaluate(() => document.body.innerText.toLowerCase())
      .catch(() => '');

    const rateLimitSignals = [
      'posting too frequently',
      'posting too fast',
      'too many posts',
      'rate limit',
      'slow down',
      'you are posting too',
    ];
    for (const signal of rateLimitSignals) {
      if (pageText.includes(signal)) {
        throw new Error(
          `stocktwits_rate_limited: Stocktwits is rate-limiting this account. ` +
          `Wait at least 15 minutes before posting again.`,
        );
      }
    }

    const restrictionSignals = [
      'your account has been muted',
      'account has been muted',
      'your ability to engage',
      'account has been suspended',
      'your account has been suspended',
      'account is suspended',
      'account has been restricted',
      'posting has been restricted',
    ];
    for (const signal of restrictionSignals) {
      if (pageText.includes(signal)) {
        throw new Error(
          `stocktwits_account_restricted: Post-submit check detected a Stocktwits account restriction. ` +
          `Log into Stocktwits manually to check account standing.`,
        );
      }
    }
  }

  private async executeStrictSymbolComposerFlow(
    page: Page,
    symbol: string,
    message: string,
  ): Promise<Locator> {
    // humanReadFeed (called in navigateToSymbolFeed) scrolls DOWN to simulate
    // reading. Stocktwits uses React virtual scrolling — the inline composer at
    // the top of the feed gets UNMOUNTED from the DOM once it's scrolled past.
    // Scroll back to the very top first to re-mount the composer, then let
    // scrollToSymbolComposer position it properly.
    this.logger.debug(`Scrolling to top of $${symbol} feed to find composer`);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' })).catch(() => undefined);
    await this.humanDelay(700, 1_200);

    await this.scrollToSymbolComposer(page, symbol);

    const container = await this.resolveSymbolComposerContainer(page, symbol);
    if (!container) {
      throw new Error(`stocktwits_symbol_composer_not_found:${symbol}`);
    }

    await container.scrollIntoViewIfNeeded().catch(() => undefined);
    // Hover over the composer naturally before clicking into it
    await this.humanHoverBeforeClick(page, container);
    await this.activateSymbolComposerPlaceholder(page, symbol);
    // After placeholder activation, explicitly locate and click the real
    // textarea/contenteditable so keyboard focus is correct before typing.
    // Without this step, keyboard events can go to the wrong element.
    const inputEl = await this.findFirstVisibleIn(container, [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
    ]);
    if (inputEl) {
      await inputEl.click({ timeout: 2_500 }).catch(() => undefined);
    } else {
      await container
        .click({ position: { x: 140, y: 40 }, timeout: 2_500 })
        .catch(() => undefined);
    }
    // Small settling pause after the click — humans don't instantly type
    await this.humanDelay(200, 550);

    // Stocktwits auto-prefixes the inline composer with "$SYMBOL " when it
    // expands. Clear that pre-fill the human way: triple-click selects all text
    // in the focused field, then the first character of the new message replaces
    // the selection — no keyboard shortcut that screams "automation".
    if (inputEl) {
      await inputEl.click({ clickCount: 3 }).catch(() => undefined);
    } else {
      await container
        .click({ clickCount: 3, position: { x: 140, y: 40 } })
        .catch(() => undefined);
    }
    await this.humanDelay(180, 420);
    // Brief pause as if the human is deciding what to write
    await this.humanDelay(300, 900);

    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();
    // Use human burst-typing instead of uniform machine delay
    await this.humanTypeText(page, normalizedMessage);
    // Post-typing pause — re-read before moving to the submit button
    await this.humanDelay(200, 600);

    return container;
  }

  private async navigateToSymbolFeed(
    page: Page,
    postUrl: string,
    symbol: string,
  ): Promise<void> {
    const symbolUrl = this.resolveSymbolUrl(postUrl, symbol);
    await page.goto(symbolUrl, { waitUntil: 'domcontentloaded' });

    await this.dismissCookieBanner(page);

    // Wait up to 20 s for React to render the feed composer before proceeding.
    // domcontentloaded fires before the SPA's JS runs; the composer textarea is
    // only added to the DOM after the React components mount.
    await page
      .getByText(/Share\s+your\s+idea\s+on/i)
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => undefined);

    // Simulate a human landing on the symbol page and reading
    // existing posts before composing their own.
    await this.humanReadFeed(page);
  }

  private async resolveComposer(page: Page, symbol?: string): Promise<Locator> {
    if (symbol) {
      return this.resolveSymbolComposer(page, symbol);
    }

    const scope = await this.findOpenDialogScope(page);
    if (scope) {
      const dialogArea = await this.findFirstVisibleIn(scope, [
        '[contenteditable="true"][role="combobox"][aria-describedby^="placeholder-"]',
        'textarea',
        '[contenteditable="true"]',
      ]);
      if (dialogArea) {
        return dialogArea;
      }
    }

    const modalArea = await this.findFirstVisible(page, [
      '[contenteditable="true"][role="combobox"][aria-describedby^="placeholder-"]',
      'textarea',
      '[contenteditable="true"]',
    ]);
    if (modalArea) {
      return modalArea;
    }
    throw new Error('Composer not found.');
  }

  private async resolveSymbolComposer(
    page: Page,
    symbol: string,
  ): Promise<Locator> {
    const cashtag = `$${symbol}`;
    await this.activateSymbolComposerPlaceholder(page, symbol);

    const scopedContainer = await this.resolveSymbolComposerContainer(
      page,
      symbol,
    );
    if (scopedContainer) {
      const scopedComposer = await this.findFirstVisibleIn(scopedContainer, [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
      ]);
      if (scopedComposer) {
        return scopedComposer;
      }
    }

    const selectors = [
      `textarea[placeholder*="Share your idea on ${cashtag}"]`,
      `textarea[aria-label*="Share your idea on ${cashtag}"]`,
      `textarea[placeholder*="${cashtag}"]`,
      `textarea[aria-label*="${cashtag}"]`,
      '[contenteditable="true"][aria-label*="Share your idea on"]',
      '[contenteditable="true"][aria-label*="Share your idea"]',
      '[contenteditable="true"][role="textbox"][aria-label*="$"]',
      '[contenteditable="true"][role="textbox"]',
      '[role="textbox"]',
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        await locator.scrollIntoViewIfNeeded().catch(() => undefined);
        return locator;
      }
    }

    throw new Error(`stocktwits_symbol_composer_not_found:${symbol}`);
  }

  private async resolveSymbolComposerContainer(
    page: Page,
    symbol: string,
  ): Promise<Locator | null> {
    const pageWithLocator = page as Page & {
      locator?: (selector: string) => Locator;
    };

    const placeholder = await this.findSymbolComposerPlaceholder(page, symbol);
    if (placeholder) {
      const container = placeholder
        .locator(
          'xpath=ancestor::*[self::form or self::section or self::article or self::div][.//button[contains(normalize-space(.), "Post") or @type="submit"]][1]',
        )
        .first();
      if (await container.isVisible().catch(() => false)) {
        return container;
      }
    }

    if (typeof pageWithLocator.locator !== 'function') {
      return null;
    }

    const cashtag = `$${symbol}`;
    const containers = [
      pageWithLocator
        .locator(`form:has-text("Share your idea on ${cashtag}")`)
        .first(),
      pageWithLocator
        .locator(`section:has-text("Share your idea on ${cashtag}")`)
        .first(),
      pageWithLocator
        .locator(`article:has-text("Share your idea on ${cashtag}")`)
        .first(),
      pageWithLocator
        .locator(`div:has-text("Share your idea on ${cashtag}")`)
        .first(),
      pageWithLocator.locator('form:has-text("Share your idea on")').first(),
      pageWithLocator.locator('section:has-text("Share your idea on")').first(),
    ];

    for (const container of containers) {
      if (await container.isVisible().catch(() => false)) {
        return container;
      }
    }

    return null;
  }

  private async findSymbolComposerPlaceholder(
    page: Page,
    symbol: string,
  ): Promise<Locator | null> {
    // String.raw preserves the literal `\s` and `\$` so they reach the regex
    // engine — a plain template literal silently drops backslashes before
    // non-escape characters, which produced `Shares+yours+ideas+ons+$?GME`
    // and the "Nothing to repeat" parse error.
    const symbolPattern = new RegExp(
      String.raw`Share\s+your\s+idea\s+on\s+\$?` + escapeRegExp(symbol),
      'i',
    );
    const pageWithGetByText = page as Page & {
      getByText?: (text: string | RegExp) => Locator;
    };

    if (typeof pageWithGetByText.getByText === 'function') {
      const exact = pageWithGetByText.getByText(symbolPattern).first();
      if (await exact.isVisible().catch(() => false)) {
        return exact;
      }

      const generic = pageWithGetByText
        .getByText(/Share\s+your\s+idea\s+on/i)
        .first();
      if (await generic.isVisible().catch(() => false)) {
        return generic;
      }
    }

    return null;
  }

  private async activateSymbolComposerPlaceholder(
    page: Page,
    symbol: string,
  ): Promise<void> {
    const placeholder = await this.findSymbolComposerPlaceholder(page, symbol);
    if (!placeholder) {
      return;
    }

    await placeholder.scrollIntoViewIfNeeded().catch(() => undefined);
    await placeholder.click({ timeout: 2_500 }).catch(async () => {
      const container = placeholder
        .locator(
          'xpath=ancestor::*[self::form or self::section or self::article or self::div][.//button[contains(normalize-space(.), "Post") or @type="submit"]][1]',
        )
        .first();
      if (await container.isVisible().catch(() => false)) {
        await container.click({ timeout: 2_500 }).catch(() => undefined);
      }
    });
    await page.waitForTimeout?.(150);
  }

  private async scrollToSymbolComposer(
    page: Page,
    symbol: string,
  ): Promise<void> {
    const cashtag = `$${symbol}`;
    for (let i = 0; i < 10; i += 1) {
      const placeholder = await this.findSymbolComposerPlaceholder(
        page,
        symbol,
      );
      if (placeholder) {
        await placeholder.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout?.(200);
        return;
      }

      const composer = await this.findFirstVisible(page, [
        `textarea[placeholder*="Share your idea on ${cashtag}"]`,
        `textarea[aria-label*="Share your idea on ${cashtag}"]`,
        'textarea[placeholder*="Share your idea on"]',
        '[contenteditable="true"][aria-label*="Share your idea on"]',
        '[contenteditable="true"][role="textbox"]',
      ]);
      if (composer) {
        await composer.scrollIntoViewIfNeeded().catch(() => undefined);
        await page.waitForTimeout?.(200);
        return;
      }
      await page.mouse?.wheel(0, 700);
      await page.waitForTimeout?.(250);
    }
  }

  private async fillComposer(
    composer: Locator,
    message: string,
  ): Promise<void> {
    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();

    await composer.waitFor({ state: 'visible', timeout: 4_000 });
    await composer.click({ timeout: 2_500 }).catch(() => undefined);
    await composer.press('Control+A').catch(() => undefined);
    await composer.press('Backspace').catch(() => undefined);

    await composer
      .fill(normalizedMessage, { timeout: 4_000 })
      .catch(async () => {
        await composer.type(normalizedMessage, { delay: 8, timeout: 4_000 });
      });
  }

  private async fillComposerForSymbol(
    composer: Locator,
    symbol: string,
    message: string,
  ): Promise<void> {
    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();

    await composer.waitFor({ state: 'visible', timeout: 4_000 });
    await composer.click({ timeout: 2_500 }).catch(() => undefined);

    const existingText = await this.readComposerText(composer);
    if (this.isSymbolSeedText(existingText, symbol)) {
      await composer.type(` ${normalizedMessage}`, {
        delay: 8,
        timeout: 5_000,
      });
      return;
    }

    await composer.press('Control+A').catch(() => undefined);
    await composer.press('Backspace').catch(() => undefined);
    await composer
      .type(normalizedMessage, { delay: 8, timeout: 5_000 })
      .catch(async () => {
        await composer.fill(normalizedMessage, { timeout: 4_000 });
      });
  }

  private async fillAndValidateSymbolComposer(
    page: Page,
    symbol: string,
    message: string,
  ): Promise<Locator> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const composer = await this.resolveComposer(page, symbol);
        await this.fillComposerForSymbol(composer, symbol, message);
        await this.ensureComposerContainsExpectedBody(
          composer,
          message,
          symbol,
        );
        return composer;
      } catch (error) {
        lastError = error;

        try {
          const fallbackContainer = await this.fillSymbolComposerViaContainer(
            page,
            symbol,
            message,
          );
          if (fallbackContainer) {
            return fallbackContainer;
          }
        } catch (fallbackError) {
          lastError = fallbackError;
        }

        await page.waitForTimeout?.(350);
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }

    throw new Error(`stocktwits_symbol_composer_fill_failed:${symbol}`);
  }

  private async fillSymbolComposerViaContainer(
    page: Page,
    symbol: string,
    message: string,
  ): Promise<Locator | null> {
    const container = await this.resolveSymbolComposerContainer(page, symbol);
    if (!container) {
      return null;
    }

    await container.scrollIntoViewIfNeeded().catch(() => undefined);
    await this.activateSymbolComposerPlaceholder(page, symbol);
    await page.waitForTimeout?.(120);

    const editable = await this.findFirstVisibleIn(container, [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
    ]);

    if (editable) {
      await this.fillComposerForSymbol(editable, symbol, message);
      await this.ensureComposerContainsExpectedBody(editable, message, symbol);
      return editable;
    }

    const placeholder = await this.findSymbolComposerPlaceholder(page, symbol);
    if (placeholder) {
      await placeholder.click({ timeout: 2_500 }).catch(() => undefined);
    } else {
      await container
        .click({ position: { x: 140, y: 40 }, timeout: 2_500 })
        .catch(() => undefined);
    }

    const containerTextBefore = await this.readLocatorText(container);
    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();

    if (!this.isSymbolSeedText(containerTextBefore, symbol)) {
      await page.keyboard.press('Control+A').catch(() => undefined);
      await page.keyboard.press('Backspace').catch(() => undefined);
      await page.keyboard.type(normalizedMessage, { delay: 8 });
    } else {
      await page.keyboard.type(` ${normalizedMessage}`, { delay: 8 });
    }

    const expectedProbe = this.extractBodyProbe(normalizedMessage);
    const afterText = await this.readLocatorText(container);
    const afterProbe = this.extractBodyProbe(afterText);
    if (!afterProbe.includes(expectedProbe)) {
      throw new Error(`stocktwits_symbol_body_not_applied:${symbol}`);
    }

    return container;
  }

  private async submitInlineSymbolPost(
    page: Page,
    composer: Locator,
    symbol: string,
  ): Promise<void> {
    // Dry-run mode: skip the actual Post click so we can verify the full
    // compose flow in dev without burning real posts or risking rate-limits.
    const dryRun = this.configService.get<boolean>('STOCKTWITS_DRY_RUN') === true;
    if (dryRun) {
      this.logger.warn(
        `[DRY RUN] Stocktwits post for $${symbol} composed but NOT submitted (STOCKTWITS_DRY_RUN=true).`,
      );
      return;
    }

    // Primary strategy: walk the DOM inside the page, find the textarea that
    // matches this symbol, walk up to the nearest ancestor containing an
    // enabled "Post" button, and tag that button with a unique data attribute.
    // Then click via the tag. This is invariant to CSS-module class hashing
    // and to placeholder text disappearing after user input.
    const tagged = await this.tagInlinePostButton(page, symbol, 12_000);
    if (tagged) {
      const taggedButton = page
        .locator('[data-pw-inline-post-target="true"]')
        .first();
      // Hover over the Post button naturally before clicking it
      await this.humanHoverBeforeClick(page, taggedButton);
      await this.clickWithFallbacks(
        page,
        taggedButton,
        'submitInlineSymbolPost.tagged',
      );
      return;
    }

    // Fallback: re-resolve the composer via aria-label/placeholder, then use
    // proximity-based selection. Used only if the DOM-tag walk above couldn't
    // find a textarea matching the symbol — e.g. if Stocktwits ever stops
    // setting the aria-label/placeholder we're keying off.
    const liveComposer =
      (await this.findInlineComposerByAttributes(page, symbol)) ?? composer;
    const button = await this.waitForEnabledInlinePostButton(
      liveComposer,
      6_000,
    );
    if (!button) {
      throw new Error('stocktwits_inline_post_button_not_found_or_disabled');
    }
    await this.humanHoverBeforeClick(page, button);
    await this.clickWithFallbacks(
      page,
      button,
      'submitInlineSymbolPost.fallback',
    );
  }

  private async tagInlinePostButton(
    page: Page,
    symbol: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const startedAt = Date.now();
    let lastReason = '';

    while (Date.now() - startedAt < timeoutMs) {
      const result = await page
        .evaluate((sym: string) => {
          // Clear any previous tags so we don't click a stale one.
          document
            .querySelectorAll('[data-pw-inline-post-target]')
            .forEach((el) => el.removeAttribute('data-pw-inline-post-target'));

          const symbolUpper = sym.toUpperCase();

          const editableNodes = Array.from(
            document.querySelectorAll(
              'textarea, [contenteditable="true"], [role="textbox"]',
            ),
          );

          // Step 1: find the composer textarea/contenteditable bound to this
          // symbol. Prefer aria-label / placeholder containing the cashtag,
          // then fall back to "Share your idea on" generically, then to any
          // editable that has user-typed content.
          const matches = (label: string, expected: string[]): boolean => {
            const upper = label.toUpperCase();
            return expected.every((part) => upper.includes(part.toUpperCase()));
          };

          const findEditable = (
            predicate: (label: string) => boolean,
          ): HTMLElement | null => {
            for (const el of editableNodes) {
              const label =
                (el.getAttribute('aria-label') || '') +
                ' ' +
                (el.getAttribute('placeholder') || '');
              if (predicate(label)) {
                return el as HTMLElement;
              }
            }
            return null;
          };

          let composer =
            findEditable((label) =>
              matches(label, ['Share your idea on $' + symbolUpper]),
            ) ||
            findEditable((label) =>
              matches(label, ['Share your idea on', symbolUpper]),
            ) ||
            findEditable((label) => matches(label, ['Share your idea on']));

          if (!composer) {
            for (const el of editableNodes) {
              const value =
                (el as HTMLTextAreaElement).value || el.textContent || '';
              if (value.replace(/\s+/g, '').length > 10) {
                composer = el as HTMLElement;
                break;
              }
            }
          }

          if (!composer) {
            return { tagged: false, reason: 'composer_textarea_not_found' };
          }

          // Step 2: walk up through ancestors. The first ancestor that
          // contains an enabled "Post" button as a descendant IS the inline
          // composer card — by DOM topology, the sidebar Post button is in a
          // sibling subtree, not an ancestor of the symbol composer.
          let node: Element | null = composer;
          let depth = 0;
          let firstDisabledMatch: HTMLButtonElement | null = null;

          while (node && node !== document.body && depth < 20) {
            const buttons = Array.from(node.querySelectorAll('button'));
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text !== 'post') continue;

              const isDisabled =
                btn.disabled || btn.getAttribute('aria-disabled') === 'true';

              if (!isDisabled) {
                btn.setAttribute('data-pw-inline-post-target', 'true');
                return { tagged: true, enabled: true };
              }
              if (!firstDisabledMatch) {
                firstDisabledMatch = btn;
              }
            }
            node = node.parentElement;
            depth += 1;
          }

          if (firstDisabledMatch) {
            return {
              tagged: false,
              reason: 'inline_post_button_present_but_disabled',
            };
          }
          return {
            tagged: false,
            reason: 'no_post_button_in_composer_ancestors',
          };
        }, symbol)
        .catch(() => null);

      if (result && 'tagged' in result && result.tagged) {
        return true;
      }
      if (result && 'reason' in result) {
        lastReason = result.reason ?? '';
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (lastReason) {
      this.logger.warn(
        `tagInlinePostButton timed out after ${timeoutMs}ms: ${lastReason}`,
      );
    }
    return false;
  }

  private async findInlineComposerByAttributes(
    page: Page,
    symbol: string,
  ): Promise<Locator | null> {
    // Attribute-based anchors persist after the user types — placeholder text
    // does not. Try the most specific anchors first.
    const cashtag = `$${symbol}`;
    const selectors = [
      `textarea[aria-label*="Share your idea on ${cashtag}"]`,
      `textarea[placeholder*="Share your idea on ${cashtag}"]`,
      `[contenteditable="true"][aria-label*="Share your idea on ${cashtag}"]`,
      `textarea[aria-label*="${cashtag}"]`,
      `textarea[placeholder*="${cashtag}"]`,
      `[contenteditable="true"][aria-label*="${cashtag}"]`,
      'textarea[aria-label*="Share your idea on"]',
      'textarea[placeholder*="Share your idea on"]',
      '[contenteditable="true"][aria-label*="Share your idea on"]',
    ];

    for (const selector of selectors) {
      const candidate = page.locator(selector).first();
      const visible = await candidate
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (!visible) {
        continue;
      }
      // Walk up to the closest form/section/article/div ancestor that
      // contains a Post button — that's the composer card whose center we
      // want to use as the proximity anchor for the inline Post button.
      const card = candidate
        .locator(
          'xpath=ancestor::*[self::form or self::section or self::article or self::div][.//button[contains(normalize-space(.), "Post") or @type="submit"]][1]',
        )
        .first();
      if (await card.isVisible({ timeout: 250 }).catch(() => false)) {
        return card;
      }
      return candidate;
    }
    return null;
  }

  private async waitForEnabledInlinePostButton(
    composer: Locator,
    timeoutMs: number,
  ): Promise<Locator | null> {
    // Pick the Post button geometrically nearest to the composer. On the
    // /symbol/{X} layout the inline Post button sits in the action row right
    // below the textarea (same card), while the sidebar Post CTA is far away
    // in the left column — proximity reliably distinguishes them and matches
    // the user-facing "nearest post button" rule.
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const button = await this.findClosestEnabledPostButton(composer);
      if (button) {
        return button;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return null;
  }

  private async findClosestEnabledPostButton(
    composer: Locator,
  ): Promise<Locator | null> {
    const composerBox = await composer.boundingBox().catch(() => null);
    if (!composerBox) {
      return null;
    }
    const composerCenterX = composerBox.x + composerBox.width / 2;
    const composerCenterY = composerBox.y + composerBox.height / 2;

    const page = composer.page();
    const buttons = page.locator(
      'button:has-text("Post"), button[type="submit"], button[class*="ButtonPost_"]',
    );
    const count = await buttons.count().catch(() => 0);

    let bestButton: Locator | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < count; i += 1) {
      const candidate = buttons.nth(i);
      const visible = await candidate.isVisible().catch(() => false);
      if (!visible) {
        continue;
      }
      const disabled = await candidate
        .evaluate(
          (el) =>
            (el as HTMLButtonElement).disabled ||
            el.getAttribute('aria-disabled') === 'true',
        )
        .catch(() => true);
      if (disabled) {
        continue;
      }
      const box = await candidate.boundingBox().catch(() => null);
      if (!box) {
        continue;
      }
      const buttonCenterX = box.x + box.width / 2;
      const buttonCenterY = box.y + box.height / 2;
      const distance = Math.hypot(
        buttonCenterX - composerCenterX,
        buttonCenterY - composerCenterY,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestButton = candidate;
      }
    }

    return bestButton;
  }

  private async findEnabledButtonInScope(
    scope: Locator,
    selectors: string[],
  ): Promise<Locator | null> {
    for (const selector of selectors) {
      const candidates = scope.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const button = candidates.nth(i);
        const visible = await button.isVisible().catch(() => false);
        if (!visible) {
          continue;
        }
        const disabled = await button
          .evaluate(
            (el) =>
              (el as HTMLButtonElement).disabled ||
              el.getAttribute('aria-disabled') === 'true',
          )
          .catch(() => true);
        if (disabled) {
          continue;
        }
        return button;
      }
    }
    return null;
  }

  private prepareSymbolFeedMessage(symbol: string, message: string): string {
    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();
    const targetSymbol = normalizeStocktwitsSymbol(symbol);
    if (!targetSymbol) {
      return normalizedMessage;
    }

    const [firstLine, ...rest] = normalizedMessage.split('\n');
    const firstLineSymbol = normalizeStocktwitsSymbol(firstLine.trim());
    if (firstLineSymbol !== targetSymbol) {
      return normalizedMessage;
    }

    const restMessage = rest.join('\n').replace(/^\s+/, '').trim();
    return restMessage || normalizedMessage;
  }

  private extractBodyProbe(message: string): string {
    const normalized = message.replace(/\s+/g, ' ').trim().toLowerCase();
    return normalized.slice(0, 80);
  }

  private isSymbolSeedText(value: string, symbol: string): boolean {
    const symbolToken = normalizeStocktwitsSymbol(symbol);
    if (!symbolToken) {
      return false;
    }

    const cleaned = value.replace(/\s+/g, '').replace(/^\$/, '').toUpperCase();
    return cleaned === symbolToken;
  }

  private async readComposerText(composer: Locator): Promise<string> {
    const tagName = await composer
      .evaluate((el) => el.tagName.toLowerCase())
      .catch(() => '');

    if (tagName === 'textarea') {
      return composer.inputValue().catch(() => '');
    }

    return composer
      .evaluate((el) => (el as HTMLElement).innerText || el.textContent || '')
      .catch(() => '');
  }

  private async ensureComposerContainsExpectedBody(
    composer: Locator,
    expectedMessage: string,
    symbol: string,
  ): Promise<void> {
    const expectedProbe = this.extractBodyProbe(expectedMessage);
    if (!expectedProbe) {
      return;
    }

    const initialText = await this.readComposerText(composer);
    const initialProbe = this.extractBodyProbe(initialText);
    if (initialProbe.includes(expectedProbe)) {
      return;
    }

    await this.fillComposer(composer, expectedMessage);
    const secondText = await this.readComposerText(composer);
    const secondProbe = this.extractBodyProbe(secondText);
    if (secondProbe.includes(expectedProbe)) {
      return;
    }

    throw new Error(`stocktwits_symbol_body_not_applied:${symbol}`);
  }

  private async readLocatorText(locator: Locator): Promise<string> {
    return locator
      .evaluate((el) => (el as HTMLElement).innerText || el.textContent || '')
      .catch(() => '');
  }

  private async handlePostConfirmationModal(page: Page): Promise<void> {
    const cashtagPattern = /Did you forget to use a \$Cashtag\?/i;
    const modal = await this.findCashtagModal(page, cashtagPattern);
    if (!modal) {
      return;
    }

    const postWithoutCashtag = modal
      .locator('button:has-text("Post without cashtag")')
      .first();
    if (await postWithoutCashtag.isVisible().catch(() => false)) {
      await this.clickWithFallbacks(page, postWithoutCashtag, 'cashtag_modal');
      return;
    }

    const fallback = page
      .locator('button:has-text("Post without cashtag")')
      .first();
    if (await fallback.isVisible().catch(() => false)) {
      await this.clickWithFallbacks(page, fallback, 'cashtag_modal_fallback');
      return;
    }

    throw new Error(
      'stocktwits_cashtag_modal_detected_but_action_button_not_found',
    );
  }

  private async findCashtagModal(
    page: Page,
    pattern: RegExp,
  ): Promise<Locator | null> {
    const selectors = [
      '.ReactModal__Content',
      '[class*="ReactModal__Content"]',
      '[role="dialog"]',
      '[aria-modal="true"]',
    ];
    for (const selector of selectors) {
      const candidate = page
        .locator(selector)
        .filter({ hasText: pattern })
        .last();
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
    return null;
  }

  private async snapshotMessageIds(page: Page): Promise<Set<string>> {
    const ids = await page
      .evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/message/"]'))
          .map((a) => {
            const href = a.getAttribute('href') ?? '';
            const match = href.match(/\/message\/(\d+)/);
            return match?.[1] ?? '';
          })
          .filter((id) => id.length > 0);
      })
      .catch(() => [] as string[]);
    return new Set(ids);
  }

  private async resolvePostId(
    page: Page,
    excludeIds: Set<string>,
    contentProbe?: string,
  ): Promise<string | null> {
    const urlMatch = page.url().match(/\/message\/(\d+)/);
    if (urlMatch?.[1] && !excludeIds.has(urlMatch[1])) {
      return urlMatch[1];
    }

    const ids = await page
      .evaluate(() => {
        return Array.from(document.querySelectorAll('a[href*="/message/"]'))
          .map((a) => {
            const href = a.getAttribute('href') ?? '';
            const match = href.match(/\/message\/(\d+)/);
            return match?.[1] ?? '';
          })
          .filter((id) => id.length > 0);
      })
      .catch(() => [] as string[]);

    for (const id of ids) {
      if (!excludeIds.has(id)) {
        return id;
      }
    }

    if (contentProbe && contentProbe.length >= 12) {
      const idByContent = await page
        .evaluate((needle) => {
          const links = Array.from(
            document.querySelectorAll('a[href*="/message/"]'),
          );
          for (const link of links) {
            // Walk up from the link looking for an ancestor whose visible text
            // contains the typed message body.
            let node: Element | null = link;
            for (let depth = 0; depth < 10 && node; depth += 1) {
              const text =
                (node as HTMLElement).innerText || node.textContent || '';
              if (text.includes(needle)) {
                const href = link.getAttribute('href') ?? '';
                const match = href.match(/\/message\/(\d+)/);
                if (match) {
                  return match[1];
                }
                break;
              }
              node = node.parentElement;
            }
          }
          return null;
        }, contentProbe)
        .catch(() => null);

      if (idByContent && !excludeIds.has(idByContent)) {
        return idByContent;
      }
    }

    return null;
  }

  private extractStocktwitsContentProbe(message: string): string {
    // Strip surrogates/emoji so the probe matches innerText reliably across
    // Chromium font fallbacks; collapse whitespace; cap length.
    return message
      .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
      .replace(/[\u{2600}-\u{27BF}]/gu, '')
      .replace(/[\u{1F000}-\u{1F2FF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);
  }

  private async detectPublishErrorToast(page: Page): Promise<string | null> {
    const errorPatterns = [
      /failed to post/i,
      /something went wrong/i,
      /please try again/i,
      /you are posting too quickly/i,
      /unable to (post|submit)/i,
      /violat(es|ed) our (community|content) guidelines/i,
      /spam/i,
    ];
    for (const pattern of errorPatterns) {
      const visible = await page
        .getByText(pattern)
        .first()
        .isVisible({ timeout: 200 })
        .catch(() => false);
      if (visible) {
        const text = await page
          .getByText(pattern)
          .first()
          .innerText()
          .catch(() => '');
        return text.trim().slice(0, 200) || pattern.source;
      }
    }
    return null;
  }

  private async waitForPublishConfirmation(
    page: Page,
    timeoutMs: number,
    excludeIds: Set<string>,
    messageBody?: string,
  ): Promise<string | null> {
    const startedAt = Date.now();
    const probe = messageBody
      ? this.extractStocktwitsContentProbe(messageBody)
      : '';

    while (Date.now() - startedAt < timeoutMs) {
      await this.clickPostInDialogIfVisible(page);

      const errorToast = await this.detectPublishErrorToast(page);
      if (errorToast) {
        throw new Error(
          `stocktwits_post_rejected_by_site: "${errorToast.replace(/\s+/g, ' ')}"`,
        );
      }

      const messageId = await this.resolvePostId(page, excludeIds, probe);
      if (messageId) {
        return messageId;
      }
      await page.waitForTimeout(500);
    }

    // Final diagnostic before giving up: distinguish "submit didn't fire"
    // from "submit fired but we couldn't locate the new post".
    const stillOpen = await this.findOpenDialogScope(page);
    if (stillOpen) {
      throw new Error(
        'stocktwits_publish_submit_did_not_fire: composer modal is still open after submit.',
      );
    }

    return null;
  }

  private async finalizeDialogPost(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clicked = await this.clickPostInDialogIfVisible(page);
      if (!clicked) {
        return;
      }
      await page.waitForTimeout(700);
      const stillOpen = await this.findOpenDialogScope(page);
      if (!stillOpen) {
        return;
      }
    }
  }

  private async clickPostInDialogIfVisible(page: Page): Promise<boolean> {
    const scope = await this.findOpenDialogScope(page);
    if (!scope) {
      return false;
    }

    const postButton = await this.findFirstVisibleIn(scope, [
      'button:has-text("Post")',
      'button[type="submit"]',
    ]);
    if (!postButton) {
      return false;
    }

    const disabled = await postButton
      .evaluate(
        (el) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute('aria-disabled') === 'true',
      )
      .catch(() => false);
    if (disabled) {
      return false;
    }

    await this.clickWithFallbacks(
      page,
      postButton,
      'clickPostInDialogIfVisible',
    );
    return true;
  }

  private async findOpenDialogScope(page: Page): Promise<Locator | null> {
    // Stocktwits uses react-modal: ReactModalPortal > ReactModal__Overlay >
    // ReactModal__Content. The content container does not always carry
    // role="dialog" (CSS-module hashed classes), so we try several selectors
    // and return the topmost (last-in-DOM) visible one.
    const contentSelectors = [
      '.ReactModal__Content',
      '[class*="ReactModal__Content"]',
      '[role="dialog"]',
      '[aria-modal="true"]',
    ];

    for (const selector of contentSelectors) {
      const matches = page.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i -= 1) {
        const candidate = matches.nth(i);
        if (await candidate.isVisible({ timeout: 250 }).catch(() => false)) {
          return candidate;
        }
      }
    }
    return null;
  }

  private async clickWithFallbacks(
    page: Page,
    target: Locator,
    context: string,
    timeoutMs = 6_000,
  ): Promise<void> {
    let firstReason = '';
    try {
      await target.click({ timeout: timeoutMs });
      return;
    } catch (firstError) {
      firstReason =
        firstError instanceof Error
          ? firstError.message.split('\n')[0]
          : 'unknown';
      this.logger.warn(
        `Click failed [${context}]: ${firstReason}. Retrying with force=true.`,
      );
    }

    try {
      await target.click({ timeout: 4_000, force: true });
      return;
    } catch (secondError) {
      const reason =
        secondError instanceof Error
          ? secondError.message.split('\n')[0]
          : 'unknown';
      this.logger.warn(
        `Force click failed [${context}]: ${reason}. Trying Ctrl+Enter shortcut.`,
      );
    }

    await page.keyboard.press('Control+Enter').catch(() => undefined);
  }

  private async findFirstVisible(
    page: Page,
    selectors: string[],
  ): Promise<Locator | null> {
    const pageWithLocator = page as Page & {
      locator?: (selector: string) => Locator;
    };
    if (typeof pageWithLocator.locator !== 'function') {
      return null;
    }

    for (const selector of selectors) {
      const matches = pageWithLocator.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const locator = matches.nth(i);
        try {
          if (await locator.isVisible({ timeout: 1_500 })) {
            return locator;
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private async findFirstVisibleIn(
    scope: Locator,
    selectors: string[],
  ): Promise<Locator | null> {
    for (const selector of selectors) {
      const matches = scope.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let i = 0; i < count; i += 1) {
        const locator = matches.nth(i);
        try {
          if (await locator.isVisible({ timeout: 1_500 })) {
            return locator;
          }
        } catch {
          continue;
        }
      }
    }
    return null;
  }
}

// ============ STANDALONE UTILITIES ============

export function parseTrendingSymbolsFromHtml(
  html: string,
  limit = DEFAULT_TRENDING_SYMBOL_LIMIT,
): string[] {
  const rows = Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).map(
    (match) => match[1],
  );

  const rankedCandidates: RankedSymbolCandidate[] = [];
  for (const rowHtml of rows) {
    const rowText = stripHtml(rowHtml);
    const rankMatch = rowText.match(/\b(\d{1,3})\b/);
    if (!rankMatch) {
      continue;
    }

    const rank = Number(rankMatch[1]);
    if (!Number.isFinite(rank) || rank < 1 || rank > 500) {
      continue;
    }

    const hrefMatch = rowHtml.match(/\/symbol\/([A-Za-z0-9._-]{1,12})/i);
    const symbolFromHref = hrefMatch
      ? normalizeStocktwitsSymbol(hrefMatch[1])
      : null;
    if (symbolFromHref) {
      rankedCandidates.push({ rank, symbol: symbolFromHref });
      continue;
    }

    const tdMatches = Array.from(
      rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi),
    );
    if (tdMatches.length < 2) {
      continue;
    }

    const symbolText = stripHtml(tdMatches[1][1]);
    const symbol = extractSymbolToken(symbolText);
    if (symbol) {
      rankedCandidates.push({ rank, symbol });
    }
  }

  const ranked = normalizeRankedSymbols(rankedCandidates, limit);
  if (ranked.length > 0) {
    return ranked;
  }

  const hrefCandidates = Array.from(
    html.matchAll(/\/symbol\/([A-Za-z0-9._-]{1,12})/gi),
  )
    .map((match) => normalizeStocktwitsSymbol(match[1]))
    .filter((value): value is string => value !== null);

  const deduped: string[] = [];
  for (const symbol of hrefCandidates) {
    if (!deduped.includes(symbol)) {
      deduped.push(symbol);
    }
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function normalizeRankedSymbols(
  candidates: RankedSymbolCandidate[],
  limit: number,
): string[] {
  const sorted = [...candidates]
    .map((item) => ({
      rank: item.rank,
      symbol: normalizeStocktwitsSymbol(item.symbol),
    }))
    .filter(
      (item): item is { rank: number; symbol: string } => item.symbol !== null,
    )
    .sort((left, right) => left.rank - right.rank);

  const deduped: string[] = [];
  for (const candidate of sorted) {
    if (candidate.rank < 1) {
      continue;
    }
    if (!deduped.includes(candidate.symbol)) {
      deduped.push(candidate.symbol);
    }
    if (deduped.length >= limit) {
      break;
    }
  }

  return deduped;
}

function normalizeStocktwitsSymbol(value: string): string | null {
  const cleaned = value.replace(/^\$/, '').trim().toUpperCase();

  if (!/^[A-Z][A-Z0-9.-]{0,10}$/.test(cleaned)) {
    return null;
  }

  if (cleaned.length > 6) {
    return null;
  }

  return cleaned;
}

function extractSymbolToken(value: string): string | null {
  const tokens = value.match(/\$?[A-Za-z][A-Za-z0-9.-]{0,10}/g) ?? [];
  for (const token of tokens) {
    const normalized = normalizeStocktwitsSymbol(token);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

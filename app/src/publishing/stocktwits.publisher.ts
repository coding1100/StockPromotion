import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { BrowserContext, Page, Locator } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

type StocktwitsAccountConfig = {
  username: string;
  password: string;
  handle?: string;
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
  };
};

const CAPSOLVER_CREATE_TASK_URL = 'https://api.capsolver.com/createTask';
const CAPSOLVER_GET_TASK_RESULT_URL = 'https://api.capsolver.com/getTaskResult';

const DEFAULT_TRENDING_SYMBOL_LIMIT = 10;

@Injectable()
export class StocktwitsPublisher {
  private readonly logger = new Logger(StocktwitsPublisher.name);

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
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const manualLoginTimeoutMs =
      this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');
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
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
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
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const postUrl = this.configService.getOrThrow<string>('STOCKTWITS_POST_URL');
    const manualLoginTimeoutMs =
      this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');

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

    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const postUrl = this.configService.getOrThrow<string>('STOCKTWITS_POST_URL');
    const manualLoginTimeoutMs =
      this.configService.getOrThrow<number>(
        'STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS',
      );

    const artifactsDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(artifactsDir, { recursive: true });

    const { context, page } = await this.createBrowserSession(account.handle);
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

      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);

      for (let i = 0; i < symbols.length; i += 1) {
        const symbol = symbols[i];
        const successImg = join(
          artifactsDir,
          `${jobId}-${symbol}.png`,
        );
        const errorImg = join(
          artifactsDir,
          `${jobId}-${symbol}-error.png`,
        );

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

          await page.screenshot({ path: successImg, fullPage: true }).catch(() => undefined);
          results.push({
            symbol,
            success: true,
            externalPostId,
            evidenceUri: successImg,
            error: null,
          });
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : 'stocktwits_publish_failed';
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
          const interSymbolDelay = 2_000 + Math.floor(Math.random() * 3_000);
          this.logger.debug(
            `Waiting ${interSymbolDelay}ms before next symbol`,
          );
          await this.delay(interSymbolDelay);
        }
      }

      return {
        totalCount: results.length,
        successCount: results.filter((r) => r.success).length,
        failedCount: results.filter((r) => !r.success).length,
        results,
      };
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
  ): Promise<{ externalPostId: string; evidenceUri: string }> {
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const postUrl = this.configService.getOrThrow<string>('STOCKTWITS_POST_URL');
    const manualLoginTimeoutMs =
      this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');

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

    const { context, page } = await this.createBrowserSession(account.handle);

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs);

      if (!(await this.isAuthenticated(page))) {
        throw new Error('stocktwits_session_refresh_required');
      }

      // Note: we used to land on STOCKTWITS_POST_URL (the home feed) here and
      // then navigate to the symbol page. That intermediate stop is what
      // exposed the homepage Post button. Skip it — postOnSymbolFeed will
      // page.goto() the /symbol/{X} URL directly.
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

      await page.screenshot({ path: successImg, fullPage: true });
      return {
        externalPostId,
        evidenceUri: successImg,
      };
    } catch (error) {
      try {
        await page.screenshot({ path: errorImg, fullPage: true });
      } catch {
        this.logger.error('Failed to capture error screenshot.');
      }
      const msgText = error instanceof Error ? error.message : 'publish_failed';
      throw new Error(`${msgText} | evidence:${errorImg}`);
    } finally {
      await context.close();
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

    // Prefer reading widget attributes directly — when the challenge is already
    // rendered, the render() hook below misses the params and returns nulls.
    const fromDom = await page
      .evaluate(() => {
        const el =
          document.querySelector('.cf-turnstile') ||
          document.querySelector('[data-sitekey]');
        if (!el) {
          return null;
        }
        return {
          sitekey: el.getAttribute('data-sitekey'),
          cData: el.getAttribute('data-cdata'),
          action: el.getAttribute('data-action'),
        };
      })
      .catch(() => null);

    let sitekey: string | null = fromDom?.sitekey ?? null;

    if (!sitekey) {
      sitekey = await page
        .locator('[data-sitekey]')
        .first()
        .getAttribute('data-sitekey')
        .catch(() => null);
    }

    if (!sitekey) {
      const content = await page.content();
      const match = content.match(/data-sitekey=["']([^"']+)["']/);
      sitekey = match?.[1] ?? null;
    }

    const intercepted = await page.evaluate(() => {
      return new Promise<{
        cData: string | null;
        chlPageData: string | null;
        action: string | null;
      }>((resolve) => {
        const result = { cData: null as string | null, chlPageData: null as string | null, action: null as string | null };

        const checkTurnstile = () => {
          if ((window as any).turnstile) {
            const originalRender = (window as any).turnstile.render;
            (window as any).turnstile.render = function(a: any, b: any) {
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
          if (checkTurnstile()) {
            clearInterval(interval);
          }
        }, 50);

        setTimeout(() => {
          clearInterval(interval);
          resolve(result);
        }, 3000);
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
        throw new Error(`capsolver getTaskResult failed: HTTP ${response.status}`);
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

  private async solveChallengeWithCapSolver(page: Page): Promise<void> {
    this.logger.log('Attempting to solve Cloudflare challenge via CapSolver...');

    const params = await this.extractTurnstileParams(page);
    const pageUrl = page.url();

    if (!params.sitekey) {
      throw new Error('capsolver_turnstile_sitekey_not_found');
    }

    this.logger.debug(
      `Turnstile params - sitekey: ${params.sitekey}, action: ${params.action ?? 'none'}, cData: ${params.cData ? 'present' : 'missing'}`,
    );

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

      const textareas = document.querySelectorAll('textarea.g-recaptcha-response');
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

  // ============ BROWSER SESSION ============

  private async createBrowserSession(accountHandle?: string): Promise<{
    context: BrowserContext;
    page: Page;
    userDataDir: string;
  }> {
    const rawHeadless = this.configService.get('STOCKTWITS_HEADLESS');
    const isHeadless = rawHeadless === true || rawHeadless === 'true';

    const baseUserDataDir =
      this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() ||
      join(process.cwd(), '.pw-stocktwits');
    // Per-account profile so the cookies for one Stocktwits account never
    // leak into another. A shared profile silently re-uses a stale session
    // (skipping login because isAuthenticated() returns true on the cached
    // cookies) — even when a different account's credentials are supplied.
    const safeHandle = accountHandle
      ? accountHandle.replace(/[^a-zA-Z0-9_-]/g, '_')
      : '_default';
    const userDataDir = join(baseUserDataDir, safeHandle);
    const browserBinary =
      this.configService.get<string>('STOCKTWITS_BROWSER_BINARY')?.trim() || '';

    await mkdir(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: isHeadless,
      executablePath: browserBinary || undefined,
      viewport: { width: 1600, height: 1200 },
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--window-position=0,0',
      ],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const navTimeoutMs =
      this.configService.get<number>('STOCKTWITS_NAV_TIMEOUT_MS') ?? 45_000;
    const page = context.pages()[0] ?? (await context.newPage());
    // Only override navigation timeout — leave per-action timeouts at their
    // shorter default so a stuck click fails fast and we can recover, instead
    // of blocking the whole submit for 45s.
    page.setDefaultNavigationTimeout(navTimeoutMs);
    return { context, page, userDataDir };
  }

  // ============ LOGIN & AUTH ============

  private async performLoginIfNeeded(
    page: Page,
    account: StocktwitsAccountConfig,
    timeout: number,
  ): Promise<void> {
    if (await this.isAuthenticated(page)) {
      // Cached session — verify it belongs to the expected account before
      // trusting it. A shared user-data dir between runs can keep cookies
      // from a *different* Stocktwits account, and isAuthenticated() would
      // happily return true on those.
      const mismatched = await this.detectAccountMismatch(page, account);
      if (!mismatched) {
        return;
      }
      this.logger.warn(
        `Stocktwits cached session belongs to "${mismatched}" but request is for "${account.handle ?? account.username}". Forcing logout + re-login.`,
      );
      await this.forceLogoutAndReload(page);
    }

    let loginField = await this.findLoginField(page);
    let passwordField = await this.findPasswordField(page);

    if (!loginField || !passwordField) {
      await this.clickFirstVisibleSelector(page, [
        'a[href*="/signin"]',
        'a:has-text("Log In")',
        'button:has-text("Log In")',
        'a:has-text("Sign In")',
        'button:has-text("Sign In")',
      ]);

      await page.waitForTimeout(1_000);
      loginField = await this.findLoginField(page);
      passwordField = await this.findPasswordField(page);
    }

    if (!loginField || !passwordField) {
      const authState = await this.waitForAuthenticatedOrTimeout(page, timeout);
      if (authState === 'authenticated') {
        return;
      }
      throw new Error('stocktwits_login_form_not_found');
    }

    await loginField.fill(account.username);
    await passwordField.fill(account.password);

    const submit = await this.findFirstVisible(page, [
      'button[type="submit"]',
      'button:has-text("Log In")',
    ]);
    if (submit) {
      await submit.click();
    }

    await page.waitForTimeout(2_000);
    await this.handlePossibleChallenge(page, timeout);

    const result = await this.waitForAuthenticatedOrTimeout(page, timeout);
    if (result !== 'authenticated' && !(await this.isAuthenticated(page))) {
      throw new Error('stocktwits_login_not_confirmed');
    }
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
    const expectedTokens = [
      account.handle,
      account.username,
    ]
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
    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await this.dismissCookieBanner(page);
  }

  // ============ CHALLENGE HANDLING (UPDATED WITH CAPSOLVER) ============

  private async handlePossibleChallenge(page: Page, timeout: number): Promise<void> {
    if (!(await this.isChallengeVisible(page))) {
      return;
    }

    const headlessEnv = this.configService.get('STOCKTWITS_HEADLESS');
    const isHeadless = headlessEnv === true || headlessEnv === 'true';

    const capSolverKey = this.configService.get<string>('CAPSOLVER_API_KEY')?.trim();

    if (capSolverKey) {
      const maxAttempts = 2;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          await this.solveChallengeWithCapSolver(page);
          await page.waitForTimeout(3_000);
          if (!(await this.isChallengeVisible(page))) {
            return;
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
          await page.waitForTimeout(1_500);
        }
      }
      this.logger.warn('CapSolver attempts exhausted; falling back to manual flow.');
    }

    if (isHeadless) {
      throw new Error(
        'Cloudflare challenge detected in Headless mode. Set STOCKTWITS_HEADLESS=false to solve manually, or configure CAPSOLVER_API_KEY.',
      );
    }

    const result = await this.waitForAuthenticatedOrTimeout(page, timeout);
    if (result === 'timed_out' && (await this.isChallengeVisible(page))) {
      throw new Error('Challenge not resolved within timeout.');
    }
  }

  private async waitForAuthenticatedOrTimeout(
    page: Page,
    timeout: number,
  ): Promise<'authenticated' | 'login_required' | 'timed_out'> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.isAuthenticated(page)) {
        return 'authenticated';
      }
      if (!(await this.isChallengeVisible(page)) && (await this.hasLoginForm(page))) {
        return 'login_required';
      }
      await page.waitForTimeout(1_000);
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
    return challengeCopy.first().isVisible({ timeout: 250 }).catch(() => false);
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (await this.isChallengeVisible(page)) {
      return false;
    }
    if (/\/signin/i.test(page.url())) {
      return false;
    }

    if (await this.hasLoginForm(page)) {
      return false;
    }

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

    const authenticatedMarker = await this.findFirstVisible(page, [
      'a:has-text("Notifications")',
      'a:has-text("Messages")',
      'a:has-text("Settings")',
      'button:has-text("Post")',
    ]);

    return Boolean(authenticatedMarker);
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
      'button:has-text("Accept")',
      'button:has-text("Agree")',
      'button:has-text("OK")',
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

          const symbolLink = row.querySelector(
            'a[href*="/symbol/"]',
          ) as HTMLAnchorElement | null;

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
        ) as HTMLAnchorElement[];
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
    await this.navigateToSymbolFeed(page, postUrl, symbol);
    const symbolMessage = this.prepareSymbolFeedMessage(symbol, message);
    const composerScope = await this.executeStrictSymbolComposerFlow(
      page,
      symbol,
      symbolMessage,
    );
    await page.waitForTimeout?.(250);
    const beforeIds = await this.snapshotMessageIds(page);
    await this.submitInlineSymbolPost(page, composerScope, symbol);
    await this.handlePostConfirmationModal(page);
    await this.finalizeDialogPost(page);
    return this.waitForPublishConfirmation(
      page,
      this.publishConfirmTimeoutMs,
      beforeIds,
      symbolMessage,
    );
  }

  private async executeStrictSymbolComposerFlow(
    page: Page,
    symbol: string,
    message: string,
  ): Promise<Locator> {
    await this.scrollToSymbolComposer(page, symbol);

    const container = await this.resolveSymbolComposerContainer(page, symbol);
    if (!container) {
      throw new Error(`stocktwits_symbol_composer_not_found:${symbol}`);
    }

    await container.scrollIntoViewIfNeeded().catch(() => undefined);
    await this.activateSymbolComposerPlaceholder(page, symbol);
    await container
      .click({ position: { x: 140, y: 40 }, timeout: 2_500 })
      .catch(() => undefined);
    await page.waitForTimeout?.(180);

    // Stocktwits auto-prefixes the inline composer with "$SYMBOL " when it
    // expands. Clear that pre-fill so the post body is exactly what the
    // caller provided (which may already include its own cashtag).
    await page.keyboard.press('Control+A').catch(() => undefined);
    await page.keyboard.press('Backspace').catch(() => undefined);
    await page.waitForTimeout?.(120);

    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();
    await page.keyboard.type(normalizedMessage, { delay: 8 });
    await page.waitForTimeout?.(150);

    return container;
  }

  private async navigateToSymbolFeed(
    page: Page,
    postUrl: string,
    symbol: string,
  ): Promise<void> {
    await page.goto(this.resolveSymbolUrl(postUrl, symbol), {
      waitUntil: 'domcontentloaded',
    });
    await this.dismissCookieBanner(page);
    await page.waitForTimeout(900);
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

  private async resolveSymbolComposer(page: Page, symbol: string): Promise<Locator> {
    const cashtag = `$${symbol}`;
    await this.activateSymbolComposerPlaceholder(page, symbol);

    const scopedContainer = await this.resolveSymbolComposerContainer(page, symbol);
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
      pageWithLocator.locator(`form:has-text("Share your idea on ${cashtag}")`).first(),
      pageWithLocator.locator(`section:has-text("Share your idea on ${cashtag}")`).first(),
      pageWithLocator.locator(`article:has-text("Share your idea on ${cashtag}")`).first(),
      pageWithLocator.locator(`div:has-text("Share your idea on ${cashtag}")`).first(),
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

  private async scrollToSymbolComposer(page: Page, symbol: string): Promise<void> {
    const cashtag = `$${symbol}`;
    for (let i = 0; i < 10; i += 1) {
      const placeholder = await this.findSymbolComposerPlaceholder(page, symbol);
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

  private async fillComposer(composer: Locator, message: string): Promise<void> {
    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();

    await composer.waitFor({ state: 'visible', timeout: 4_000 });
    await composer.click({ timeout: 2_500 }).catch(() => undefined);
    await composer.press('Control+A').catch(() => undefined);
    await composer.press('Backspace').catch(() => undefined);

    await composer.fill(normalizedMessage, { timeout: 4_000 }).catch(async () => {
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
    await composer.type(normalizedMessage, { delay: 8, timeout: 5_000 }).catch(async () => {
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
        await this.ensureComposerContainsExpectedBody(composer, message, symbol);
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
      await container.click({ position: { x: 140, y: 40 }, timeout: 2_500 }).catch(() => undefined);
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
      throw new Error(
        'stocktwits_inline_post_button_not_found_or_disabled',
      );
    }
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
          ) as HTMLElement[];

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
                return el;
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
            findEditable((label) =>
              matches(label, ['Share your idea on']),
            );

          if (!composer) {
            for (const el of editableNodes) {
              const value =
                (el as HTMLTextAreaElement).value ||
                el.textContent ||
                '';
              if (value.replace(/\s+/g, '').length > 10) {
                composer = el;
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
            const buttons = Array.from(
              node.querySelectorAll('button'),
            ) as HTMLButtonElement[];
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim().toLowerCase();
              if (text !== 'post') continue;

              const isDisabled =
                btn.disabled ||
                btn.getAttribute('aria-disabled') === 'true';

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
      const visible = await candidate.isVisible({ timeout: 250 }).catch(() => false);
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

    const cleaned = value
      .replace(/\s+/g, '')
      .replace(/^\$/, '')
      .toUpperCase();
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

    const fallback = page.locator('button:has-text("Post without cashtag")').first();
    if (await fallback.isVisible().catch(() => false)) {
      await this.clickWithFallbacks(page, fallback, 'cashtag_modal_fallback');
      return;
    }

    throw new Error('stocktwits_cashtag_modal_detected_but_action_button_not_found');
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
        return Array.from(
          document.querySelectorAll('a[href*="/message/"]'),
        )
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
        return Array.from(
          document.querySelectorAll('a[href*="/message/"]'),
        )
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
          ) as HTMLAnchorElement[];
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

    await this.clickWithFallbacks(page, postButton, 'clickPostInDialogIfVisible');
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
        firstError instanceof Error ? firstError.message.split('\n')[0] : 'unknown';
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
    const symbolFromHref = hrefMatch ? normalizeStocktwitsSymbol(hrefMatch[1]) : null;
    if (symbolFromHref) {
      rankedCandidates.push({ rank, symbol: symbolFromHref });
      continue;
    }

    const tdMatches = Array.from(rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi));
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
    .filter((item): item is { rank: number; symbol: string } => item.symbol !== null)
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
  const cleaned = value
    .replace(/^\$/, '')
    .trim()
    .toUpperCase();

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
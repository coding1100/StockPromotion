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
};

type RankedSymbolCandidate = {
  rank: number;
  symbol: string;
};

const DEFAULT_TRENDING_SYMBOL_LIMIT = 10;

@Injectable()
export class StocktwitsPublisher {
  private readonly logger = new Logger(StocktwitsPublisher.name);

  constructor(private readonly configService: ConfigService) {}

  async bootstrapSession(account: StocktwitsAccountConfig): Promise<{
    authenticated: boolean;
    challengeVisible: boolean;
    userDataDir: string | null;
  }> {
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const manualLoginTimeoutMs =
      this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');
    const { context, page, userDataDir } = await this.createBrowserSession();

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

    const { context, page } = await this.createBrowserSession();
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

    const { context, page } = await this.createBrowserSession();
    const normalizedTarget = normalizeStocktwitsSymbol(targetSymbol ?? '');

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

      let externalPostId: string | null = null;
      if (normalizedTarget) {
        externalPostId = await this.postOnSymbolFeed(
          page,
          postUrl,
          normalizedTarget,
          message,
        );
      } else {
        await this.openPostDialog(page);
        const composer = await this.resolveComposer(page);
        await this.fillComposer(composer, message);
        await this.submitPost(page);
        await this.handlePostConfirmationModal(page);
        await this.finalizeDialogPost(page);
        externalPostId = await this.waitForPublishConfirmation(page, 15_000);
      }

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

  private async createBrowserSession(): Promise<{
    context: BrowserContext;
    page: Page;
    userDataDir: string;
  }> {
    const rawHeadless = this.configService.get('STOCKTWITS_HEADLESS');
    const isHeadless = rawHeadless === true || rawHeadless === 'true';

    const userDataDir =
      this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() ||
      join(process.cwd(), '.pw-stocktwits');
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
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, userDataDir };
  }

  private async performLoginIfNeeded(
    page: Page,
    account: StocktwitsAccountConfig,
    timeout: number,
  ): Promise<void> {
    if (await this.isAuthenticated(page)) {
      return;
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

  private async handlePossibleChallenge(page: Page, timeout: number): Promise<void> {
    if (!(await this.isChallengeVisible(page))) {
      return;
    }

    const headlessEnv = this.configService.get('STOCKTWITS_HEADLESS');
    const isHeadless = headlessEnv === true || headlessEnv === 'true';

    if (isHeadless) {
      throw new Error(
        'Cloudflare challenge detected in Headless mode. Set STOCKTWITS_HEADLESS=false to solve manually.',
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
    const content = (await page.content()).toLowerCase();
    return (
      content.includes('verify you are human') ||
      content.includes('cf-challenge') ||
      content.includes('security verification')
    );
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
    await this.submitInlineSymbolPost(page, composerScope);
    await this.handlePostConfirmationModal(page);
    await this.finalizeDialogPost(page);
    return this.waitForPublishConfirmation(page, 15_000);
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
    await page.waitForTimeout?.(120);

    const normalizedMessage = message.replace(/\r\n/g, '\n').trim();
    await page.keyboard.type(` ${normalizedMessage}`, { delay: 8 });
    await page.waitForTimeout?.(120);

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

    const dialog = page.locator('[role="dialog"]').last();
    if (await dialog.isVisible().catch(() => false)) {
      const dialogArea = await this.findFirstVisibleIn(dialog, [
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
    const symbolPattern = new RegExp(
      `Share\\s+your\\s+idea\\s+on\\s+\\$?${escapeRegExp(symbol)}`,
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
  ): Promise<void> {
    const clickedContainerButton =
      await this.clickPostButtonWithinComposerContainer(page, composer);
    if (clickedContainerButton) {
      return;
    }

    throw new Error('stocktwits_inline_post_button_not_found_or_disabled');
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

  private async clickPostButtonWithinComposerContainer(
    page: Page,
    composer: Locator,
  ): Promise<boolean> {
    const postButtonSelectors = [
      'button[class*="ButtonPost_desktop__"]',
      'button[class*="ButtonPost_mobile__"]',
      'button[class*="STButton_black-primary__"]',
      'button:has-text("Post")',
      'button[type="submit"]',
    ];

    const startedAt = Date.now();
    while (Date.now() - startedAt < 8_000) {
      const clickedDirect = await this.clickEnabledButtonInScope(
        composer,
        postButtonSelectors,
      );
      if (clickedDirect) {
        return true;
      }

      const container = composer
        .locator(
          'xpath=ancestor::*[self::form or self::section or self::article or self::div][.//button[contains(normalize-space(.), "Post") or @type="submit"]][1]',
        )
        .first();

      if (await container.isVisible().catch(() => false)) {
        const clickedInContainer = await this.clickEnabledButtonInScope(
          container,
          postButtonSelectors,
        );
        if (clickedInContainer) {
          return true;
        }
      }

      const clickedOnPage = await this.clickEnabledButtonOnPage(
        page,
        postButtonSelectors,
      );
      if (clickedOnPage) {
        return true;
      }

      const shortcutClicked = await this.tryKeyboardPostShortcut(page);
      if (shortcutClicked) {
        return true;
      }

      await page.waitForTimeout?.(250);
    }

    return false;
  }

  private async readLocatorText(locator: Locator): Promise<string> {
    return locator
      .evaluate((el) => (el as HTMLElement).innerText || el.textContent || '')
      .catch(() => '');
  }

  private async clickEnabledButtonInScope(
    scope: Locator,
    selectors: string[],
  ): Promise<boolean> {
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

        try {
          await button.click({ timeout: 2_000 });
          return true;
        } catch {
          try {
            await button.click({ timeout: 2_000, force: true });
            return true;
          } catch {
            continue;
          }
        }
      }
    }
    return false;
  }

  private async clickEnabledButtonOnPage(
    page: Page,
    selectors: string[],
  ): Promise<boolean> {
    for (const selector of selectors) {
      const candidates = page.locator(selector);
      const count = await candidates.count().catch(() => 0);
      for (let i = count - 1; i >= 0; i -= 1) {
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

        try {
          await button.click({ timeout: 2_000 });
          return true;
        } catch {
          try {
            await button.click({ timeout: 2_000, force: true });
            return true;
          } catch {
            continue;
          }
        }
      }
    }
    return false;
  }

  private async tryKeyboardPostShortcut(page: Page): Promise<boolean> {
    try {
      await page.keyboard.press('Control+Enter');
      return true;
    } catch {
      return false;
    }
  }

  private async clickClosestEnabledPostButton(
    page: Page,
    composer: Locator,
  ): Promise<boolean> {
    const composerBox = await composer.boundingBox().catch(() => null);
    if (!composerBox) {
      return false;
    }

    const composerCenterX = composerBox.x + composerBox.width / 2;
    const composerCenterY = composerBox.y + composerBox.height / 2;

    const buttons = page.locator('button:has-text("Post"), button[type="submit"]');
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
        .catch(() => false);
      if (disabled) {
        continue;
      }

      const box = await candidate.boundingBox().catch(() => null);
      if (!box) {
        continue;
      }

      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const distance = Math.hypot(centerX - composerCenterX, centerY - composerCenterY);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestButton = candidate;
      }
    }

    if (!bestButton) {
      return false;
    }

    await bestButton.click();
    return true;
  }

  private async submitPost(page: Page): Promise<void> {
    const dialog = page.locator('[role="dialog"]').last();
    if (await dialog.isVisible().catch(() => false)) {
      const dialogSubmit = await this.findFirstVisibleIn(dialog, [
        'button:has-text("Post")',
        'button[type="submit"]',
      ]);
      if (dialogSubmit) {
        await dialogSubmit.click();
        return;
      }
    }

    const button = await this.findFirstVisible(page, [
      'button:has-text("Post")',
      'button[type="submit"]',
    ]);
    if (!button) {
      throw new Error('Submit button not found.');
    }
    await button.click();
  }

  private async handlePostConfirmationModal(page: Page): Promise<void> {
    const modal = page
      .locator('[role="dialog"]')
      .filter({ hasText: 'Did you forget to use a $Cashtag?' })
      .first();

    if (!(await modal.isVisible().catch(() => false))) {
      return;
    }

    const postWithoutCashtag = modal
      .locator('button:has-text("Post without cashtag")')
      .first();
    if (await postWithoutCashtag.isVisible().catch(() => false)) {
      await postWithoutCashtag.click();
      return;
    }

    const fallback = page.locator('button:has-text("Post without cashtag")').first();
    if (await fallback.isVisible().catch(() => false)) {
      await fallback.click();
      return;
    }

    throw new Error('stocktwits_cashtag_modal_detected_but_action_button_not_found');
  }

  private async resolvePostId(page: Page): Promise<string | null> {
    const match = page.url().match(/\/message\/(\d+)/);
    if (match?.[1]) {
      return match[1];
    }

    const messageLink = page.locator('a[href*="/message/"]').first();
    if (await messageLink.isVisible().catch(() => false)) {
      const href = await messageLink.getAttribute('href');
      const hrefMatch = href?.match(/\/message\/(\d+)/);
      if (hrefMatch?.[1]) {
        return hrefMatch[1];
      }
    }

    return null;
  }

  private async waitForPublishConfirmation(
    page: Page,
    timeoutMs: number,
  ): Promise<string | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await this.clickPostInDialogIfVisible(page);
      const messageId = await this.resolvePostId(page);
      if (messageId) {
        return messageId;
      }
      await page.waitForTimeout(500);
    }
    return null;
  }

  private async openPostDialog(page: Page): Promise<void> {
    const dialog = page.locator('[role="dialog"]').last();
    if (await dialog.isVisible().catch(() => false)) {
      return;
    }

    const openPostButton = await this.findFirstVisible(page, ['button:has-text("Post")']);
    if (!openPostButton) {
      return;
    }
    await openPostButton.click();
    await page.waitForTimeout(1_200);
  }

  private async finalizeDialogPost(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const clicked = await this.clickPostInDialogIfVisible(page);
      if (!clicked) {
        return;
      }
      await page.waitForTimeout(700);
      const dialog = page.locator('[role="dialog"]').last();
      if (!(await dialog.isVisible().catch(() => false))) {
        return;
      }
    }
  }

  private async clickPostInDialogIfVisible(page: Page): Promise<boolean> {
    const dialog = page.locator('[role="dialog"]').last();
    if (!(await dialog.isVisible().catch(() => false))) {
      return false;
    }

    const postButton = await this.findFirstVisibleIn(dialog, [
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

    await postButton.click();
    return true;
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

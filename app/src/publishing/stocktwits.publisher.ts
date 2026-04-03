import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import {
  BrowserContext,
  Page,
  Locator,
  errors as playwrightErrors,
} from 'playwright';
// Using the extra-stealth wrappers
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Apply stealth plugin
chromium.use(StealthPlugin());

type StocktwitsAccountConfig = {
  username: string;
  password: string;
};

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
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');
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
    const userDataDir = this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() || '';
    
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

  async publish(
    account: StocktwitsAccountConfig,
    message: string,
    jobId: string,
  ): Promise<{ externalPostId: string; evidenceUri: string }> {
    const loginUrl = this.configService.getOrThrow<string>('STOCKTWITS_LOGIN_URL');
    const postUrl = this.configService.getOrThrow<string>('STOCKTWITS_POST_URL');
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>('STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS');
    
    const artifactsDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(artifactsDir, { recursive: true });
    const successImg = join(artifactsDir, `${jobId}.png`);
    const errorImg = join(artifactsDir, `${jobId}-error.png`);
    
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
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);

      await this.openPostDialog(page);
      const composer = await this.resolveComposer(page);
      await this.fillComposer(composer, message);
      await this.submitPost(page);
      await this.handlePostConfirmationModal(page);
      await this.finalizeDialogPost(page);

      const externalPostId = await this.waitForPublishConfirmation(page, 15000);
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
    // 1. Get the raw value (likely a string "false")
    const rawHeadless = this.configService.get('STOCKTWITS_HEADLESS');
    
    // 2. Explicitly convert to boolean. 
    // This handles: true (bool), "true" (string), false (bool), "false" (string)
    const isHeadless = rawHeadless === true || rawHeadless === 'true';
    
    const userDataDir = this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() || join(process.cwd(), '.pw-stocktwits');
    const browserBinary = this.configService.get<string>('STOCKTWITS_BROWSER_BINARY')?.trim() || '';

    // LOG THIS: Check your terminal for this line to see what it actually says
    this.logger.log(`DEBUG: STOCKTWITS_HEADLESS raw value is: ${rawHeadless} (type: ${typeof rawHeadless})`);
    this.logger.log(`DEBUG: Browser will launch with headless = ${isHeadless}`);

    await mkdir(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: isHeadless, // This MUST be a literal boolean
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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    });

    const page = context.pages()[0] ?? (await context.newPage());
    return { context, page, userDataDir };
  }
  private async performLoginIfNeeded(page: Page, account: StocktwitsAccountConfig, timeout: number): Promise<void> {
    if (await this.isAuthenticated(page)) return;

    const loginField = await this.findFirstVisible(page, ['input[name*="user[login]"]', 'input[placeholder*="Username"]']);
    const passwordField = await this.findFirstVisible(page, ['input[name*="user[password]"]', 'input[type="password"]']);

    if (!loginField || !passwordField) {
      await this.waitForAuthenticatedOrTimeout(page, timeout);
      return;
    }

    await loginField.fill(account.username);
    await passwordField.fill(account.password);

    const submit = await this.findFirstVisible(page, ['button[type="submit"]', 'button:has-text("Log In")']);
    if (submit) await submit.click();

    await page.waitForTimeout(2000);
    await this.handlePossibleChallenge(page, timeout);
  }

  private async handlePossibleChallenge(page: Page, timeout: number): Promise<void> {
    if (!(await this.isChallengeVisible(page))) return;

    const headlessEnv = this.configService.get('STOCKTWITS_HEADLESS');
    const isHeadless = headlessEnv === true || headlessEnv === 'true';

    if (isHeadless) {
      throw new Error('Cloudflare challenge detected in Headless mode. Set STOCKTWITS_HEADLESS=false to solve manually.');
    }

    const result = await this.waitForAuthenticatedOrTimeout(page, timeout);
    if (result === 'timed_out' && (await this.isChallengeVisible(page))) {
      throw new Error('Challenge not resolved within timeout.');
    }
  }

  private async waitForAuthenticatedOrTimeout(page: Page, timeout: number): Promise<'authenticated' | 'login_required' | 'timed_out'> {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await this.isAuthenticated(page)) return 'authenticated';
      if (!(await this.isChallengeVisible(page)) && (await this.hasLoginForm(page))) return 'login_required';
      await page.waitForTimeout(1000);
    }
    return 'timed_out';
  }

  private async isChallengeVisible(page: Page): Promise<boolean> {
    const content = (await page.content()).toLowerCase();
    return content.includes('verify you are human') || content.includes('cf-challenge') || content.includes('security verification');
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    if (await this.isChallengeVisible(page)) return false;
    if (/\/signin/i.test(page.url())) return false;
    const loginField = await this.findFirstVisible(page, ['input[name*="user[login]"]']);
    return !loginField;
  }

  private async hasLoginForm(page: Page): Promise<boolean> {
    const loginField = await this.findFirstVisible(page, ['input[name*="user[login]"]']);
    return Boolean(loginField);
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    const btns = ['button:has-text("Accept")', 'button:has-text("Agree")', 'button:has-text("OK")'];
    for (const s of btns) {
      const locator = page.locator(s).first();
      if (await locator.isVisible().catch(() => false)) await locator.click().catch(() => {});
    }
  }

  private async resolveComposer(page: Page): Promise<Locator> {
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
    if (modalArea) return modalArea;
    throw new Error('Composer not found.');
  }

  private async fillComposer(composer: Locator, message: string): Promise<void> {
    const tagName = await composer.evaluate((el) => el.tagName.toLowerCase());

    if (tagName === 'textarea') {
      await composer.fill(message);
      return;
    }

    // Avoid pointer click for DraftJS editors where placeholder/header can intercept.
    await composer.evaluate((el) => (el as HTMLElement).focus());
    await composer.press('Control+A').catch(() => undefined);
    await composer.press('Backspace').catch(() => undefined);

    await composer
      .type(message, { delay: 8 })
      .catch(async () => {
        await composer.fill(message).catch(async () => {
          await composer.evaluate((el, msg) => {
            (el as HTMLElement).textContent = msg;
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }, message);
        });
      });
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

    const btn = await this.findFirstVisible(page, [
      'button:has-text("Post")',
      'button[type="submit"]',
    ]);
    if (!btn) throw new Error('Submit button not found.');
    await btn.click();
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

    const openPostButton = await this.findFirstVisible(page, [
      'button:has-text("Post")',
    ]);
    if (!openPostButton) {
      return;
    }
    await openPostButton.click();
    await page.waitForTimeout(1200);
  }

  private async finalizeDialogPost(page: Page): Promise<void> {
    // Some StockTwits flows (for example after cashtag prompt) keep the composer
    // dialog open and require one more explicit Post click.
    for (let attempt = 0; attempt < 3; attempt++) {
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
      .evaluate((el) =>
        (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true',
      )
      .catch(() => false);
    if (disabled) {
      return false;
    }

    await postButton.click();
    return true;
  }

  private async findFirstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
    for (const s of selectors) {
      const loc = page.locator(s).first();
      try {
        if (await loc.isVisible({ timeout: 1500 })) return loc;
      } catch {}
    }
    return null;
  }

  private async findFirstVisibleIn(scope: Locator, selectors: string[]): Promise<Locator | null> {
    for (const s of selectors) {
      const loc = scope.locator(s).first();
      try {
        if (await loc.isVisible({ timeout: 1500 })) return loc;
      } catch {}
    }
    return null;
  }
}

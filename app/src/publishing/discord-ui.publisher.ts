import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { BrowserContext, Locator, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

chromium.use(StealthPlugin());

type DiscordUiChannelResult = {
  channelId: string;
  channelUrl: string;
  channelName: string;
  posted: boolean;
  skipped: boolean;
  reason: string | null;
};

@Injectable()
export class DiscordUiPublisher {
  private readonly logger = new Logger(DiscordUiPublisher.name);

  constructor(private readonly configService: ConfigService) {}

  async broadcastToWritableChannels(input: {
    serverUrl: string;
    message: string;
  }): Promise<{
    guildId: string;
    channelCount: number;
    postedCount: number;
    skippedCount: number;
    failedCount: number;
    channels: DiscordUiChannelResult[];
  }> {
    const runId = `discord-ui-${Date.now()}`;
    const normalizedMessage = input.message.trim();
    if (!normalizedMessage) {
      throw new Error('discord_ui_message_empty');
    }

    const serverUrl = input.serverUrl.trim();
    const guildId = this.extractGuildId(serverUrl);
    if (!guildId) {
      throw new Error('discord_ui_server_url_invalid');
    }

    const { context, page } = await this.createBrowserSession();
    try {
      await page.goto(serverUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });

      await this.ensureLoggedIn(page);
      // After login, the URL may be /channels/@me — re-navigate to the target guild.
      if (!page.url().includes(`/channels/${guildId}`)) {
        await page.goto(serverUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
        });
      }

      const channels = await this.collectGuildChannelsWithAuthRecovery(
        page,
        guildId,
        serverUrl,
      );

      const results: DiscordUiChannelResult[] = [];
      for (let index = 0; index < channels.length; index += 1) {
        const channel = channels[index];
        const row = await this.tryPostInChannel(page, {
          channelId: channel.channelId,
          channelName: channel.channelName,
          channelUrl: channel.channelUrl,
          message: normalizedMessage,
        });
        results.push(row);

        if (index < channels.length - 1) {
          const delay = this.randomInterChannelDelayMs();
          this.logger.debug(
            `Discord inter-channel pause: ${delay}ms before next channel`,
          );
          await page.waitForTimeout(delay);
        }
      }

      const postedCount = results.filter((row) => row.posted).length;
      const skippedCount = results.filter((row) => row.skipped).length;
      const failedCount = results.filter(
        (row) => !row.posted && !row.skipped,
      ).length;

      return {
        guildId,
        channelCount: results.length,
        postedCount,
        skippedCount,
        failedCount,
        channels: results,
      };
    } catch (error) {
      const baseReason =
        error instanceof Error ? error.message : 'discord_ui_publish_failed';
      const evidenceUri = await this.captureScreenshot(
        page,
        `${runId}-fatal-error`,
      );

      if (evidenceUri) {
        throw new Error(`${baseReason} | evidence:${evidenceUri}`);
      }
      throw error;
    } finally {
      await context.close();
    }
  }

  private get navigationTimeoutMs(): number {
    return (
      this.configService.get<number>('DISCORD_UI_NAV_TIMEOUT_MS') || 30_000
    );
  }

  private get postDelayMs(): number {
    return this.configService.get<number>('DISCORD_UI_POST_DELAY_MS') || 800;
  }

  private get manualLoginTimeoutMs(): number {
    return (
      this.configService.get<number>('DISCORD_UI_MANUAL_LOGIN_TIMEOUT_MS') ||
      120_000
    );
  }

  private get isHeadless(): boolean {
    const rawHeadless = this.configService.get('DISCORD_UI_HEADLESS');
    return rawHeadless === true || rawHeadless === 'true';
  }

  private get postConfirmationTimeoutMs(): number {
    return (
      this.configService.get<number>('DISCORD_UI_POST_CONFIRM_TIMEOUT_MS') ||
      8_000
    );
  }

  private randomInterChannelDelayMs(): number {
    const min =
      this.configService.get<number>('DISCORD_UI_INTER_CHANNEL_DELAY_MIN_MS') ??
      2_000;
    const max =
      this.configService.get<number>('DISCORD_UI_INTER_CHANNEL_DELAY_MAX_MS') ??
      5_000;
    if (max <= min) {
      return Math.max(0, min);
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private get loginEmail(): string {
    return (
      this.configService.get<string>('DISCORD_UI_LOGIN_EMAIL')?.trim() || ''
    );
  }

  private get loginPassword(): string {
    return (
      this.configService.get<string>('DISCORD_UI_LOGIN_PASSWORD')?.trim() || ''
    );
  }

  private extractGuildId(url: string): string | null {
    const match = url.match(
      /^https:\/\/discord\.com\/channels\/(\d{15,25})(?:\/\d{15,25})?/i,
    );
    return match?.[1] || null;
  }

  private async createBrowserSession(): Promise<{
    context: BrowserContext;
    page: Page;
  }> {
    const configuredUserDataDir =
      this.configService.get<string>('DISCORD_UI_USER_DATA_DIR')?.trim() || '';
    const userDataDir = this.resolveDiscordUserDataDir(configuredUserDataDir);
    const configuredBrowserBinary =
      this.configService.get<string>('DISCORD_UI_BROWSER_BINARY')?.trim() || '';
    const browserBinary = this.resolveDiscordBrowserBinary(
      configuredBrowserBinary,
    );

    await mkdir(userDataDir, { recursive: true });

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: this.isHeadless,
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

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(this.navigationTimeoutMs);
    return { context, page };
  }

  private resolveDiscordUserDataDir(configuredPath: string): string {
    const defaultPath = join(process.cwd(), '.pw-discord-chromium');
    if (!configuredPath) {
      return defaultPath;
    }

    const normalized = configuredPath.replace(/\//g, '\\').toLowerCase();
    const isChromeProfile = normalized.includes('\\google\\chrome\\user data');
    if (isChromeProfile) {
      this.logger.warn(
        'DISCORD_UI_USER_DATA_DIR points to Chrome profile. Using isolated Chromium profile instead.',
      );
      return defaultPath;
    }

    return configuredPath;
  }

  private resolveDiscordBrowserBinary(configuredPath: string): string {
    if (!configuredPath) {
      return '';
    }

    const normalized = configuredPath.replace(/\//g, '\\').toLowerCase();
    const looksLikeSystemChrome =
      normalized.includes('\\google\\chrome\\application\\chrome.exe') ||
      normalized.endsWith('\\chrome.exe');
    if (looksLikeSystemChrome) {
      this.logger.warn(
        'DISCORD_UI_BROWSER_BINARY points to Chrome. Using Playwright Chromium instead.',
      );
      return '';
    }

    return configuredPath;
  }

  private async ensureLoggedIn(page: Page): Promise<void> {
    const loginRequired = await this.isLoginRequired(page);
    if (!loginRequired) {
      return;
    }

    await this.loginWithCredentials(page);
    if (await this.isLoginRequired(page)) {
      throw new Error('discord_ui_login_required_after_login_attempt');
    }
  }

  private async isLoginRequired(page: Page): Promise<boolean> {
    if (page.url().includes('/login')) {
      return true;
    }

    const loginUiDetected = await this.hasLoginUi(page);
    if (loginUiDetected) {
      return true;
    }

    const emailInput = page
      .locator('input[name="email"], input[type="email"]')
      .first();
    return emailInput.isVisible({ timeout: 2500 }).catch(() => false);
  }

  private async hasLoginUi(page: Page): Promise<boolean> {
    return page
      .evaluate(() => {
        const emailInput = document.querySelector(
          'input[name="email"], input[type="email"]',
        );
        const passwordInput = document.querySelector(
          'input[name="password"], input[type="password"]',
        );
        const submitButton = document.querySelector('button[type="submit"]');

        if (emailInput && passwordInput && submitButton) {
          return true;
        }

        const pageText = (document.body?.innerText || '').toLowerCase();
        return (
          pageText.includes('welcome back') &&
          pageText.includes('log in') &&
          pageText.includes('email or phone number')
        );
      })
      .catch(() => false);
  }

  private async loginWithCredentials(page: Page): Promise<void> {
    const email = this.loginEmail;
    const password = this.loginPassword;
    if (!email || !password) {
      throw new Error('discord_ui_login_required_missing_credentials');
    }

    this.logger.log(
      'Discord session not found. Attempting login with configured credentials.',
    );

    try {
      if (!page.url().includes('/login')) {
        await page.goto('https://discord.com/login', {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
        });
      }

      await this.waitForLoginPageReady(page);

      const emailInput = await this.findFirstVisible(page, [
        'input[name="email"]',
        'input[type="email"]',
        'input[autocomplete="username"]',
        'input[aria-label*="Email"]',
        'input[aria-label*="Phone"]',
        'input[placeholder*="Email"]',
        'input[placeholder*="Phone"]',
        'input[type="text"]',
      ]);
      const passwordInput = await this.findFirstVisible(page, [
        'input[name="password"]',
        'input[type="password"]',
        'input[autocomplete="current-password"]',
      ]);
      const submitButton = await this.findFirstVisible(page, [
        'button[type="submit"]',
        'button:has-text("Log In")',
        'button:has-text("Login")',
      ]);

      if (!emailInput || !passwordInput || !submitButton) {
        throw new Error('discord_ui_login_form_not_found');
      }

      await this.fillAndVerifyLoginInput(page, emailInput, email, false);
      await this.fillAndVerifyLoginInput(page, passwordInput, password, true);

      await submitButton.click().catch(async () => {
        await submitButton.click({ force: true });
      });

      await this.waitForLoginOutcome(page);
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'discord_ui_login_failed';
      const evidenceUri = await this.captureScreenshot(
        page,
        `discord-ui-login-error-${Date.now()}`,
      );
      if (evidenceUri) {
        throw new Error(`${reason} | evidence:${evidenceUri}`);
      }
      throw error;
    }
  }

  private async waitForLoginPageReady(page: Page): Promise<void> {
    // Discord login UI can hydrate late; keep a fixed settle delay before locating inputs.
    await page.waitForTimeout(10_000);

    const emailInput = page
      .locator('input[name="email"], input[type="email"]')
      .first();
    const passwordInput = page
      .locator('input[name="password"], input[type="password"]')
      .first();

    await emailInput
      .waitFor({ state: 'attached', timeout: this.navigationTimeoutMs })
      .catch(() => undefined);
    await passwordInput
      .waitFor({ state: 'attached', timeout: this.navigationTimeoutMs })
      .catch(() => undefined);
  }

  private async fillAndVerifyLoginInput(
    page: Page,
    input: Locator,
    value: string,
    isPassword: boolean,
  ): Promise<void> {
    const matchesValue = async (): Promise<boolean> => {
      const currentValue = await this.readInputValue(input);
      if (!currentValue) {
        return false;
      }
      if (isPassword) {
        return currentValue.length === value.length;
      }
      return currentValue.trim().toLowerCase() === value.trim().toLowerCase();
    };

    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    await input.click({ timeout: 3_000 }).catch(() => undefined);
    await input.fill(value).catch(() => undefined);
    if (await matchesValue()) {
      return;
    }

    await input.click({ timeout: 3_000 }).catch(() => undefined);
    await page.keyboard.press('Control+A').catch(() => undefined);
    await page.keyboard.press('Backspace').catch(() => undefined);
    await page.keyboard.type(value, { delay: 10 }).catch(() => undefined);
    if (await matchesValue()) {
      return;
    }

    await input
      .evaluate((el, rawValue) => {
        const element = el as HTMLInputElement;
        const nextValue = String(rawValue);
        const prototype = Object.getPrototypeOf(element);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        descriptor?.set?.call(element, nextValue);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
      }, value)
      .catch(() => undefined);

    if (await matchesValue()) {
      return;
    }

    throw new Error(
      isPassword
        ? 'discord_ui_login_password_fill_failed'
        : 'discord_ui_login_email_fill_failed',
    );
  }

  private async readInputValue(input: Locator): Promise<string> {
    const viaInputValue = await input.inputValue().catch(() => '');
    if (viaInputValue) {
      return viaInputValue;
    }

    return input
      .evaluate((el) => (el as HTMLInputElement).value || '')
      .catch(() => '');
  }

  private async waitForLoginOutcome(page: Page): Promise<void> {
    const timeoutMs = Math.max(this.navigationTimeoutMs, 45_000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (!(await this.isLoginRequired(page))) {
        return;
      }

      if (await this.has2FACodeField(page)) {
        // 2FA code can't be solved by a captcha service. Wait for manual entry
        // (headed) or fail clearly (headless).
        const resolved = await this.waitForManualLogin(page, 'challenge');
        if (resolved) {
          return;
        }
        throw new Error('discord_ui_login_2fa_required');
      }

      if (await this.hasHCaptchaChallenge(page)) {
        const solved = await this.tryAutoSolveHCaptcha(page);
        if (solved) {
          await page.waitForTimeout(2_000);
          if (!(await this.isLoginRequired(page))) {
            return;
          }
        }
        const resolved = await this.waitForManualLogin(page, 'challenge');
        if (resolved) {
          return;
        }
        throw new Error('discord_ui_login_challenge_required');
      }

      if (await this.hasLoginChallenge(page)) {
        const resolved = await this.waitForManualLogin(page, 'challenge');
        if (resolved) {
          return;
        }
        throw new Error('discord_ui_login_challenge_required');
      }

      if (await this.hasInvalidCredentialsNotice(page)) {
        throw new Error('discord_ui_login_credentials_invalid');
      }

      await page.waitForTimeout(350);
    }

    const resolved = await this.waitForManualLogin(page, 'timeout');
    if (resolved) {
      return;
    }

    throw new Error('discord_ui_login_timeout');
  }

  private async has2FACodeField(page: Page): Promise<boolean> {
    return page
      .locator('input[name="code"], input[autocomplete="one-time-code"]')
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
  }

  private async hasHCaptchaChallenge(page: Page): Promise<boolean> {
    const selectors = [
      'iframe[src*="hcaptcha.com"]',
      'iframe[title*="hCaptcha" i]',
      'iframe[title*="CAPTCHA" i]',
    ];
    for (const selector of selectors) {
      const visible = await page
        .locator(selector)
        .first()
        .isVisible({ timeout: 200 })
        .catch(() => false);
      if (visible) {
        return true;
      }
    }
    return false;
  }

  private async tryAutoSolveHCaptcha(page: Page): Promise<boolean> {
    const apiKey = this.configService.get<string>('CAPSOLVER_API_KEY')?.trim();
    if (!apiKey) {
      this.logger.warn(
        'Discord hCaptcha detected but CAPSOLVER_API_KEY is not configured. Falling back to manual.',
      );
      return false;
    }

    const captchaInfo = await page
      .evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = iframe.getAttribute('src') || '';
          const sitekeyMatch = src.match(/sitekey=([0-9a-fA-F-]{8,})/);
          if (sitekeyMatch) {
            return { sitekey: sitekeyMatch[1] };
          }
        }
        const el =
          document.querySelector('[data-sitekey]') ||
          document.querySelector('.h-captcha[data-sitekey]');
        const sitekey = el?.getAttribute('data-sitekey') ?? null;
        return sitekey ? { sitekey } : null;
      })
      .catch(() => null);

    if (!captchaInfo?.sitekey) {
      this.logger.warn(
        'Discord hCaptcha detected but sitekey could not be extracted. Falling back to manual.',
      );
      return false;
    }

    this.logger.log(
      `Discord hCaptcha detected. Submitting to CapSolver (sitekey=${captchaInfo.sitekey})`,
    );

    let token: string | null = null;
    try {
      const taskId = await this.createCapSolverHCaptchaTask(
        apiKey,
        captchaInfo.sitekey,
        page.url(),
      );
      token = await this.pollCapSolverHCaptchaResult(apiKey, taskId, 120_000);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      this.logger.error(`CapSolver hCaptcha solving failed: ${reason}`);
      return false;
    }

    if (!token) {
      return false;
    }

    const injected = await page
      .evaluate((capToken) => {
        const textareas = document.querySelectorAll(
          'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]',
        );
        if (textareas.length === 0) {
          return false;
        }
        textareas.forEach((ta) => {
          const node = ta as HTMLTextAreaElement;
          node.value = capToken;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        });
        // Discord listens to hCaptcha widget callbacks; if a global is exposed,
        // call it. Otherwise the textarea write is the best we can do without
        // patching hcaptcha.render before it ran.
        const cb = (
          window as unknown as { __hcaptchaCallback?: (t: string) => void }
        ).__hcaptchaCallback;
        if (typeof cb === 'function') {
          try {
            cb(capToken);
          } catch {
            /* ignore */
          }
        }
        return true;
      }, token)
      .catch(() => false);

    if (!injected) {
      this.logger.warn(
        'CapSolver returned an hCaptcha token but the response textarea was not present. Falling back to manual.',
      );
      return false;
    }

    return true;
  }

  private async createCapSolverHCaptchaTask(
    apiKey: string,
    sitekey: string,
    pageUrl: string,
  ): Promise<string> {
    const response = await fetch('https://api.capsolver.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: apiKey,
        task: {
          type: 'HCaptchaTaskProxyless',
          websiteURL: pageUrl,
          websiteKey: sitekey,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`capsolver_createTask_http_${response.status}`);
    }
    const data = (await response.json()) as {
      errorId: number;
      errorCode?: string;
      errorDescription?: string;
      taskId?: string;
    };
    if (data.errorId !== 0) {
      throw new Error(
        `capsolver_createTask_${data.errorCode}: ${data.errorDescription}`,
      );
    }
    if (!data.taskId) {
      throw new Error('capsolver_createTask_missing_taskId');
    }
    return data.taskId;
  }

  private async pollCapSolverHCaptchaResult(
    apiKey: string,
    taskId: string,
    maxWaitMs: number,
  ): Promise<string | null> {
    const startedAt = Date.now();
    const pollIntervalMs = 1_000;

    while (Date.now() - startedAt < maxWaitMs) {
      const response = await fetch('https://api.capsolver.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      if (!response.ok) {
        throw new Error(`capsolver_getTaskResult_http_${response.status}`);
      }
      const data = (await response.json()) as {
        errorId: number;
        errorCode?: string;
        errorDescription?: string;
        status?: 'idle' | 'processing' | 'ready' | 'failed';
        solution?: { gRecaptchaResponse?: string };
      };

      if (data.errorId !== 0) {
        throw new Error(
          `capsolver_getTaskResult_${data.errorCode}: ${data.errorDescription}`,
        );
      }
      if (data.status === 'ready') {
        return data.solution?.gRecaptchaResponse ?? null;
      }
      if (data.status === 'failed') {
        throw new Error(
          `capsolver_task_failed: ${data.errorCode} - ${data.errorDescription}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`capsolver_task_timeout_${maxWaitMs}ms`);
  }

  private async waitForManualLogin(
    page: Page,
    reason: 'challenge' | 'timeout',
  ): Promise<boolean> {
    if (this.isHeadless) {
      return false;
    }

    this.logger.warn(
      `Discord login ${reason} detected. Waiting up to ${this.manualLoginTimeoutMs}ms for manual login in the opened Chromium window.`,
    );

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.manualLoginTimeoutMs) {
      if (!(await this.isLoginRequired(page))) {
        return true;
      }
      await page.waitForTimeout(500);
    }

    return false;
  }

  private async hasLoginChallenge(page: Page): Promise<boolean> {
    const challengeSelectors = [
      'iframe[title*="CAPTCHA"]',
      'iframe[src*="captcha"]',
      'input[name="code"]',
    ];

    for (const selector of challengeSelectors) {
      const challenge = page.locator(selector).first();
      const visible = await challenge
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (visible) {
        return true;
      }
    }

    const challengeCopy = page.getByText(
      /two-factor|authentication code|check your email|verify|verify it's you|suspicious login|security/i,
    );
    return challengeCopy.isVisible({ timeout: 250 }).catch(() => false);
  }

  private async hasInvalidCredentialsNotice(page: Page): Promise<boolean> {
    const invalidNotice = page.getByText(
      /login or password is invalid|invalid login credentials|incorrect password/i,
    );
    return invalidNotice.isVisible({ timeout: 250 }).catch(() => false);
  }

  private async collectGuildChannels(
    page: Page,
    guildId: string,
  ): Promise<
    Array<{
      channelId: string;
      channelName: string;
      channelUrl: string;
    }>
  > {
    if (await this.isLoginRequired(page)) {
      throw new Error('discord_ui_login_required_before_channel_discovery');
    }

    const domRows = await this.collectGuildChannelsFromDom(page, guildId);
    if (domRows.length > 0) {
      return domRows;
    }

    const apiRows = await this.collectGuildChannelsFromApi(page, guildId);
    if (apiRows.length > 0) {
      return apiRows;
    }

    const urlChannelId = this.extractChannelIdFromGuildUrl(page.url(), guildId);
    if (urlChannelId) {
      this.logger.warn(
        `Discord channel discovery fallback: using current channel only (${urlChannelId}).`,
      );
      return [
        {
          channelId: urlChannelId,
          channelName: `channel-${urlChannelId}`,
          channelUrl: `https://discord.com/channels/${guildId}/${urlChannelId}`,
        },
      ];
    }

    throw new Error('discord_ui_channels_not_found');
  }

  private async collectGuildChannelsWithAuthRecovery(
    page: Page,
    guildId: string,
    serverUrl: string,
  ): Promise<
    Array<{
      channelId: string;
      channelName: string;
      channelUrl: string;
    }>
  > {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.collectGuildChannels(page, guildId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : 'discord_ui_channels_not_found';
        const isAuthError = message.startsWith('discord_ui_login_required');
        if (!isAuthError || attempt === maxAttempts) {
          throw error;
        }

        this.logger.warn(
          `Discord auth dropped during channel discovery (${message}). Retrying authentication (${attempt}/${maxAttempts - 1})...`,
        );

        await this.ensureLoggedIn(page);
        await page.goto(serverUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
        });
        await page.waitForTimeout(800);
      }
    }

    throw new Error('discord_ui_channels_not_found');
  }

  private async collectGuildChannelsFromDom(
    page: Page,
    guildId: string,
  ): Promise<
    Array<{
      channelId: string;
      channelName: string;
      channelUrl: string;
    }>
  > {
    const timeoutAt = Date.now() + this.navigationTimeoutMs;
    while (Date.now() < timeoutAt) {
      if (await this.isLoginRequired(page)) {
        throw new Error('discord_ui_login_required_during_dom_channel_scan');
      }

      const rows = await page.evaluate((resolvedGuildId) => {
        const normalize = (href: string): string => {
          if (!href) {
            return '';
          }
          if (href.startsWith('http')) {
            return href.replace(/^https:\/\/discord\.com/i, '');
          }
          return href;
        };

        const seen = new Set<string>();
        const output: Array<{
          channelId: string;
          channelName: string;
          channelUrl: string;
        }> = [];

        const pushRow = (
          channelId: string,
          channelName: string,
          href: string,
        ) => {
          if (!/^\d{15,25}$/.test(channelId) || seen.has(channelId)) {
            return;
          }
          seen.add(channelId);
          output.push({
            channelId,
            channelName: channelName || `channel-${channelId}`,
            channelUrl: `https://discord.com${href}`,
          });
        };

        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('a[href]'),
        );
        for (const anchor of anchors) {
          const normalizedHref = normalize(
            anchor.getAttribute('href') || anchor.href || '',
          );
          if (!normalizedHref.startsWith(`/channels/${resolvedGuildId}/`)) {
            continue;
          }
          const parts = normalizedHref.split('/').filter(Boolean);
          if (parts.length < 3) {
            continue;
          }
          const channelId = parts[2];
          const channelName = (anchor.textContent || '').trim();
          pushRow(channelId, channelName, normalizedHref);
        }

        const channelRows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-list-item-id]'),
        );
        for (const row of channelRows) {
          const itemId = row.getAttribute('data-list-item-id') || '';
          const match =
            itemId.match(/channels___(\d+)$/) ||
            itemId.match(/channels___guilds\/\d+\/(\d+)$/);
          const channelId = match?.[1] || '';
          if (!/^\d{15,25}$/.test(channelId)) {
            continue;
          }
          const label =
            row.getAttribute('aria-label')?.trim() ||
            row.textContent?.trim() ||
            '';
          pushRow(
            channelId,
            label,
            `/channels/${resolvedGuildId}/${channelId}`,
          );
        }

        return output;
      }, guildId);

      if (rows.length > 0) {
        return rows;
      }

      await page.waitForTimeout(400);
    }

    return [];
  }

  private async collectGuildChannelsFromApi(
    page: Page,
    guildId: string,
  ): Promise<
    Array<{
      channelId: string;
      channelName: string;
      channelUrl: string;
    }>
  > {
    try {
      const rows = await page.evaluate(async (resolvedGuildId) => {
        const rawToken = (() => {
          try {
            const storage = window.localStorage;
            if (!storage || typeof storage.getItem !== 'function') {
              return null;
            }
            return storage.getItem('token');
          } catch {
            return null;
          }
        })();
        if (!rawToken) {
          return [];
        }

        const token =
          rawToken.startsWith('"') && rawToken.endsWith('"')
            ? rawToken.slice(1, -1)
            : rawToken;

        const response = await fetch(
          `https://discord.com/api/v9/guilds/${resolvedGuildId}/channels`,
          {
            headers: {
              authorization: token,
            },
          },
        );
        if (!response.ok) {
          return [];
        }

        const payload = await response.json();
        if (!Array.isArray(payload)) {
          return [];
        }

        return payload
          .filter((item) => {
            if (!item || typeof item !== 'object') {
              return false;
            }
            const row = item as Record<string, unknown>;
            const id = typeof row.id === 'string' ? row.id : '';
            const type = typeof row.type === 'number' ? row.type : -1;
            // Only standard text channels (0). Announcement channels (5) usually
            // require Manage Webhooks; sending there fails and burns rate budget.
            return /^\d{15,25}$/.test(id) && type === 0;
          })
          .sort((a, b) => {
            const rowA = a as Record<string, unknown>;
            const rowB = b as Record<string, unknown>;
            const positionA =
              typeof rowA.position === 'number' ? rowA.position : 0;
            const positionB =
              typeof rowB.position === 'number' ? rowB.position : 0;
            return positionA - positionB;
          })
          .map((item) => {
            const row = item as Record<string, unknown>;
            const channelId = row.id as string;
            const channelName =
              typeof row.name === 'string' && row.name.trim().length > 0
                ? row.name.trim()
                : `channel-${channelId}`;
            return {
              channelId,
              channelName,
              channelUrl: `https://discord.com/channels/${resolvedGuildId}/${channelId}`,
            };
          });
      }, guildId);

      if (rows.length > 0) {
        this.logger.log(
          `Discord channel discovery via API fallback: ${rows.length} channels.`,
        );
      }
      return rows;
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : 'discord_ui_channel_api_failed';
      this.logger.warn(`Discord API channel discovery failed: ${reason}`);
      return [];
    }
  }

  private extractChannelIdFromGuildUrl(
    url: string,
    guildId: string,
  ): string | null {
    const regex = new RegExp(`/channels/${guildId}/(\\d{15,25})`, 'i');
    const match = url.match(regex);
    return match?.[1] || null;
  }

  private async tryPostInChannel(
    page: Page,
    input: {
      channelId: string;
      channelName: string;
      channelUrl: string;
      message: string;
    },
  ): Promise<DiscordUiChannelResult> {
    try {
      await page.goto(input.channelUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
      await page.waitForTimeout(1200);

      if (await this.hasReadOnlyNotice(page)) {
        return {
          channelId: input.channelId,
          channelName: input.channelName,
          channelUrl: input.channelUrl,
          posted: false,
          skipped: true,
          reason: 'discord_ui_channel_read_only',
        };
      }

      const composer = await this.waitForComposer(page, 10_000);
      if (!composer) {
        return {
          channelId: input.channelId,
          channelName: input.channelName,
          channelUrl: input.channelUrl,
          posted: false,
          skipped: true,
          reason: 'discord_ui_composer_not_visible',
        };
      }

      // Pre-check: slowmode visible before we even type? Skip rather than wait,
      // so the run isn't blocked by a long cooldown timer.
      if (await this.hasSlowmodeOrRateLimitNotice(page)) {
        return {
          channelId: input.channelId,
          channelName: input.channelName,
          channelUrl: input.channelUrl,
          posted: false,
          skipped: true,
          reason: 'discord_ui_slowmode_or_rate_limited',
        };
      }

      await composer.click();
      await this.typeMultilineMessage(page, input.message);
      await page.keyboard.press('Enter');

      // Post-send verification: did the message actually land?
      const confirmation = await this.confirmMessageSent(
        page,
        composer,
        input.message,
        this.postConfirmationTimeoutMs,
      );

      if (!confirmation.sent) {
        const skipReasons = new Set(['discord_ui_slowmode_or_rate_limited']);
        const skipped = skipReasons.has(confirmation.reason ?? '');
        return {
          channelId: input.channelId,
          channelName: input.channelName,
          channelUrl: input.channelUrl,
          posted: false,
          skipped,
          reason: confirmation.reason ?? 'discord_ui_post_not_confirmed',
        };
      }

      await page.waitForTimeout(this.postDelayMs);

      return {
        channelId: input.channelId,
        channelName: input.channelName,
        channelUrl: input.channelUrl,
        posted: true,
        skipped: false,
        reason: null,
      };
    } catch (error) {
      const baseReason =
        error instanceof Error ? error.message : 'discord_ui_post_failed';
      const evidenceUri = await this.captureScreenshot(
        page,
        `discord-ui-channel-${input.channelId}-error-${Date.now()}`,
      );
      const reason = evidenceUri
        ? `${baseReason} | evidence:${evidenceUri}`
        : baseReason;
      this.logger.warn(
        `Discord UI post failed for ${input.channelId}: ${reason}`,
      );
      return {
        channelId: input.channelId,
        channelName: input.channelName,
        channelUrl: input.channelUrl,
        posted: false,
        skipped: false,
        reason,
      };
    }
  }

  private async typeMultilineMessage(
    page: Page,
    message: string,
  ): Promise<void> {
    const lines = message.replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].length > 0) {
        await page.keyboard.type(lines[i], { delay: 6 });
      }
      if (i < lines.length - 1) {
        // Shift+Enter inserts a soft line break inside the composer
        // without sending the message.
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
      }
    }
  }

  private async hasSlowmodeOrRateLimitNotice(page: Page): Promise<boolean> {
    const noticePatterns = [
      /you are sending messages too quickly/i,
      /slowmode is enabled/i,
      /you are being rate limited/i,
      /you must wait \d+/i,
      /please wait \d+ seconds before sending another message/i,
    ];
    for (const pattern of noticePatterns) {
      const visible = await page
        .getByText(pattern)
        .first()
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (visible) {
        return true;
      }
    }
    return false;
  }

  private extractMessageProbe(message: string): string {
    return message
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  private async readComposerInnerText(composer: Locator): Promise<string> {
    return composer
      .evaluate((el) => (el as HTMLElement).innerText || el.textContent || '')
      .catch(() => '');
  }

  private async confirmMessageSent(
    page: Page,
    composer: Locator,
    message: string,
    timeoutMs: number,
  ): Promise<{ sent: boolean; reason?: string }> {
    const probe = this.extractMessageProbe(message);
    if (!probe) {
      // Empty/whitespace messages can't be verified — treat as sent so we
      // don't introduce regressions on edge cases.
      return { sent: true };
    }

    const startedAt = Date.now();
    let composerCleared = false;

    while (Date.now() - startedAt < timeoutMs) {
      if (await this.hasSlowmodeOrRateLimitNotice(page)) {
        return { sent: false, reason: 'discord_ui_slowmode_or_rate_limited' };
      }

      if (!composerCleared) {
        const composerText = (await this.readComposerInnerText(composer))
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!composerText.includes(probe.toLowerCase())) {
          composerCleared = true;
        }
      }

      if (composerCleared) {
        const found = await page
          .evaluate((needle) => {
            const text = (document.body?.innerText || '').toLowerCase();
            return text.includes(needle);
          }, probe.toLowerCase())
          .catch(() => false);
        if (found) {
          return { sent: true };
        }
      }

      await page.waitForTimeout(300);
    }

    return { sent: false, reason: 'discord_ui_post_not_confirmed' };
  }

  private async captureScreenshot(
    page: Page,
    fileStem: string,
  ): Promise<string | null> {
    try {
      const artifactsDir = join(process.cwd(), 'artifacts', 'discord');
      await mkdir(artifactsDir, { recursive: true });
      const sanitizedStem = fileStem.replace(/[^a-zA-Z0-9-_]/g, '_');
      const filePath = join(artifactsDir, `${sanitizedStem}.png`);
      await page.screenshot({ path: filePath, fullPage: true });
      return filePath;
    } catch {
      this.logger.warn('Failed to capture Discord UI screenshot.');
      return null;
    }
  }

  private async findFirstVisible(
    page: Page,
    selectors: string[],
  ): Promise<Locator | null> {
    for (const selector of selectors) {
      const matches = page.locator(selector);
      const count = await matches.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = matches.nth(index);
        const isVisible = await candidate
          .isVisible({ timeout: 600 })
          .catch(() => false);
        if (!isVisible) {
          continue;
        }

        const isEnabled = await candidate
          .evaluate((el) => {
            const disabled =
              (el as HTMLInputElement | HTMLButtonElement).disabled ||
              el.getAttribute('aria-disabled') === 'true';
            return !disabled;
          })
          .catch(() => false);
        if (!isEnabled) {
          continue;
        }

        return candidate;
      }
    }

    return null;
  }

  private async hasReadOnlyNotice(page: Page): Promise<boolean> {
    const readOnlyNotice = page.getByText(
      /You do not have permission to send messages in this channel/i,
    );
    return readOnlyNotice.isVisible({ timeout: 1500 }).catch(() => false);
  }

  private async findComposer(
    page: Page,
  ): Promise<ReturnType<Page['locator']> | null> {
    const selectors = [
      'div[role="textbox"][data-slate-editor="true"]',
      'div[aria-label^="Message #"][role="textbox"]',
      'div[aria-label^="Message @"][role="textbox"]',
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let index = count - 1; index >= 0; index -= 1) {
        const candidate = locator.nth(index);
        const visible = await candidate.isVisible().catch(() => false);
        if (visible) {
          return candidate;
        }
      }
    }
    return null;
  }

  private async waitForComposer(
    page: Page,
    timeoutMs: number,
  ): Promise<ReturnType<Page['locator']> | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const composer = await this.findComposer(page);
      if (composer) {
        return composer;
      }
      if (await this.hasReadOnlyNotice(page)) {
        return null;
      }
      await page.waitForTimeout(250);
    }
    return null;
  }
}

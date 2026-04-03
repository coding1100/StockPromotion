import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Browser, BrowserContext, chromium, Page } from 'playwright';
import { mkdir } from 'fs/promises';
import { join } from 'path';

type StocktwitsAccountConfig = {
  username: string;
  password: string;
};

@Injectable()
export class StocktwitsPublisher {
  constructor(private readonly configService: ConfigService) {}

  async publish(
    account: StocktwitsAccountConfig,
    message: string,
    jobId: string,
  ): Promise<{ externalPostId: string; evidenceUri: string }> {
    const loginUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_LOGIN_URL',
    );
    const postUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_POST_URL',
    );
    const artifactsDir = join(process.cwd(), 'artifacts', 'stocktwits');
    await mkdir(artifactsDir, { recursive: true });
    const successScreenshotPath = join(artifactsDir, `${jobId}.png`);
    const errorScreenshotPath = join(artifactsDir, `${jobId}-error.png`);
    const headless = this.configService.get<boolean>('STOCKTWITS_HEADLESS') !== false;
    const userDataDir =
      this.configService.get<string>('STOCKTWITS_USER_DATA_DIR')?.trim() || '';
    const manualLoginTimeoutMs = this.configService.getOrThrow<number>(
      'STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS',
    );

    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    if (userDataDir) {
      context = await chromium.launchPersistentContext(userDataDir, {
        headless,
      });
    } else {
      browser = await chromium.launch({ headless });
      context = await browser.newContext();
    }

    const page = context.pages()[0] ?? (await context.newPage());

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
      await this.performLoginIfNeeded(page, account, manualLoginTimeoutMs);

      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });
      await this.dismissCookieBanner(page);
      await this.handlePossibleChallenge(page, manualLoginTimeoutMs);

      const composer = await this.resolveComposer(page);
      await composer.click();
      await this.fillComposer(composer, message);
      await this.submitPost(page);
      await page.waitForLoadState('networkidle');

      await page.screenshot({ path: successScreenshotPath, fullPage: true });

      return {
        externalPostId: await this.resolvePostId(page, jobId),
        evidenceUri: successScreenshotPath,
      };
    } catch (error) {
      try {
        await page.screenshot({ path: errorScreenshotPath, fullPage: true });
      } catch {
        // Ignore screenshot failure and propagate original publish error.
      }

      const messageText =
        error instanceof Error ? error.message : 'publish_failed';
      throw new Error(`${messageText} | evidence:${errorScreenshotPath}`);
    } finally {
      await context.close();
      if (browser) {
        await browser.close();
      }
    }
  }

  private async performLoginIfNeeded(
    page: Page,
    account: StocktwitsAccountConfig,
    manualLoginTimeoutMs: number,
  ): Promise<void> {
    const alreadyAuthenticated = await this.isAuthenticated(page);
    if (alreadyAuthenticated) {
      return;
    }

    const loginField = this.resolveLoginField(page);
    const passwordField = this.resolvePasswordField(page);
    const loginFieldCount = await loginField.count();
    const passwordFieldCount = await passwordField.count();

    if (loginFieldCount === 0 || passwordFieldCount === 0) {
      await this.waitForManualLogin(page, manualLoginTimeoutMs);
      return;
    }

    await loginField.fill(account.username);
    await passwordField.fill(account.password);
    await page
      .getByRole('button', { name: /sign in|log in/i })
      .first()
      .click();
    await page.waitForLoadState('networkidle');
    await this.handlePossibleChallenge(page, manualLoginTimeoutMs);
  }

  private async handlePossibleChallenge(
    page: Page,
    manualLoginTimeoutMs: number,
  ): Promise<void> {
    const challengeVisible = await this.isChallengeVisible(page);
    if (!challengeVisible) {
      return;
    }

    const headless =
      this.configService.get<boolean>('STOCKTWITS_HEADLESS') !== false;
    if (headless) {
      throw new Error(
        'captcha_challenge_detected. Set STOCKTWITS_HEADLESS=false to solve manually.',
      );
    }

    await this.waitForManualLogin(page, manualLoginTimeoutMs);
    if (await this.isChallengeVisible(page)) {
      throw new Error(
        'captcha_challenge_not_resolved_within_timeout. Increase STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS if needed.',
      );
    }
  }

  private async waitForManualLogin(
    page: Page,
    manualLoginTimeoutMs: number,
  ): Promise<void> {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText?.toLowerCase() ?? '';
        const challengeActive =
          text.includes('verify you are human') ||
          text.includes('security verification');
        const textarea = document.querySelector('textarea');
        const password = Array.from(
          document.querySelectorAll('input'),
        ).some((input) => {
          const element = input as HTMLInputElement;
          return element.type === 'password';
        });

        return !challengeActive && (Boolean(textarea) || password);
      },
      {
        timeout: manualLoginTimeoutMs,
      },
    );
  }

  private async isChallengeVisible(page: Page): Promise<boolean> {
    const text = (await page.textContent('body').catch(() => '')) || '';
    return /verify you are human|security verification/i.test(text);
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    const url = page.url();
    if (/stocktwits\.com(\/?$|\/symbol\/|\/message\/)/i.test(url)) {
      const loginFieldCount = await this.resolveLoginField(page).count();
      return loginFieldCount === 0;
    }

    return false;
  }

  private resolveLoginField(page: Page) {
    return page
      .locator(
        'input[placeholder*="Email"], input[placeholder*="Username"], input[name*="email"], input[name*="username"], input[type="email"], input[type="text"]',
      )
      .first();
  }

  private resolvePasswordField(page: Page) {
    return page
      .locator(
        'input[placeholder*="Password"], input[name*="password"], input[type="password"]',
      )
      .first();
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    const closeButton = page.locator('button, div').filter({
      hasText: /^×$|^x$/i,
    }).first();
    const privacyButton = page.getByRole('button', {
      name: /your privacy rights|accept|agree|close/i,
    }).first();

    if ((await closeButton.count()) > 0) {
      await closeButton.click({ timeout: 2000 }).catch(() => undefined);
    }
    if ((await privacyButton.count()) > 0) {
      await privacyButton.click({ timeout: 2000 }).catch(() => undefined);
    }
  }

  private async resolveComposer(page: Page) {
    const textarea = page.locator('textarea').first();
    if ((await textarea.count()) > 0) {
      return textarea;
    }

    const contentEditable = page.locator('[contenteditable="true"]').first();
    if ((await contentEditable.count()) > 0) {
      return contentEditable;
    }

    const openComposerButton = page
      .getByRole('button', { name: /post|create|compose|write/i })
      .first();
    if ((await openComposerButton.count()) > 0) {
      await openComposerButton.click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    }

    const textareaAfterClick = page.locator('textarea').first();
    if ((await textareaAfterClick.count()) > 0) {
      return textareaAfterClick;
    }

    const contentEditableAfterClick = page
      .locator('[contenteditable="true"]')
      .first();
    if ((await contentEditableAfterClick.count()) > 0) {
      return contentEditableAfterClick;
    }

    throw new Error('stocktwits_composer_not_found');
  }

  private async fillComposer(
    composer: Page['locator'] extends (...args: never[]) => infer T ? T : never,
    message: string,
  ): Promise<void> {
    const tagName = await composer.evaluate((element) =>
      element.tagName.toLowerCase(),
    );

    if (tagName === 'textarea') {
      await composer.fill(message);
      return;
    }

    await composer.fill(message).catch(async () => {
      await composer.evaluate((element, value) => {
        const target = element as HTMLElement;
        target.focus();
        target.textContent = value;
      }, message);
    });
  }

  private async submitPost(page: Page): Promise<void> {
    const submitButton = page
      .getByRole('button', { name: /post|send|publish/i })
      .first();
    if ((await submitButton.count()) > 0) {
      await submitButton.click();
      return;
    }

    throw new Error('stocktwits_submit_button_not_found');
  }

  private async resolvePostId(page: Page, fallbackId: string): Promise<string> {
    const currentUrl = page.url();
    const fromUrl = currentUrl.match(/\/message\/(\d+)/);
    if (fromUrl?.[1]) {
      return fromUrl[1];
    }

    const linkLocator = page.locator('a[href*="/message/"]').first();
    if ((await linkLocator.count()) > 0) {
      const href = await linkLocator.getAttribute('href');
      if (href) {
        const fromHref = href.match(/\/message\/(\d+)/);
        if (fromHref?.[1]) {
          return fromHref[1];
        }
      }
    }

    return fallbackId;
  }
}

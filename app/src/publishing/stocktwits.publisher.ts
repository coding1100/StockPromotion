import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, Page } from 'playwright';
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

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      await page
        .getByLabel(/username|email/i)
        .first()
        .fill(account.username);
      await page
        .getByLabel(/password/i)
        .first()
        .fill(account.password);
      await page
        .getByRole('button', { name: /sign in|log in/i })
        .first()
        .click();
      await page.waitForLoadState('networkidle');

      await page.goto(postUrl, { waitUntil: 'domcontentloaded' });

      const textArea = page.locator('textarea').first();
      await textArea.click();
      await textArea.fill(message);
      await page
        .getByRole('button', { name: /post|send/i })
        .first()
        .click();
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
      await browser.close();
    }
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

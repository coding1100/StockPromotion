import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium } from 'patchright';
import type { BrowserContext, Page } from 'patchright';
import * as path from 'path';
import * as fs from 'fs';

const DLVRIT_APP_URL = 'https://app.dlvrit.com';
const SESSION_FILE = '.dlvrit-session.json';

// URL patterns that indicate we are NOT on the authenticated dashboard
const NOT_AUTHENTICATED_PATTERNS = ['/login', '/signin', '/auth', 'accounts.google.com'];

@Injectable()
export class DlvritSessionService {
  private readonly logger = new Logger(DlvritSessionService.name);
  private cachedCookie: string | null = null;
  private cachedAt: number = 0;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

  constructor(private readonly configService: ConfigService) {
    this.loadFromDisk();
  }

  async getSessionCookie(): Promise<string> {
    if (this.cachedCookie && Date.now() - this.cachedAt < this.CACHE_TTL_MS) {
      return this.cachedCookie;
    }
    return this.refreshSession();
  }

  setCookieManually(value: string): void {
    this.store(value);
    this.logger.log('dlvr.it session cookie updated manually.');
  }

  async refreshSession(): Promise<string> {
    const envCookie = this.configService.get<string>('DLVRIT_SESSION_COOKIE');
    if (envCookie?.trim()) {
      this.store(envCookie.trim());
      this.logger.log('dlvr.it session loaded from DLVRIT_SESSION_COOKIE env var.');
      return envCookie.trim();
    }
    // Wipe stale browser cookies so we always go through real Google OAuth
    this.wipeBrowserCookies();
    return this.refreshViaPlaywright();
  }

  // ── Playwright automation ───────────────────────────────────────────────────

  private async refreshViaPlaywright(): Promise<string> {
    this.logger.log('Refreshing dlvr.it session via Playwright…');
    const userDataDir = this.resolveUserDataDir();
    const headless =
      (this.configService.get<string>('DLVRIT_HEADLESS') ?? 'true') !== 'false';

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      ignoreDefaultArgs: [
        '--enable-automation',
        '--disable-background-networking',
        '--disable-extensions',
        '--disable-popup-blocking',
      ],
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await context.newPage();

      // Navigate to app root — the SPA redirects to its own login route
      await page.goto(DLVRIT_APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
      // Wait for any SPA routing to settle
      await page.waitForTimeout(2_000);
      const landedUrl = page.url();
      this.logger.log(`Landed on: ${landedUrl}`);
      await this.saveDebugScreenshot(page, 'after-app-root');

      const needsLogin = NOT_AUTHENTICATED_PATTERNS.some((p) => landedUrl.includes(p)) ||
        !landedUrl.startsWith('https://app.dlvrit.com');

      if (needsLogin) {
        this.logger.log('Login page detected — attempting email/password login…');
        await this.doEmailPasswordLogin(page);

        // Wait for redirect back to authenticated dlvr.it dashboard
        this.logger.log('Credentials submitted — waiting for redirect to dashboard…');
        await page.waitForURL(
          (url) => {
            const s = url.toString();
            return (
              s.startsWith('https://app.dlvrit.com') &&
              NOT_AUTHENTICATED_PATTERNS.every((p) => !s.includes(p))
            );
          },
          { timeout: 30_000 },
        );
        this.logger.log(`Authenticated — at: ${page.url()}`);
        await this.saveDebugScreenshot(page, 'authenticated-dashboard');
      } else {
        this.logger.log('Already authenticated on dashboard.');
      }

      const cookie = await this.extractCookie(context, page);
      this.store(cookie);
      this.logger.log('dlvr.it session cookie refreshed successfully.');
      return cookie;
    } catch (err) {
      this.wipeBrowserCookies();
      throw err;
    } finally {
      await context.close();
    }
  }

  private async doEmailPasswordLogin(page: Page): Promise<void> {
    const email = this.configService.get<string>('DLVRIT_LOGIN_EMAIL') ?? '';
    const password = this.configService.get<string>('DLVRIT_LOGIN_PASSWORD') ?? '';

    if (!email || !password) {
      throw new Error(
        'dlvrit_credentials_missing: Set DLVRIT_LOGIN_EMAIL and DLVRIT_LOGIN_PASSWORD in .env.',
      );
    }

    try {
      // dlvr.it login page has email placeholder "SIGN IN WITH EMAIL" and password field
      await page.waitForSelector('input[type="email"], input[placeholder*="EMAIL" i], input[name="email"]', {
        timeout: 10_000,
      });
      const emailInput = page.locator('input[type="email"], input[placeholder*="EMAIL" i], input[name="email"]').first();
      await emailInput.fill(email);
      this.logger.log('Email filled.');

      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill(password);
      this.logger.log('Password filled — clicking Sign in…');

      // Click the "Sign in" button (not the Google/Facebook/Twitter buttons)
      const signInBtn = page.getByRole('button', { name: /^sign in$/i }).first();
      await signInBtn.click();
    } catch (err) {
      await this.saveDebugScreenshot(page, 'login-form-failed');
      throw new Error(
        `dlvrit_login_form: ${err instanceof Error ? err.message : err} — url: ${page.url()}`,
      );
    }
  }

  private async extractCookie(context: BrowserContext, page: Page): Promise<string> {
    // Navigate to the post page so API-domain cookies are set
    try {
      await page.goto('https://app.dlvrit.com/content/post', {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });
    } catch {
      // non-fatal
    }

    const cookies = await context.cookies([
      'https://api.dlvrit.com',
      'https://app.dlvrit.com',
      'https://dlvrit.com',
    ]);

    this.logger.log(
      `Cookies: ${cookies.map((c) => `${c.name}@${c.domain}`).join(', ')}`,
    );

    const dlvritCookie = cookies.find((c) => c.name === 'dlvrit');
    if (!dlvritCookie) {
      throw new Error('dlvrit_cookie_missing: Could not find dlvrit session cookie after login.');
    }
    return dlvritCookie.value;
  }

  private async saveDebugScreenshot(page: Page, label: string): Promise<void> {
    try {
      const dir = this.resolveUserDataDir();
      const file = path.join(dir, `debug-${label}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
      this.logger.log(`Screenshot: ${file}`);
    } catch {
      // non-fatal
    }
  }

  private wipeBrowserCookies(): void {
    try {
      const dir = this.resolveUserDataDir();
      for (const f of ['Default/Cookies', 'Default/Cookies-journal']) {
        const p = path.join(dir, f);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      this.logger.log('Browser cookies wiped — fresh login will run.');
    } catch {
      // non-fatal
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private store(value: string): void {
    this.cachedCookie = value;
    this.cachedAt = Date.now();
    try {
      fs.writeFileSync(
        this.sessionFilePath(),
        JSON.stringify({ value, storedAt: this.cachedAt }),
      );
    } catch {
      // non-fatal
    }
  }

  private loadFromDisk(): void {
    const envCookie = this.configService.get<string>('DLVRIT_SESSION_COOKIE');
    if (envCookie?.trim()) {
      this.cachedCookie = envCookie.trim();
      this.cachedAt = Date.now();
      this.logger.log('dlvr.it session loaded from DLVRIT_SESSION_COOKIE env var.');
      return;
    }
    try {
      const raw = fs.readFileSync(this.sessionFilePath(), 'utf8');
      const { value, storedAt } = JSON.parse(raw) as { value: string; storedAt: number };
      if (value && Date.now() - storedAt < this.CACHE_TTL_MS) {
        this.cachedCookie = value;
        this.cachedAt = storedAt;
        this.logger.log('dlvr.it session loaded from disk.');
      }
    } catch {
      // no session file yet
    }
  }

  private sessionFilePath(): string {
    const dir =
      this.configService.get<string>('DLVRIT_USER_DATA_DIR') ??
      path.join(process.cwd(), 'artifacts', 'dlvrit-user-data');
    return path.join(dir, SESSION_FILE);
  }

  private resolveUserDataDir(): string {
    const dir =
      this.configService.get<string>('DLVRIT_USER_DATA_DIR') ??
      path.join(process.cwd(), 'artifacts', 'dlvrit-user-data');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

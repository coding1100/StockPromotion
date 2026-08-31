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
  private readonly sessions = new Map<string, { cookie: string; cachedAt: number }>();
  private readonly refreshes = new Map<string, Promise<string>>();
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

  constructor(private readonly configService: ConfigService) {
    this.loadFromDisk('legacy');
  }

  async getSessionCookie(workspaceId = 'legacy'): Promise<string> {
    const cached = this.sessions.get(workspaceId) ?? this.loadFromDisk(workspaceId);
    if (cached && Date.now() - cached.cachedAt < this.CACHE_TTL_MS) {
      return cached.cookie;
    }
    return this.refreshSession(workspaceId);
  }

  async loginWorkspace(workspaceId: string, email: string, password: string): Promise<string> {
    return this.refreshSession(workspaceId, { email, password });
  }

  async refreshSession(
    workspaceId = 'legacy',
    credentials?: { email: string; password: string },
  ): Promise<string> {
    const inFlight = this.refreshes.get(workspaceId);
    if (inFlight) return inFlight;
    const refresh = this.refreshViaPlaywright(workspaceId, credentials).finally(() => {
      this.refreshes.delete(workspaceId);
    });
    this.refreshes.set(workspaceId, refresh);
    return refresh;
  }

  removeWorkspace(workspaceId: string): void {
    this.sessions.delete(workspaceId);
  }

  // ── Playwright automation ───────────────────────────────────────────────────

  private async refreshViaPlaywright(
    workspaceId: string,
    credentials?: { email: string; password: string },
  ): Promise<string> {
    this.logger.log(`Refreshing dlvr.it session for workspace ${workspaceId}…`);
    const userDataDir = this.resolveUserDataDir(workspaceId);
    const headless =
      (this.configService.get<string>('DLVRIT_HEADLESS') ?? 'true') !== 'false';
    const configuredBrowserBinary =
      this.configService.get<string>('DLVRIT_BROWSER_BINARY')?.trim();
    const systemChrome = '/usr/bin/google-chrome';
    const executablePath = configuredBrowserBinary ||
      (fs.existsSync(systemChrome) ? systemChrome : undefined);

    const context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      executablePath,
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
      // The SPA keeps analytics/background requests open, so networkidle can
      // time out even when the login page is fully usable.
      await page.goto(DLVRIT_APP_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      // The root document boots a SPA and only then routes unauthenticated
      // users to /login. Waiting for that client-side route avoids treating
      // the initial app shell as an authenticated dashboard.
      await page
        .waitForURL((url) => url.pathname !== '/', { timeout: 20_000 })
        .catch(() => undefined);
      const landedUrl = page.url();
      this.logger.log(`Landed on: ${landedUrl}`);
      await this.saveDebugScreenshot(page, 'after-app-root');

      const needsLogin = NOT_AUTHENTICATED_PATTERNS.some((p) => landedUrl.includes(p)) ||
        !landedUrl.startsWith('https://app.dlvrit.com');

      if (needsLogin) {
        this.logger.log('Login page detected — attempting email/password login…');
        await this.doEmailPasswordLogin(page, credentials, workspaceId === 'legacy');

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
      this.store(workspaceId, cookie);
      this.logger.log(`dlvr.it session refreshed for workspace ${workspaceId}.`);
      return cookie;
    } catch (err) {
      this.wipeBrowserCookies(workspaceId);
      throw err;
    } finally {
      await context.close();
    }
  }

  private async doEmailPasswordLogin(
    page: Page,
    credentials?: { email: string; password: string },
    allowLegacyEnvironmentCredentials = false,
  ): Promise<void> {
    const email = credentials?.email ?? (allowLegacyEnvironmentCredentials
      ? this.configService.get<string>('DLVRIT_LOGIN_EMAIL') ?? ''
      : '');
    const password = credentials?.password ?? (allowLegacyEnvironmentCredentials
      ? this.configService.get<string>('DLVRIT_LOGIN_PASSWORD') ?? ''
      : '');

    if (!email || !password) {
      throw new Error(
        'dlvrit_credentials_missing: This workspace needs reconnection. Use Connect dlvr.it and enter its own credentials again.',
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
      const file = path.join(this.resolveBaseDir(), `debug-${label}-${Date.now()}.png`);
      await page.screenshot({ path: file, fullPage: true });
      this.logger.log(`Screenshot: ${file}`);
    } catch {
      // non-fatal
    }
  }

  private wipeBrowserCookies(workspaceId: string): void {
    try {
      const dir = this.resolveUserDataDir(workspaceId);
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

  private store(workspaceId: string, value: string): void {
    const cachedAt = Date.now();
    this.sessions.set(workspaceId, { cookie: value, cachedAt });
    try {
      fs.writeFileSync(
        this.sessionFilePath(workspaceId),
        JSON.stringify({ value, storedAt: cachedAt }),
      );
    } catch {
      // non-fatal
    }
  }

  private loadFromDisk(workspaceId: string): { cookie: string; cachedAt: number } | null {
    try {
      const raw = fs.readFileSync(this.sessionFilePath(workspaceId), 'utf8');
      const { value, storedAt } = JSON.parse(raw) as { value: string; storedAt: number };
      if (value && Date.now() - storedAt < this.CACHE_TTL_MS) {
        const session = { cookie: value, cachedAt: storedAt };
        this.sessions.set(workspaceId, session);
        this.logger.log(`dlvr.it session loaded for workspace ${workspaceId}.`);
        return session;
      }
    } catch {
      // no session file yet
    }
    return null;
  }

  private sessionFilePath(workspaceId: string): string {
    return path.join(this.resolveUserDataDir(workspaceId), SESSION_FILE);
  }

  private resolveBaseDir(): string {
    return (
      this.configService.get<string>('DLVRIT_USER_DATA_DIR') ??
      path.join(process.cwd(), 'artifacts', 'dlvrit-user-data')
    );
  }

  private resolveUserDataDir(workspaceId: string): string {
    const safeWorkspaceId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = workspaceId === 'legacy'
      ? this.resolveBaseDir()
      : path.join(this.resolveBaseDir(), 'workspaces', safeWorkspaceId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { BrowserContext, Locator, Page } from 'playwright';
import { firefox } from 'playwright-extra';

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

  private static readonly USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:134.0) Gecko/20100101 Firefox/134.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
  ];

  private static readonly VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1680, height: 1050 },
    { width: 1440, height: 900 },
    { width: 1600, height: 900 },
    { width: 1366, height: 768 },
    { width: 1536, height: 864 },
  ];

  constructor(private readonly configService: ConfigService) {}

  private pickRandom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private randInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private jitter(baseMs: number, varianceMs: number): number {
    return Math.max(0, baseMs + (Math.random() - 0.5) * 2 * varianceMs);
  }

  async broadcastToWritableChannels(input: {
    serverUrl: string;
    message: string;
    email?: string;
    password?: string;
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
      const result = await this.postToServerChannels(
        page,
        guildId,
        serverUrl,
        normalizedMessage,
        input.email,
        input.password,
      );
      return { guildId, ...result };
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

  // Post to multiple servers in a single browser session.
  // Applies inter-server delay between servers and inter-channel delay within each.
  async broadcastToMultipleServers(input: {
    serverUrls: string[];
    message: string;
    email?: string;
    password?: string;
  }): Promise<{
    serverCount: number;
    totalChannelCount: number;
    totalPostedCount: number;
    totalSkippedCount: number;
    totalFailedCount: number;
    servers: Array<{
      serverUrl: string;
      guildId: string;
      channelCount: number;
      postedCount: number;
      skippedCount: number;
      failedCount: number;
      channels: DiscordUiChannelResult[];
      error?: string;
    }>;
  }> {
    const normalizedMessage = input.message.trim();
    if (!normalizedMessage) {
      throw new Error('discord_ui_message_empty');
    }

    const serverUrls = input.serverUrls
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (serverUrls.length === 0) {
      throw new Error('discord_ui_server_urls_empty');
    }

    const { context, page } = await this.createBrowserSession();

    const servers: Array<{
      serverUrl: string;
      guildId: string;
      channelCount: number;
      postedCount: number;
      skippedCount: number;
      failedCount: number;
      channels: DiscordUiChannelResult[];
      error?: string;
    }> = [];

    let totalChannelCount = 0;
    let totalPostedCount = 0;
    let totalSkippedCount = 0;
    let totalFailedCount = 0;

    try {
      for (let si = 0; si < serverUrls.length; si += 1) {
        const serverUrl = serverUrls[si];
        const guildId = this.extractGuildId(serverUrl);

        if (!guildId) {
          this.logger.warn(
            `Discord: skipping invalid server URL at index ${si}: ${serverUrl}`,
          );
          servers.push({
            serverUrl,
            guildId: '',
            channelCount: 0,
            postedCount: 0,
            skippedCount: 0,
            failedCount: 1,
            channels: [],
            error: 'discord_ui_server_url_invalid',
          });
          totalFailedCount += 1;
          continue;
        }

        this.logger.log(
          `Discord: processing server ${si + 1}/${serverUrls.length} (guild ${guildId})`,
        );

        try {
          const result = await this.postToServerChannels(
            page,
            guildId,
            serverUrl,
            normalizedMessage,
            input.email,
            input.password,
          );

          servers.push({ serverUrl, guildId, ...result });
          totalChannelCount += result.channelCount;
          totalPostedCount += result.postedCount;
          totalSkippedCount += result.skippedCount;
          totalFailedCount += result.failedCount;
        } catch (error) {
          const reason =
            error instanceof Error ? error.message : 'discord_ui_server_failed';
          const evidenceUri = await this.captureScreenshot(
            page,
            `discord-ui-${guildId}-${Date.now()}-fatal`,
          );
          const fullReason = evidenceUri
            ? `${reason} | evidence:${evidenceUri}`
            : reason;

          this.logger.error(
            `Discord: server ${si + 1}/${serverUrls.length} (${guildId}) failed: ${fullReason}`,
          );
          servers.push({
            serverUrl,
            guildId,
            channelCount: 0,
            postedCount: 0,
            skippedCount: 0,
            failedCount: 1,
            channels: [],
            error: fullReason,
          });
          totalFailedCount += 1;
        }

        if (si < serverUrls.length - 1) {
          const delay = this.randomInterServerDelayMs();
          this.logger.log(
            `Discord inter-server pause: ${Math.round(delay / 1000)}s before server ` +
            `${si + 2}/${serverUrls.length}`,
          );
          await page.waitForTimeout(delay);
        }
      }
    } finally {
      await context.close();
    }

    return {
      serverCount: serverUrls.length,
      totalChannelCount,
      totalPostedCount,
      totalSkippedCount,
      totalFailedCount,
      servers,
    };
  }

  // Best-effort: read the active channel name from the DOM so direct-link results
  // show a real name instead of "channel-<id>".
  private async resolveChannelNameFromDom(
    page: Page,
    channelId: string,
  ): Promise<string> {
    try {
      // The active channel link in the sidebar has the channel ID in its href
      const link = page
        .locator(`a[href*="/${channelId}"]`)
        .first();
      const label = await link.getAttribute('aria-label', { timeout: 2_000 }).catch(() => null);
      if (label?.trim()) return label.trim();

      // Fallback: inner text of the link
      const text = await link.innerText({ timeout: 1_500 }).catch(() => null);
      if (text?.trim()) return text.trim().replace(/^#\s*/, '');
    } catch {
      // non-fatal
    }
    return `channel-${channelId}`;
  }

  private async postToServerChannels(
    page: Page,
    guildId: string,
    serverUrl: string,
    normalizedMessage: string,
    email?: string,
    password?: string,
  ): Promise<{
    channelCount: number;
    postedCount: number;
    skippedCount: number;
    failedCount: number;
    channels: DiscordUiChannelResult[];
  }> {
    await page.goto(serverUrl, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
    });

    await this.ensureLoggedIn(page, email, password);
    if (!page.url().includes(`/channels/${guildId}`)) {
      await page.goto(serverUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeoutMs,
      });
    }

    // ── Determine target channels ───────────────────────────────────────────
    // Direct channel link  → post only to that channel, no sidebar scanning.
    // Server link          → discover community channels, apply cap.
    const directChannelId = this.extractChannelId(serverUrl);

    let channels: Array<{ channelId: string; channelName: string; channelUrl: string }>;

    if (directChannelId) {
      const channelName = await this.resolveChannelNameFromDom(page, directChannelId);
      this.logger.log(
        `Discord: direct channel URL — posting only to #${channelName} (${directChannelId}), skipping channel scan.`,
      );
      channels = [
        {
          channelId: directChannelId,
          channelName,
          channelUrl: serverUrl,
        },
      ];
    } else {
      const allChannels = await this.collectGuildChannelsWithAuthRecovery(
        page,
        guildId,
        serverUrl,
        email,
        password,
      );

      const filteredChannels = allChannels.filter(
        (ch) => !this.shouldSkipChannel(ch.channelName),
      );
      const cap = this.maxChannelsPerSession;
      channels = filteredChannels.slice(0, cap);

      this.logger.log(
        `Discord channel scan: ${allChannels.length} total, ` +
        `${allChannels.length - filteredChannels.length} non-community channels skipped, ` +
        `${filteredChannels.length} eligible, ` +
        `${channels.length} selected this session (cap: ${cap}). ` +
        `Override with DISCORD_UI_MAX_CHANNELS_PER_SESSION.`,
      );
    }

    const results: DiscordUiChannelResult[] = [];
    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index];
      const channelMessage = this.diversifyMessage(normalizedMessage);

      const row = await this.tryPostInChannel(page, {
        channelId: channel.channelId,
        channelName: channel.channelName,
        channelUrl: channel.channelUrl,
        guildId,
        isFirstChannel: index === 0,
        message: channelMessage,
      });
      results.push(row);

      if (index < channels.length - 1) {
        const delay = this.randomInterChannelDelayMs();
        this.logger.log(
          `Discord inter-channel pause: ${Math.round(delay / 1000)}s before ` +
          `channel ${index + 2}/${channels.length} ("${channels[index + 1].channelName}")`,
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
      channelCount: results.length,
      postedCount,
      skippedCount,
      failedCount,
      channels: results,
    };
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

  // Safe defaults: 3–8 minutes between channels.
  // Discord's AutoMod flags rapid same-content posts across channels.
  // Override with DISCORD_UI_INTER_CHANNEL_DELAY_MIN_MS / _MAX_MS for testing.
  private randomInterChannelDelayMs(): number {
    const min =
      this.configService.get<number>('DISCORD_UI_INTER_CHANNEL_DELAY_MIN_MS') ??
      180_000;
    const max =
      this.configService.get<number>('DISCORD_UI_INTER_CHANNEL_DELAY_MAX_MS') ??
      480_000;
    if (max <= min) {
      return Math.max(0, min);
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private get maxChannelsPerSession(): number {
    return (
      this.configService.get<number>('DISCORD_UI_MAX_CHANNELS_PER_SESSION') ?? 2
    );
  }

  // Safe defaults: 5–15 minutes between servers.
  // Override with DISCORD_UI_INTER_SERVER_DELAY_MIN_MS / _MAX_MS for testing.
  private randomInterServerDelayMs(): number {
    const min =
      this.configService.get<number>('DISCORD_UI_INTER_SERVER_DELAY_MIN_MS') ??
      300_000;
    const max =
      this.configService.get<number>('DISCORD_UI_INTER_SERVER_DELAY_MAX_MS') ??
      900_000;
    if (max <= min) {
      return Math.max(0, min);
    }
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // Subtle per-channel message variation so each post has a unique hash.
  // Keeps the first line intact (confirmation probe reads first 80 chars).
  private diversifyMessage(message: string): string {
    let result = message;
    const lines = result.split('\n');

    // If 3+ lines: randomly shuffle lines after the first (preserve probe)
    if (lines.length >= 3 && Math.random() < 0.55) {
      const first = lines[0];
      const rest = lines.slice(1);
      for (let i = rest.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      result = [first, ...rest].join('\n');
    }

    // Append a subtle trailing variant 60% of the time
    const lastChar = result[result.length - 1];
    const endsWithPunctuation = '.!?'.includes(lastChar);
    if (Math.random() < 0.6) {
      const emojiPool = [' 📊', ' 📈', ' 💡', ' 🔍', ' 📌', ' 💰'];
      if (endsWithPunctuation) {
        result += emojiPool[Math.floor(Math.random() * emojiPool.length)];
      } else {
        const pool = [...emojiPool, '.', '...'];
        result += pool[Math.floor(Math.random() * pool.length)];
      }
    }

    return result;
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

  private shouldSkipChannel(channelName: string): boolean {
    const name = channelName.toLowerCase().replace(/[-_\s]/g, '');

    const skipPatterns = [
      // Questions / Q&A
      'question', 'questions', 'qanda', 'qna', 'askme', 'askhere',
      'askus', 'faq', 'faqs', 'inquiries', 'inquiry',

      // Support / Help
      'support', 'helpdesk', 'helpcenter', 'ticket', 'tickets',
      'presales', 'presalessupport', 'supportcall', 'contactus',
      'contact', 'assistance',

      // Verification / Onboarding
      'verification', 'verify', 'captcha', 'welcome', 'rules',
      'serverrules', 'readfirst', 'getstarted', 'gettingstarted', 'onboarding',

      // Announcements / Updates
      'announcement', 'announcements', 'updates', 'update', 'changelog',
      'patchnotes', 'newsfeed', 'news',

      // Live / Streaming / Events
      'goinglive', 'golive', 'livestream', 'streams', 'events',
      'event', 'calendar', 'schedule',

      // Commercial / Sales / Buy
      'buynow', 'purchase', 'shop', 'store', 'sales', 'sale',
      'checkout', 'order', 'orders', 'payment', 'payments',
      'pricing', 'deals', 'deal', 'promo', 'promotions', 'promotion',
      'discount', 'discounts',

      // Admin / Mod / Staff / Bots
      'admin', 'staff', 'mod', 'mods', 'moderator', 'moderators',
      'botcommands', 'botcommand', 'commands',

      // Info / Roles / Intros (read-only type channels)
      'info', 'information', 'introductions', 'roles', 'selfroles',
      'reactionroles', 'colorroles',

      // Partner / Affiliate / Sponsor
      'partners', 'affiliate', 'affiliates', 'sponsorship',
    ];

    return skipPatterns.some((p) => name.includes(p));
  }

  private extractGuildId(url: string): string | null {
    const match = url.match(
      /^https:\/\/discord\.com\/channels\/(\d{15,25})(?:\/\d{15,25})?/i,
    );
    return match?.[1] || null;
  }

  // Returns the channel ID when the URL points directly at a channel,
  // or null when the URL is a server-only link (no channel segment).
  private extractChannelId(url: string): string | null {
    const match = url
      .trim()
      .match(/^https:\/\/discord\.com\/channels\/\d{15,25}\/(\d{15,25})/i);
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
    this.logger.log(`Discord session profile: ${userDataDir}`);

    const viewport = this.pickRandom(DiscordUiPublisher.VIEWPORTS);
    const userAgent = this.pickRandom(DiscordUiPublisher.USER_AGENTS);

    const context = await firefox.launchPersistentContext(userDataDir, {
      headless: this.isHeadless,
      executablePath: browserBinary || undefined,
      viewport,
      userAgent,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: [],
      firefoxUserPrefs: {
        // Disable the webdriver flag — primary bot-detection signal in Firefox
        'dom.webdriver.enabled': false,
        // Override UA at the pref level so it survives redirects
        'general.useragent.override': userAgent,
        // Block notification permission prompts
        'permissions.default.desktop-notification': 2,
        // Disable update checks and telemetry
        'app.update.auto': false,
        'toolkit.telemetry.unified': false,
        'toolkit.telemetry.enabled': false,
        'toolkit.telemetry.archive.enabled': false,
        'app.normandy.enabled': false,
        'app.shield.optoutstudies.enabled': false,
        // Disable first-run overlays and welcome pages
        'browser.startup.homepage_override.mstone': 'ignore',
        'startup.homepage_welcome_url.additional': '',
        // Disable safe-browsing and other phone-home calls
        'browser.safebrowsing.malware.enabled': false,
        'browser.safebrowsing.phishing.enabled': false,
        // Keep WebGL enabled — sites check for it; disabling it looks like a headless flag
        'webgl.disabled': false,
        // Disable resistFingerprinting — it changes many APIs in detectable ways
        'privacy.resistFingerprinting': false,
        // Don't reveal automation in HTTP headers
        'general.platform.override': 'Win32',
        // Media autoplay allowed (Discord uses audio/video)
        'media.autoplay.default': 0,
        'media.autoplay.blocking_policy': 0,
      },
    });

    await this.injectFingerprintEvasion(context);

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(this.navigationTimeoutMs);
    return { context, page };
  }

  private async injectFingerprintEvasion(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      // Firefox: dom.webdriver.enabled=false (pref) handles this, but belt-and-suspenders
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch { /* already defined */ }

      // Consistent language fingerprint
      try {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      } catch { /* already defined */ }

      // Canvas fingerprint noise — imperceptible per-session shift
      const noiseShift = (Math.random() - 0.5) * 0.018;
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (type?: string, quality?: unknown) {
        const ctx2d = this.getContext('2d');
        if (ctx2d && this.width > 0 && this.height > 0) {
          try {
            const imgData = ctx2d.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < imgData.data.length; i += 128) {
              imgData.data[i] = Math.max(0, Math.min(255, imgData.data[i] + noiseShift));
            }
            ctx2d.putImageData(imgData, 0, 0);
          } catch { /* cross-origin canvas — skip */ }
        }
        return origToDataURL.call(this, type, quality as number);
      };

      // WebGL renderer noise — randomize per-session so fingerprint differs each run
      const renderers = [
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ];
      const chosenRenderer = renderers[Math.floor(Math.random() * renderers.length)];
      const patchWebGL = (Ctor: typeof WebGLRenderingContext) => {
        const orig = Ctor.prototype.getParameter;
        Ctor.prototype.getParameter = function (param: number) {
          if (param === 37445) return chosenRenderer;
          if (param === 37446) return chosenRenderer.split(',')[0].replace('ANGLE (', '');
          return orig.call(this, param);
        };
      };
      try { patchWebGL(WebGLRenderingContext); } catch { /* unavailable */ }
      try { patchWebGL(WebGL2RenderingContext); } catch { /* unavailable */ }

      // Notifications — return denied so Discord doesn't pop the permission dialog
      const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
      if (origQuery) {
        (window.navigator.permissions as unknown as { query: (d: unknown) => Promise<unknown> }).query =
          (descriptor: unknown) => {
            const d = descriptor as { name?: string };
            if (d?.name === 'notifications') {
              return Promise.resolve({ state: 'denied', onchange: null } as PermissionStatus);
            }
            return origQuery(descriptor as PermissionDescriptor);
          };
      }
    });
  }

  private resolveDiscordUserDataDir(configuredPath: string): string {
    if (configuredPath) {
      return configuredPath;
    }
    return join(process.cwd(), '.pw-discord-firefox');
  }

  private resolveDiscordBrowserBinary(configuredPath: string): string {
    return configuredPath || '';
  }

  private async ensureLoggedIn(page: Page, emailOverride?: string, passwordOverride?: string): Promise<void> {
    const loginRequired = await this.isLoginRequired(page);
    if (!loginRequired) {
      this.logger.log('Discord: reusing saved session — no login needed.');
      return;
    }

    this.logger.log('Discord: saved session missing or expired — logging in fresh.');
    await this.loginWithCredentials(page, emailOverride, passwordOverride);
    if (await this.isLoginRequired(page)) {
      throw new Error('discord_ui_login_required_after_login_attempt');
    }
    this.logger.log('Discord: login successful — session saved to profile directory.');
  }

  private async isLoginRequired(page: Page): Promise<boolean> {
    const url = page.url();
    // Fast path: URL already tells us
    if (url.includes('/login') || url.includes('/register')) {
      return true;
    }
    // Logged-in Discord always lands on /channels/... or /channels/@me
    if (url.includes('/channels/')) {
      return false;
    }

    const loginUiDetected = await this.hasLoginUi(page);
    if (loginUiDetected) {
      return true;
    }

    // Final fallback: check for the email input with a short timeout.
    // On a valid session this input never appears, so 800ms is enough.
    const emailInput = page
      .locator('input[name="email"], input[type="email"]')
      .first();
    return emailInput.isVisible({ timeout: 800 }).catch(() => false);
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

  private async loginWithCredentials(page: Page, emailOverride?: string, passwordOverride?: string): Promise<void> {
    const email = emailOverride?.trim() || this.loginEmail;
    const password = passwordOverride?.trim() || this.loginPassword;
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
    emailOverride?: string,
    passwordOverride?: string,
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

        await this.ensureLoggedIn(page, emailOverride, passwordOverride);
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

  // Move the mouse gradually to a target element via a few intermediate waypoints.
  private async humanMouseMove(page: Page, target: Locator): Promise<void> {
    try {
      const box = await target.boundingBox();
      if (!box) return;

      // Land somewhere random within the element bounds (not dead-center)
      const destX = box.x + this.randInt(4, Math.max(5, box.width - 4));
      const destY = box.y + this.randInt(4, Math.max(5, box.height - 4));

      const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
      let curX = this.randInt(100, width - 200);
      let curY = this.randInt(80, height - 200);

      // 2-3 intermediate waypoints with slight curve
      const steps = this.randInt(2, 3);
      for (let s = 1; s <= steps; s += 1) {
        const t = s / (steps + 1);
        const wx = curX + (destX - curX) * t + this.randInt(-40, 40);
        const wy = curY + (destY - curY) * t + this.randInt(-20, 20);
        await page.mouse.move(wx, wy, { steps: this.randInt(6, 12) });
        await page.waitForTimeout(this.randInt(30, 80));
      }

      await page.mouse.move(destX, destY, { steps: this.randInt(4, 8) });
    } catch {
      // Non-fatal — fall through to click
    }
  }

  // Simulate a human reading the channel: scroll up briefly, then scroll back.
  private async simulateChannelReading(page: Page): Promise<void> {
    try {
      // Small upward scroll — looks like reading recent messages
      const scrollAmount = this.randInt(80, 250);
      await page.mouse.wheel(0, -scrollAmount);
      await page.waitForTimeout(this.jitter(600, 300));
      await page.mouse.wheel(0, scrollAmount);
      await page.waitForTimeout(this.jitter(400, 200));
    } catch {
      // Non-fatal
    }
  }

  // Click a channel in the left sidebar instead of reloading the page.
  // Falls back gracefully so the caller can decide whether to use page.goto instead.
  private async clickChannelInSidebar(
    page: Page,
    guildId: string,
    channelId: string,
    channelName: string,
  ): Promise<boolean> {
    try {
      const link = page
        .locator(`a[href="/channels/${guildId}/${channelId}"]`)
        .first();

      let visible = await link.isVisible({ timeout: 2_000 }).catch(() => false);

      if (!visible) {
        // Channel might be below the fold — scroll the channel list down
        const scroller = page
          .locator(
            '[class*="scroller"][class*="channelList"], ' +
            '[class*="channelsList"] [class*="scroller"], ' +
            'nav[aria-label*="channel" i] [class*="scroller"]',
          )
          .first();
        if (await scroller.isVisible({ timeout: 500 }).catch(() => false)) {
          await scroller.evaluate((el) => {
            (el as HTMLElement).scrollTop += 300;
          });
          await page.waitForTimeout(this.jitter(250, 100));
        }
        visible = await link.isVisible({ timeout: 1_500 }).catch(() => false);
      }

      if (!visible) {
        this.logger.debug(
          `Discord: sidebar link not found for #${channelName} (${channelId})`,
        );
        return false;
      }

      await link.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(this.jitter(150, 80));
      await this.humanMouseMove(page, link);
      await page.waitForTimeout(this.jitter(80, 40));
      await link.click();

      // SPA navigation: wait for URL to update to the target channel
      await page
        .waitForURL(`**/${guildId}/${channelId}`, { timeout: 8_000 })
        .catch(() => undefined);

      // Brief settle for Discord's React render cycle
      await page.waitForTimeout(this.jitter(700, 250));

      const landed = page.url().includes(`/${channelId}`);
      if (!landed) {
        this.logger.debug(
          `Discord: sidebar click for #${channelName} did not update URL — will fallback.`,
        );
      }
      return landed;
    } catch {
      return false;
    }
  }

  private async tryPostInChannel(
    page: Page,
    input: {
      channelId: string;
      channelName: string;
      channelUrl: string;
      guildId: string;
      isFirstChannel: boolean;
      message: string;
    },
  ): Promise<DiscordUiChannelResult> {
    try {
      if (input.isFirstChannel) {
        // First channel in a server: full navigation is expected and natural
        await page.goto(input.channelUrl, {
          waitUntil: 'domcontentloaded',
          timeout: this.navigationTimeoutMs,
        });
        await page.waitForTimeout(this.jitter(1800, 600));
      } else {
        // Subsequent channels: click the sidebar link — no reload, like a real user
        const clicked = await this.clickChannelInSidebar(
          page,
          input.guildId,
          input.channelId,
          input.channelName,
        );
        if (!clicked) {
          this.logger.warn(
            `Discord: sidebar click failed for #${input.channelName} — falling back to navigation.`,
          );
          await page.goto(input.channelUrl, {
            waitUntil: 'domcontentloaded',
            timeout: this.navigationTimeoutMs,
          });
        }
        await page.waitForTimeout(this.jitter(1200, 400));
      }

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

      // Simulate reading the channel before posting
      await this.simulateChannelReading(page);

      // Move mouse naturally to composer, then click
      await this.humanMouseMove(page, composer);
      await page.waitForTimeout(this.jitter(120, 60));
      await composer.click();

      // Brief dwell after focus — humans glance at the box before typing
      await page.waitForTimeout(this.jitter(350, 150));

      await this.typeMultilineMessage(page, input.message);

      // Short pause before hitting Enter — proofreading moment
      await page.waitForTimeout(this.jitter(500, 250));
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

      // Linger after send — humans don't instantly navigate away
      await page.waitForTimeout(this.jitter(this.postDelayMs, this.postDelayMs * 0.4));

      // Occasionally scroll up slightly (reading own post)
      if (Math.random() < 0.4) {
        await page.mouse.wheel(0, -this.randInt(30, 100));
        await page.waitForTimeout(this.jitter(400, 150));
      }

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
        await this.typeHumanLike(page, lines[i]);
      }
      if (i < lines.length - 1) {
        // Shift+Enter inserts a soft line break inside the composer
        // without sending the message.
        await page.keyboard.down('Shift');
        await page.keyboard.press('Enter');
        await page.keyboard.up('Shift');
        await page.waitForTimeout(this.jitter(120, 60));
      }
    }
  }

  // Type a string character-by-character with human-realistic inter-key delays.
  private async typeHumanLike(page: Page, text: string): Promise<void> {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      await page.keyboard.type(ch, { delay: 0 });

      const r = Math.random();
      let delay: number;
      if (r < 0.03) {
        // ~3%: thinking pause (mistype hesitation)
        delay = this.randInt(300, 900);
      } else if (ch === ' ' || ch === ',' || ch === '.') {
        // After word boundary — slightly longer
        delay = this.randInt(60, 160);
      } else {
        // Normal keystroke: 35-110 ms
        delay = this.randInt(35, 110);
      }

      await page.waitForTimeout(delay);
    }
  }

  private async hasSlowmodeOrRateLimitNotice(page: Page): Promise<boolean> {
    // Only match text that means "you are currently blocked from sending".
    // Do NOT include generic slowmode labels like "Slow Mode is enabled" or
    // "Slowmode: 5s" — those are permanent channel badges, not active blocks,
    // and matching them caused every slowmode-configured channel to be skipped.
    const noticePatterns = [
      /you are sending messages too quickly/i,
      /you are being rate limited/i,
      /please wait \d+ second/i,
      /must wait \d+ second/i,
      /slow mode.*\d+s/i,
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
    const patterns = [
      /you do not have permission to send messages in this channel/i,
      /cannot send messages in this channel/i,
      /this channel is.*read.?only/i,
      /this channel has been locked/i,
      /only admins can post/i,
    ];
    for (const pattern of patterns) {
      const visible = await page
        .getByText(pattern)
        .first()
        .isVisible({ timeout: 400 })
        .catch(() => false);
      if (visible) return true;
    }
    return false;
  }

  private async findComposer(
    page: Page,
  ): Promise<ReturnType<Page['locator']> | null> {
    const selectors = [
      // Slate.js editor — primary Discord composer
      'div[role="textbox"][data-slate-editor="true"]',
      // Aria-label variants Discord uses for different channel types
      'div[aria-label^="Message #"][role="textbox"]',
      'div[aria-label^="Message @"][role="textbox"]',
      'div[aria-label^="Message "][role="textbox"]',
      // Generic contenteditable within the message form (fallback)
      'form[class*="form"] div[contenteditable="true"]',
      'div[class*="textArea"] div[contenteditable="true"]',
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector);
      const count = await locator.count().catch(() => 0);
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

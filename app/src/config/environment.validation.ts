import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  // Bind all interfaces so Docker port publishing works (127.0.0.1-only breaks host access).
  LISTEN_HOST: Joi.string().default('0.0.0.0'),
  SWAGGER_ENABLED: Joi.boolean().default(false),
  ADMIN_API_KEY: Joi.string().allow('').optional(),

  DATABASE_URL: Joi.string().uri().required(),

  REDIS_HOST: Joi.string().default('127.0.0.1'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),

  // --- REDDIT CONFIG ---
  // Legacy direct OAuth keys (deprecated; retained for backward compatibility)
  REDDIT_CLIENT_ID: Joi.string().allow('').optional(),
  REDDIT_CLIENT_SECRET: Joi.string().allow('').optional(),
  REDDIT_USER_AGENT: Joi.string().default('stock-promo-bot/1.0'),
  REDDIT_RAPIDAPI_KEY: Joi.string().allow('').optional(),
  REDDIT_RAPIDAPI_HOST: Joi.string().allow('').optional(),
  REDDIT_RAPIDAPI_BASE_URL: Joi.string().uri().allow('').optional(),
  REDDIT_RAPIDAPI_PATH_TEMPLATE: Joi.string()
    .default('/reddit/r/{subreddit}/hot')
    .custom((value: string, helpers) => {
      if (!value.includes('{subreddit}')) {
        return helpers.error('any.custom', {
          message: 'REDDIT_RAPIDAPI_PATH_TEMPLATE must include {subreddit}.',
        });
      }
      return value;
    }),
  REDDIT_RAPIDAPI_METHOD: Joi.string().valid('GET', 'POST').default('GET'),
  REDDIT_RAPIDAPI_LIMIT_PARAM: Joi.string().default('limit'),
  REDDIT_RAPIDAPI_TIME_PARAM: Joi.string().default('time'),
  REDDIT_RAPIDAPI_TIME_VALUE: Joi.string()
    .valid('hour', 'day', 'week', 'month', 'year', 'all')
    .default('day'),
  REDDIT_RAPIDAPI_QUERY_PARAM: Joi.string().default('q'),
  REDDIT_QUERY_KEYWORDS: Joi.string().allow('').optional(),
  REDDIT_QUERY_KEYWORD_LIMIT: Joi.number()
    .integer()
    .min(1)
    .max(100)
    .default(18),
  REDDIT_REQUIRE_KEYWORD_MATCH: Joi.boolean().default(false),
  REDDIT_ENABLE_WATCHLIST_KEYWORDS: Joi.boolean().default(true),
  REDDIT_ENABLE_THEME_KEYWORDS: Joi.boolean().default(true),
  REDDIT_EMPTY_RETRY_ATTEMPTS: Joi.number().integer().min(0).max(10).default(2),
  REDDIT_EMPTY_RETRY_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .max(10000)
    .default(250),
  REDDIT_RETRY_KEYWORD_SLICE_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(50)
    .default(8),
  REDDIT_EMPTY_RETRY_TIME_VALUES: Joi.string().default('day,week,month'),
  REDDIT_MIN_QUALIFIED_POSTS: Joi.number().integer().min(1).max(100).default(1),
  REDDIT_SYNC_TREND_WINDOW: Joi.boolean().default(true),
  REDDIT_RAPIDAPI_ITEMS_PATH: Joi.string().default('data.children'),
  REDDIT_RAPIDAPI_ITEM_DATA_PATH: Joi.string().default('data'),
  REDDIT_SUBREDDITS: Joi.string().default('stocks,investing,wallstreetbets'),
  REDDIT_FETCH_LIMIT: Joi.number().integer().min(1).max(100).default(25),
  REDDIT_MOCK_DATA_JSON: Joi.string().allow('').optional(),

  // --- TRENDS & ANALYSIS CONFIG ---
  WATCHLIST_SYMBOLS: Joi.string().default('AAPL,TSLA,NVDA,BTC,ETH'),
  STOCKTWITS_SIGNAL_API_URL: Joi.string().uri().allow('').optional(),
  STOCKTWITS_SIGNAL_MOCK_DATA_JSON: Joi.string().allow('').optional(),
  NEWS_SENTIMENT_API_URL: Joi.string().uri().allow('').optional(),
  NEWS_SENTIMENT_API_KEY: Joi.string().allow('').optional(),
  NEWS_MOCK_DATA_JSON: Joi.string().allow('').optional(),

  // --- AI MODELS ---
  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL: Joi.string().default('gpt-4.1-mini'),
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  ANTHROPIC_MODEL: Joi.string().default('claude-3-5-sonnet-latest'),

  // --- MESSAGING ---
  TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional(),
  TELEGRAM_BOT_ACCOUNTS_JSON: Joi.string().allow('').optional(),
  TELEGRAM_DEFAULT_CHAT_IDS: Joi.string().allow('').optional(),
  TELEGRAM_DISCOVERY_SEEDS: Joi.string().allow('').optional(),
  DISCORD_UI_SERVER_URL: Joi.string().uri().allow('').optional(),
  DISCORD_UI_LOGIN_EMAIL: Joi.string().allow('').optional(),
  DISCORD_UI_LOGIN_PASSWORD: Joi.string().allow('').optional(),
  DISCORD_UI_HEADLESS: Joi.boolean().default(false),
  DISCORD_UI_USER_DATA_DIR: Joi.string().allow('').optional(),
  DISCORD_UI_BROWSER_BINARY: Joi.string().allow('').optional(),
  DISCORD_UI_NAV_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(180000)
    .default(30000),
  DISCORD_UI_MANUAL_LOGIN_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(120000),
  DISCORD_UI_POST_DELAY_MS: Joi.number()
    .integer()
    .min(0)
    .max(10000)
    .default(800),
  DISCORD_UI_INTER_CHANNEL_DELAY_MIN_MS: Joi.number()
    .integer()
    .min(0)
    .max(60000)
    .default(2000),
  DISCORD_UI_INTER_CHANNEL_DELAY_MAX_MS: Joi.number()
    .integer()
    .min(0)
    .max(120000)
    .default(5000),
  DISCORD_UI_POST_CONFIRM_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60000)
    .default(8000),

  // --- STOCKTWITS PUBLISHER ---
  STOCKTWITS_LOGIN_URL: Joi.string()
    .uri()
    .default('https://stocktwits.com/signin'),
  STOCKTWITS_POST_URL: Joi.string().uri().default('https://stocktwits.com'),
  STOCKTWITS_ACCOUNTS_JSON: Joi.string().allow('').optional(),
  STOCKTWITS_HEADLESS: Joi.boolean().default(true),
  STOCKTWITS_USER_DATA_DIR: Joi.string().allow('').optional(),
  STOCKTWITS_BROWSER_BINARY: Joi.string().allow('').optional(),
  // Optional proxy support (browser-level). Use either the single proxy vars
  // below OR the rotating pool JSON. If both are set, the pool wins.
  // Single-line proxy: user:pass@host:port (e.g. DataImpulse). Parsed before
  // STOCKTWITS_PROXY_SERVER when set. Pool JSON still wins if present.
  STOCKTWITS_PROXY: Joi.string().allow('').optional(),
  STOCKTWITS_PROXY_SERVER: Joi.string().allow('').optional(), // e.g. http://host:port
  STOCKTWITS_PROXY_USERNAME: Joi.string().allow('').optional(),
  STOCKTWITS_PROXY_PASSWORD: Joi.string().allow('').optional(),
  STOCKTWITS_PROXY_BYPASS: Joi.string().allow('').optional(), // comma-separated hosts
  STOCKTWITS_PROXIES_JSON: Joi.string().allow('').optional(), // JSON array of proxy objects
  STOCKTWITS_PROXY_TEST_URL: Joi.string()
    .uri()
    .default('https://whoer.net'),
  // When true/false, forces headed vs headless for the manual "test proxy" button.
  // Unset = auto: headless on Linux with no $DISPLAY (Docker/CI).
  STOCKTWITS_PROXY_TEST_HEADLESS: Joi.boolean().optional(),

  // ── Residential proxy geo-alignment ──────────────────────────────────────
  // Stocktwits/Cloudflare compare the browser's JS timezone and locale against
  // the IP geolocation. A mismatch (e.g. proxy IP in UK, timezone = New_York)
  // is a high-entropy bot signal. Set these to match wherever your residential
  // proxy provider routes traffic (check the proxy test page for IP location).
  //
  // Examples (US proxies — default):
  //   STOCKTWITS_PROXY_GEO_TIMEZONE=America/New_York
  //   STOCKTWITS_PROXY_GEO_LOCALE=en-US
  // Examples (UK residential):
  //   STOCKTWITS_PROXY_GEO_TIMEZONE=Europe/London
  //   STOCKTWITS_PROXY_GEO_LOCALE=en-GB
  STOCKTWITS_PROXY_GEO_TIMEZONE: Joi.string().allow('').optional(),
  STOCKTWITS_PROXY_GEO_LOCALE:   Joi.string().allow('').optional(),

  // ── Sticky session support for rotating residential proxies ──────────────
  // Rotating proxies change IPs between requests by default. A session change
  // mid-flow (login on IP A, POST on IP B) immediately flags the Stocktwits
  // session as suspicious. Most residential proxy providers support sticky
  // sessions by appending a session ID to the username.
  //
  // Set STOCKTWITS_PROXY_STICKY_SUFFIX to the separator your provider uses.
  // The system will append it + a per-account deterministic token to lock one
  // IP for the entire session.
  //
  // Provider examples:
  //   DataImpulse:  STOCKTWITS_PROXY_STICKY_SUFFIX=_session-
  //     → username becomes: f076_xxxxx__cr.us_session-abc123
  //   Bright Data:  STOCKTWITS_PROXY_STICKY_SUFFIX=-session-
  //     → username becomes: user-session-abc123
  //   Oxylabs:      STOCKTWITS_PROXY_STICKY_SUFFIX=-sessid-
  //   IPRoyal:      STOCKTWITS_PROXY_STICKY_SUFFIX=_session_
  STOCKTWITS_PROXY_STICKY_SUFFIX: Joi.string().allow('').optional(),

  // How many minutes a sticky session ID is held before rotating to a new one.
  // Shorter = more IP changes but lower re-use risk. 60 min is a safe default.
  STOCKTWITS_PROXY_SESSION_ROTATION_MINUTES: Joi.number()
    .integer()
    .min(5)
    .max(480)
    .default(60),

  // Set true if your residential proxy provider uses self-signed or MITM TLS
  // certificates (some Bright Data, Oxylabs, Smartproxy setups do). Without
  // this, Chromium shows a certificate error and the page never loads.
  STOCKTWITS_PROXY_ACCEPT_INSECURE_CERTS: Joi.boolean().default(false),
  // URL used for the proxy test when running headless (JSON IP is easiest to parse).
  STOCKTWITS_PROXY_TEST_URL_HEADLESS: Joi.string()
    .uri()
    .default('https://api.ipify.org?format=json'),
  // After ipify (headless), open this page and capture a screenshot for the manual UI (default whoer).
  STOCKTWITS_PROXY_TEST_VISUAL_URL: Joi.string()
    .uri()
    .default('https://whoer.net'),
  STOCKTWITS_PROXY_TEST_VISUAL_WAIT_MS: Joi.number()
    .integer()
    .min(0)
    .max(120_000)
    .default(5_000),
  STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(120000),
  STOCKTWITS_NAV_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(180000)
    .default(45000),
  STOCKTWITS_PUBLISH_CONFIRM_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(120000)
    .default(30000),
  STOCKTWITS_TARGET_SYMBOLS: Joi.string().allow('').optional(),
  // Stocktwits raised the limit to 1,000 characters for all accounts in Dec 2021.
  STOCKTWITS_MAX_MESSAGE_LENGTH: Joi.number().integer().min(10).max(1000).default(1000),
  // When true, the full pipeline runs (compliance, policy checks) but NO actual
  // post is sent to dlvr.it or Playwright. Use for integration testing.
  STOCKTWITS_DRY_RUN: Joi.boolean().default(false),
  CAPSOLVER_API_KEY: Joi.string().allow('').optional(),

  // --- DLVR.IT INTEGRATION (PRIMARY POSTING CHANNEL) ---
  // dlvr.it is an official StockTwits API partner. Posts originate from
  // dlvr.it's servers using their vetted OAuth token — no browser, no proxy,
  // no fingerprinting, zero muting risk.
  //
  // Setup:
  //   1. Create an account at dlvrit.com
  //   2. Go to Account Settings → API Key and copy your key
  //   3. Go to Connect Accounts → StockTwits and connect each posting account
  //   4. Set DLVRIT_API_KEY below
  //
  // The automated pipeline uses dlvr.it by default. Set
  // STOCKTWITS_USE_LEGACY_POSTER=true only as a temporary rollback to Playwright.
  DLVRIT_API_KEY: Joi.string().allow('').optional(),
  DLVRIT_SESSION_COOKIE: Joi.string().allow('').optional(),
  DLVRIT_USER_DATA_DIR: Joi.string().allow('').optional(),
  DLVRIT_HEADLESS: Joi.string().allow('').optional(),
  DLVRIT_LOGIN_EMAIL: Joi.string().allow('').optional(),
  DLVRIT_LOGIN_PASSWORD: Joi.string().allow('').optional(),

  // ── Account warm-up gate ─────────────────────────────────────────────────
  // New accounts that immediately post promotional content get muted fastest.
  // StockTwits requires the first 50 posts to be non-promotional.
  // Set this to 50 (or higher) and let accounts build post history first.
  // Default 0 = gate disabled (backward compatible — flip to 50 once you have
  // a warm-up content flow running for new accounts).
  STOCKTWITS_MIN_WARMUP_POSTS: Joi.number().integer().min(0).max(500).default(0),

  // ── Market hours enforcement ──────────────────────────────────────────────
  // When true, promotional posts are only executed Mon–Fri 8 AM–6 PM ET.
  // Off-hours posting from automated accounts raises the spam-signal score.
  STOCKTWITS_ENFORCE_MARKET_HOURS: Joi.boolean().default(false),

  // ── Transport selection ───────────────────────────────────────────────────
  // true (default): post via the Playwright stealth browser (patchright).
  // false:           post via dlvr.it official API → direct OAuth token fallback.
  //                  Use false only when you have DLVRIT_API_KEY configured and
  //                  want the proxy-free official-API path.
  STOCKTWITS_USE_LEGACY_POSTER: Joi.boolean().default(false),

  // ── Posting discipline (PostingPolicyService) ─────────────────────────────
  // Token-bucket: max posts per hour per dlvr.it account.
  // StockTwits does not publish a hard limit; 10/hour is conservative and
  // matches the cadence of well-behaved third-party clients.
  STOCKTWITS_API_RATE_LIMIT_PER_HOUR: Joi.number().integer().min(1).max(200).default(10),
  // Minimum milliseconds to wait between consecutive posts for the same account.
  // Default 5 min. Jitter up to STOCKTWITS_API_MAX_INTER_POST_MS is added on top.
  STOCKTWITS_API_MIN_INTER_POST_MS: Joi.number()
    .integer()
    .min(10_000)
    .max(3_600_000)
    .default(300_000),
  // Upper bound for the randomised inter-post jitter window.
  STOCKTWITS_API_MAX_INTER_POST_MS: Joi.number()
    .integer()
    .min(10_000)
    .max(3_600_000)
    .default(600_000),
  // Rolling window (minutes) in which identical content hashes are rejected
  // before they even reach dlvr.it — duplicate content is a primary mute trigger.
  STOCKTWITS_API_DEDUP_WINDOW_MINUTES: Joi.number()
    .integer()
    .min(1)
    .max(1440)
    .default(60),

  // --- PIPELINE & QUOTAS ---
  PIPELINE_CRON: Joi.string().default('*/5 * * * *'),
  PIPELINE_MIN_ACTIVE_SOURCES: Joi.number().integer().min(1).max(3).default(2),
  TREND_WINDOWS_HOURS: Joi.string().default('1,6,24'),
  TREND_MIN_WEIGHTED_MENTIONS: Joi.number().min(0).default(1),
  TREND_MIN_UNIQUE_EVENTS: Joi.number().integer().min(1).default(1),
  TREND_MIN_SCORE: Joi.number().default(0),
  TOP_TRENDS_LIMIT: Joi.number().integer().min(1).max(100).default(10),
  AUTO_APPROVAL_MIN_SCORE: Joi.number().default(0.75),
  CONTENT_PROMPT_VERSION: Joi.string().default('phase1-v1'),
  CONTENT_DISCLOSURE_VERSION: Joi.string().default('v1'),
  CONTENT_VARIATION_MAX_ATTEMPTS: Joi.number()
    .integer()
    .min(1)
    .max(10)
    .default(3),
  CONTENT_MAX_SIMILARITY: Joi.number().min(0.5).max(0.99).default(0.72),
  PUBLISH_COOLDOWN_MINUTES: Joi.number().integer().min(1).default(90),
  PUBLISH_MAX_RETRIES: Joi.number().integer().min(1).max(10).default(3),
  PUBLISH_RETRY_DELAY_SECONDS: Joi.number()
    .integer()
    .min(5)
    .max(600)
    .default(30),
  PUBLISH_DEAD_LETTER_ENABLED: Joi.boolean().default(true),
  PUBLISH_REPLAY_BATCH_SIZE: Joi.number()
    .integer()
    .min(1)
    .max(1000)
    .default(200),
  PHASE2_PER_ACCOUNT_QUOTA: Joi.number().integer().min(1).default(4),
  PHASE2_GLOBAL_QUOTA: Joi.number().integer().min(1).default(12),
  PHASE2_QUIET_HOURS_START: Joi.number().integer().min(0).max(23).optional(),
  PHASE2_QUIET_HOURS_END: Joi.number().integer().min(0).max(23).optional(),
  PHASE2_MIN_DELAY_MINUTES: Joi.number().integer().min(1).default(10),
  PHASE2_MAX_DELAY_MINUTES: Joi.number().integer().min(1).default(45),
  PHASE2_ADAPTIVE_COOLDOWN_MINUTES: Joi.number().integer().min(1).default(30),
  PHASE2_DUPLICATE_SIMILARITY_THRESHOLD: Joi.number()
    .min(0.5)
    .max(1)
    .default(0.82),
  SOURCE_CONNECTOR_WEIGHTS_JSON: Joi.string().allow('').optional(),
  SOURCE_CONNECTOR_PRIORITIES_JSON: Joi.string().allow('').optional(),
  HTTP_REQUEST_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(120000)
    .default(10000),
  HTTP_MAX_RETRIES: Joi.number().integer().min(0).max(6).default(2),
  RETENTION_ENABLED: Joi.boolean().default(true),
  RETENTION_CRON: Joi.string().default('15 2 * * *'),
  RETENTION_SOURCE_EVENTS_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(3650)
    .default(30),
  RETENTION_AUDIT_EVENTS_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(3650)
    .default(365),
  RETENTION_PUBLISH_ATTEMPTS_DAYS: Joi.number()
    .integer()
    .min(1)
    .max(3650)
    .default(90),
  RETENTION_DLQ_DAYS: Joi.number().integer().min(1).max(3650).default(180),
}).custom((value, helpers) => {
  const env = value as Record<string, unknown>;
  const isDevelopment = env.NODE_ENV === 'development';

  // In non-development environments, require at least one live secondary source.
  const hasSecondarySource = Boolean(
    (env.STOCKTWITS_SIGNAL_API_URL as string | undefined)?.trim() ||
      (env.NEWS_SENTIMENT_API_URL as string | undefined)?.trim(),
  );

  if (!isDevelopment && !hasSecondarySource) {
    return helpers.error('any.custom', {
      message:
        'At least one live secondary trend connector must be configured outside development: STOCKTWITS_SIGNAL_API_URL or NEWS_SENTIMENT_API_URL.',
    });
  }

  const isProduction = env.NODE_ENV === 'production';
  const adminApiKey = (env.ADMIN_API_KEY as string | undefined)?.trim() ?? '';
  if (isProduction && adminApiKey.length === 0) {
    return helpers.error('any.custom', {
      message:
        'ADMIN_API_KEY must be configured in production to protect orchestration and publishing endpoints.',
    });
  }

  const minDelayMinutes = Number(env.PHASE2_MIN_DELAY_MINUTES ?? 10);
  const maxDelayMinutes = Number(env.PHASE2_MAX_DELAY_MINUTES ?? 45);
  if (minDelayMinutes > maxDelayMinutes) {
    return helpers.error('any.custom', {
      message:
        'PHASE2_MIN_DELAY_MINUTES cannot be greater than PHASE2_MAX_DELAY_MINUTES.',
    });
  }

  const rawStocktwitsJson =
    (env.STOCKTWITS_ACCOUNTS_JSON as string | undefined)?.trim() || '';
  if (rawStocktwitsJson.length > 0) {
    let parsedAccounts: unknown;
    try {
      parsedAccounts = JSON.parse(rawStocktwitsJson);
    } catch {
      return helpers.error('any.custom', {
        message: 'STOCKTWITS_ACCOUNTS_JSON must be valid JSON.',
      });
    }

    if (!Array.isArray(parsedAccounts)) {
      return helpers.error('any.custom', {
        message: 'STOCKTWITS_ACCOUNTS_JSON must be a JSON array.',
      });
    }

    const validAccounts = parsedAccounts.filter((item) => {
      if (!item || typeof item !== 'object') {
        return false;
      }
      const row = item as Record<string, unknown>;
      const handle = typeof row.handle === 'string' ? row.handle.trim() : '';
      const username =
        typeof row.username === 'string' ? row.username.trim() : '';
      const password =
        typeof row.password === 'string' ? row.password.trim() : '';

      const containsPlaceholder = [handle, username, password].some((field) =>
        /your_|placeholder|example|replace/i.test(field),
      );

      return (
        handle.length > 0 &&
        username.length > 0 &&
        password.length > 0 &&
        !containsPlaceholder
      );
    });

    if (validAccounts.length === 0) {
      return helpers.error('any.custom', {
        message:
          'STOCKTWITS_ACCOUNTS_JSON must include at least one account with non-placeholder handle, username, and password.',
      });
    }
  }

  return env;
}, 'phase-1 secondary source validation');

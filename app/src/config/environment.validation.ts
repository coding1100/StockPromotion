import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().port().default(3000),
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
          message:
            'REDDIT_RAPIDAPI_PATH_TEMPLATE must include {subreddit}.',
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
  REDDIT_QUERY_KEYWORD_LIMIT: Joi.number().integer().min(1).max(100).default(18),
  REDDIT_REQUIRE_KEYWORD_MATCH: Joi.boolean().default(false),
  REDDIT_ENABLE_WATCHLIST_KEYWORDS: Joi.boolean().default(true),
  REDDIT_ENABLE_THEME_KEYWORDS: Joi.boolean().default(true),
  REDDIT_EMPTY_RETRY_ATTEMPTS: Joi.number().integer().min(0).max(10).default(2),
  REDDIT_EMPTY_RETRY_DELAY_MS: Joi.number().integer().min(0).max(10000).default(250),
  REDDIT_RETRY_KEYWORD_SLICE_SIZE: Joi.number().integer().min(1).max(50).default(8),
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

  // --- STOCKTWITS PUBLISHER ---
  STOCKTWITS_LOGIN_URL: Joi.string()
    .uri()
    .default('https://stocktwits.com/signin'),
  STOCKTWITS_POST_URL: Joi.string().uri().default('https://stocktwits.com'),
  STOCKTWITS_ACCOUNTS_JSON: Joi.string().allow('').optional(),
  STOCKTWITS_HEADLESS: Joi.boolean().default(true),
  STOCKTWITS_USER_DATA_DIR: Joi.string().allow('').optional(),
  STOCKTWITS_BROWSER_BINARY: Joi.string().allow('').optional(),
  STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(120000),

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
  CONTENT_VARIATION_MAX_ATTEMPTS: Joi.number().integer().min(1).max(10).default(3),
  CONTENT_MAX_SIMILARITY: Joi.number().min(0.5).max(0.99).default(0.72),
  PUBLISH_COOLDOWN_MINUTES: Joi.number().integer().min(1).default(90),
  PUBLISH_MAX_RETRIES: Joi.number().integer().min(1).max(10).default(3),
  PUBLISH_RETRY_DELAY_SECONDS: Joi.number().integer().min(5).max(600).default(30),
  PUBLISH_DEAD_LETTER_ENABLED: Joi.boolean().default(true),
  PUBLISH_REPLAY_BATCH_SIZE: Joi.number().integer().min(1).max(1000).default(200),
  PHASE2_PER_ACCOUNT_QUOTA: Joi.number().integer().min(1).default(4),
  PHASE2_GLOBAL_QUOTA: Joi.number().integer().min(1).default(12),
  PHASE2_QUIET_HOURS_START: Joi.number().integer().min(0).max(23).optional(),
  PHASE2_QUIET_HOURS_END: Joi.number().integer().min(0).max(23).optional(),
  PHASE2_MIN_DELAY_MINUTES: Joi.number().integer().min(1).default(10),
  PHASE2_MAX_DELAY_MINUTES: Joi.number().integer().min(1).default(45),
  PHASE2_ADAPTIVE_COOLDOWN_MINUTES: Joi.number().integer().min(1).default(30),
  PHASE2_DUPLICATE_SIMILARITY_THRESHOLD: Joi.number().min(0.5).max(1).default(0.82),
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
  RETENTION_SOURCE_EVENTS_DAYS: Joi.number().integer().min(1).max(3650).default(30),
  RETENTION_AUDIT_EVENTS_DAYS: Joi.number().integer().min(1).max(3650).default(365),
  RETENTION_PUBLISH_ATTEMPTS_DAYS: Joi.number().integer().min(1).max(3650).default(90),
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

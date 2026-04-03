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

  REDDIT_CLIENT_ID: Joi.string().allow('').optional(),
  REDDIT_CLIENT_SECRET: Joi.string().allow('').optional(),
  REDDIT_USER_AGENT: Joi.string().default('stock-promo-bot/1.0'),
  REDDIT_SUBREDDITS: Joi.string().default('stocks,investing,wallstreetbets'),
  REDDIT_FETCH_LIMIT: Joi.number().integer().min(1).max(100).default(25),
  REDDIT_MOCK_ENABLED: Joi.boolean().default(false),
  REDDIT_MOCK_DATA_JSON: Joi.string().allow('').optional(),

  WATCHLIST_SYMBOLS: Joi.string().default('AAPL,TSLA,NVDA,BTC,ETH'),
  STOCKTWITS_SIGNAL_API_URL: Joi.string().uri().allow('').optional(),
  STOCKTWITS_SIGNAL_MOCK_ENABLED: Joi.boolean().default(false),
  STOCKTWITS_SIGNAL_MOCK_DATA_JSON: Joi.string().allow('').optional(),
  NEWS_SENTIMENT_API_URL: Joi.string().uri().allow('').optional(),
  NEWS_SENTIMENT_API_KEY: Joi.string().allow('').optional(),
  NEWS_MOCK_ENABLED: Joi.boolean().default(false),
  NEWS_MOCK_DATA_JSON: Joi.string().allow('').optional(),

  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL: Joi.string().default('gpt-4.1-mini'),
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  ANTHROPIC_MODEL: Joi.string().default('claude-3-5-sonnet-latest'),

  TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional(),
  TELEGRAM_BOT_ACCOUNTS_JSON: Joi.string().allow('').optional(),
  TELEGRAM_DEFAULT_CHAT_IDS: Joi.string().allow('').optional(),
  TELEGRAM_DISCOVERY_SEEDS: Joi.string().allow('').optional(),

  STOCKTWITS_LOGIN_URL: Joi.string()
    .uri()
    .default('https://stocktwits.com/signin'),
  STOCKTWITS_POST_URL: Joi.string().uri().default('https://stocktwits.com'),
  STOCKTWITS_ACCOUNTS_JSON: Joi.string().allow('').optional(),
  STOCKTWITS_HEADLESS: Joi.boolean().default(true),
  STOCKTWITS_USER_DATA_DIR: Joi.string().allow('').optional(),
  STOCKTWITS_MANUAL_LOGIN_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(120000),

  PIPELINE_CRON: Joi.string().default('*/5 * * * *'),
  TOP_TRENDS_LIMIT: Joi.number().integer().min(1).max(50).default(10),
  AUTO_APPROVAL_MIN_SCORE: Joi.number().default(0.75),
  PUBLISH_COOLDOWN_MINUTES: Joi.number().integer().min(1).default(90),
  PUBLISH_MAX_RETRIES: Joi.number().integer().min(1).max(10).default(3),
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
}).custom((value, helpers) => {
  const env = value as Record<string, unknown>;
  const hasSecondarySource = Boolean(
    (env.STOCKTWITS_SIGNAL_API_URL as string | undefined)?.trim() ||
    (env.NEWS_SENTIMENT_API_URL as string | undefined)?.trim() ||
    env.STOCKTWITS_SIGNAL_MOCK_ENABLED === true ||
    env.NEWS_MOCK_ENABLED === true,
  );
  if (!hasSecondarySource) {
    return helpers.error('any.custom', {
      message:
        'At least one additional trend connector must be configured: STOCKTWITS_SIGNAL_API_URL or NEWS_SENTIMENT_API_URL.',
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

  return env;
}, 'phase-1 secondary source validation');

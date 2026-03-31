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

  WATCHLIST_SYMBOLS: Joi.string().default('AAPL,TSLA,NVDA,BTC,ETH'),
  STOCKTWITS_SIGNAL_API_URL: Joi.string().uri().allow('').optional(),
  NEWS_SENTIMENT_API_URL: Joi.string().uri().allow('').optional(),
  NEWS_SENTIMENT_API_KEY: Joi.string().allow('').optional(),

  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_MODEL: Joi.string().default('gpt-4.1-mini'),
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  ANTHROPIC_MODEL: Joi.string().default('claude-3-5-sonnet-latest'),

  TELEGRAM_BOT_TOKEN: Joi.string().allow('').optional(),
  TELEGRAM_DEFAULT_CHAT_IDS: Joi.string().allow('').optional(),
  TELEGRAM_DISCOVERY_SEEDS: Joi.string().allow('').optional(),

  STOCKTWITS_LOGIN_URL: Joi.string()
    .uri()
    .default('https://stocktwits.com/signin'),
  STOCKTWITS_POST_URL: Joi.string().uri().default('https://stocktwits.com'),
  STOCKTWITS_ACCOUNTS_JSON: Joi.string().allow('').optional(),

  PIPELINE_CRON: Joi.string().default('*/5 * * * *'),
  TOP_TRENDS_LIMIT: Joi.number().integer().min(1).max(50).default(10),
  AUTO_APPROVAL_MIN_SCORE: Joi.number().default(0.75),
  PUBLISH_COOLDOWN_MINUTES: Joi.number().integer().min(1).default(90),
  PUBLISH_MAX_RETRIES: Joi.number().integer().min(1).max(10).default(3),
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
    (env.NEWS_SENTIMENT_API_URL as string | undefined)?.trim(),
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

  return env;
}, 'phase-1 secondary source validation');

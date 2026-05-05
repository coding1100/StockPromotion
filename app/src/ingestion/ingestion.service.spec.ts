import { IngestionService } from './ingestion.service';

describe('IngestionService', () => {
  const makeService = (configValues: Record<string, unknown>) => {
    const prisma = {
      sourceConnectorState: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      sourceEvent: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };

    const service = new IngestionService(
      prisma as never,
      {
        get: (key: string) => configValues[key],
        getOrThrow: (key: string) => {
          const value = configValues[key];
          if (value === undefined) {
            throw new Error(`Missing key: ${key}`);
          }
          return value;
        },
      } as never,
      {
        record: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        increment: jest.fn(),
      } as never,
    );

    return {
      service,
      prisma,
    };
  };

  it('reports connector_not_configured when sources are missing', async () => {
    const configValues: Record<string, unknown> = {
      NODE_ENV: 'production',
      REDDIT_RAPIDAPI_KEY: '',
      REDDIT_RAPIDAPI_HOST: '',
      REDDIT_RAPIDAPI_BASE_URL: '',
      REDDIT_RAPIDAPI_PATH_TEMPLATE: '/reddit/r/{subreddit}/hot',
      REDDIT_RAPIDAPI_METHOD: 'GET',
      REDDIT_RAPIDAPI_LIMIT_PARAM: 'limit',
      REDDIT_RAPIDAPI_ITEMS_PATH: 'data.children',
      REDDIT_RAPIDAPI_ITEM_DATA_PATH: 'data',
      REDDIT_SUBREDDITS: 'stocks',
      REDDIT_FETCH_LIMIT: 25,
      STOCKTWITS_SIGNAL_API_URL: '',
      NEWS_SENTIMENT_API_URL: '',
      SOURCE_CONNECTOR_WEIGHTS_JSON: '{}',
      SOURCE_CONNECTOR_PRIORITIES_JSON: '{}',
      HTTP_REQUEST_TIMEOUT_MS: 10000,
      HTTP_MAX_RETRIES: 0,
    };

    const { service, prisma } = makeService(configValues);

    const summary = await service.runIngestionCycle();
    expect(summary.activeSources).toEqual([]);
    expect(summary.connectors.reddit.error).toBe('connector_not_configured');
    expect(summary.connectors.stocktwitsSignal.error).toBe(
      'connector_not_configured',
    );
    expect(summary.connectors.news.error).toBe('connector_not_configured');
    expect(prisma.sourceConnectorState.upsert).toHaveBeenCalledTimes(3);
  });

  it('considers reddit configured when RapidAPI env is set', () => {
    const configValues: Record<string, unknown> = {
      NODE_ENV: 'production',
      REDDIT_RAPIDAPI_KEY: 'key',
      REDDIT_RAPIDAPI_HOST: 'host',
      REDDIT_RAPIDAPI_BASE_URL: 'https://example-reddit-api.p.rapidapi.com',
      REDDIT_RAPIDAPI_PATH_TEMPLATE: '/reddit/r/{subreddit}/hot',
      REDDIT_SUBREDDITS: 'stocks,investing',
    };
    const { service } = makeService(configValues);
    expect((service as never as { isRedditConfigured: () => boolean }).isRedditConfigured()).toBe(true);
  });

  it('extracts nested rapidapi reddit items and unwraps item data', () => {
    const { service } = makeService({});
    const payload = {
      data: {
        children: [
          {
            data: {
              id: 'abc',
              title: 'sample',
            },
          },
        ],
      },
    };
    const rows = (
      service as never as {
        extractRapidApiItems: (
          source: Record<string, unknown>,
          itemsPath: string,
          itemDataPath: string,
        ) => Array<Record<string, unknown>>;
      }
    ).extractRapidApiItems(payload, 'data.children', 'data');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'abc', title: 'sample' });
  });

  it('syncs reddit time range from trend windows and overrides path template query', () => {
    const configValues: Record<string, unknown> = {
      TREND_WINDOWS_HOURS: '1,6,24',
    };
    const { service } = makeService(configValues);

    const timeRange = (
      service as never as {
        resolveRedditTimeRange: (config: {
          syncTrendWindow: boolean;
          timeValue: string;
        }) => string;
      }
    ).resolveRedditTimeRange({
      syncTrendWindow: true,
      timeValue: 'year',
    });

    const requestUrl = (
      service as never as {
        buildRapidApiUrl: (
          baseUrl: string,
          pathTemplate: string,
          subreddit: string,
          timeParam: string,
          timeRange: string,
        ) => string;
      }
    ).buildRapidApiUrl(
      'https://reddit34.p.rapidapi.com',
      '/getTopPostsBySubreddit?subreddit={subreddit}&time=year',
      'stocks',
      'time',
      timeRange,
    );

    expect(timeRange).toBe('day');
    expect(requestUrl).toContain('subreddit=stocks');
    expect(requestUrl).toContain('time=day');
  });
});

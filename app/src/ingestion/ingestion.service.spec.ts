import { IngestionService } from './ingestion.service';

describe('IngestionService', () => {
  it('reports connector_not_configured when sources are missing', async () => {
    const configValues: Record<string, string | number> = {
      REDDIT_CLIENT_ID: '',
      REDDIT_CLIENT_SECRET: '',
      REDDIT_USER_AGENT: 'bot',
      REDDIT_SUBREDDITS: 'stocks',
      REDDIT_FETCH_LIMIT: 25,
      STOCKTWITS_SIGNAL_API_URL: '',
      NEWS_SENTIMENT_API_URL: '',
    };

    const service = new IngestionService(
      {} as never,
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

    const summary = await service.runIngestionCycle();
    expect(summary.activeSources).toEqual([]);
    expect(summary.connectors.reddit.error).toBe('connector_not_configured');
    expect(summary.connectors.stocktwitsSignal.error).toBe(
      'connector_not_configured',
    );
    expect(summary.connectors.news.error).toBe('connector_not_configured');
  });
});

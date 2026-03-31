import { OrchestrationService } from './orchestration.service';

describe('OrchestrationService', () => {
  it('blocks pipeline when less than two sources are active', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ locked: true }])
      .mockResolvedValueOnce([{ pg_advisory_unlock: true }]);

    const service = new OrchestrationService(
      {
        $queryRaw: queryRaw,
      } as never,
      {
        runIngestionCycle: jest.fn().mockResolvedValue({
          reddit: 10,
          stocktwitsSignal: 0,
          news: 0,
          connectors: {
            reddit: {
              configured: true,
              healthy: true,
              ingested: 10,
              error: null,
            },
            stocktwitsSignal: {
              configured: false,
              healthy: false,
              ingested: 0,
              error: 'connector_not_configured',
            },
            news: {
              configured: false,
              healthy: false,
              ingested: 0,
              error: 'connector_not_configured',
            },
          },
          activeSources: ['reddit'],
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {
        record: jest.fn().mockResolvedValue(undefined),
      } as never,
      {
        increment: jest.fn(),
      } as never,
      {
        add: jest.fn(),
      } as never,
    );

    await expect(service.runPipeline('manual')).rejects.toThrow(
      /at least 2 active sources/i,
    );
    expect(queryRaw).toHaveBeenCalledTimes(2);
  });
});

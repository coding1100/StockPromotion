import { TrendWindow } from '@prisma/client';
import { TrendsService } from './trends.service';

describe('TrendsService', () => {
  it('creates trends for 1h, 6h, and 24h windows', async () => {
    const createdRows: Array<{ windowType: TrendWindow }> = [];

    const prisma = {
      sourceConnectorState: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      sourceEvent: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            symbols: ['AAPL'],
            engagementScore: 30,
            sentimentScore: 0.4,
          },
        ]),
      },
      trendTopic: {
        create: jest
          .fn()
          .mockImplementation((args: { data: { windowType: TrendWindow } }) => {
            createdRows.push({ windowType: args.data.windowType });
            return Promise.resolve({
              id: `t-${createdRows.length}`,
              ...args.data,
              createdAt: new Date(),
            });
          }),
      },
    };

    const configService = {
      get: jest.fn().mockReturnValue('1,6,24'),
      getOrThrow: jest.fn().mockReturnValue(1),
    };
    const auditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    const telemetryService = {
      increment: jest.fn(),
    };

    const service = new TrendsService(
      prisma as never,
      configService as never,
      auditService as never,
      telemetryService as never,
    );

    const trends = await service.computeTrends();

    expect(trends).toHaveLength(3);
    expect(createdRows.map((row) => row.windowType)).toEqual([
      TrendWindow.H1,
      TrendWindow.H6,
      TrendWindow.H24,
    ]);
    expect(prisma.sourceEvent.findMany).toHaveBeenCalledTimes(1);
  });
});

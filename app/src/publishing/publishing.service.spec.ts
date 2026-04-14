import {
  AccountPlatform,
  DraftStatus,
  PublishPlatform,
} from '@prisma/client';
import { PublishingService } from './publishing.service';

function createService() {
  const prisma = {
    contentDraft: {
      findUnique: jest.fn(),
    },
    telegramGroupCandidate: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };

  const configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'TELEGRAM_DISCOVERY_SEEDS') {
        return '';
      }
      return undefined;
    }),
    getOrThrow: jest.fn().mockImplementation((key: string) => {
      if (key === 'PUBLISH_COOLDOWN_MINUTES') {
        return 90;
      }
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };

  const accountsService = {
    syncAccountsFromConfig: jest.fn().mockResolvedValue(undefined),
    getRotationPolicy: jest.fn().mockImplementation(async (platform: AccountPlatform) => {
      if (platform === AccountPlatform.STOCKTWITS) {
        return {
          minDelayMinutes: 1,
          maxDelayMinutes: 1,
          duplicateSimilarityThreshold: 0.82,
        };
      }

      return {
        minDelayMinutes: 1,
        maxDelayMinutes: 1,
        duplicateSimilarityThreshold: 0.82,
      };
    }),
    getEligibleAccount: jest.fn(),
    getStocktwitsCredentials: jest.fn(),
  };

  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  };

  const telegramPublisher = {
    inspectChatAccess: jest.fn(),
    sendMessage: jest.fn(),
  };

  const stocktwitsPublisher = {
    discoverTopTrendingSymbols: jest.fn(),
    publish: jest.fn(),
  };

  const telemetryService = {
    increment: jest.fn(),
  };

  const publishQueue = {
    add: jest.fn(),
  };

  const service = new PublishingService(
    prisma as never,
    configService as never,
    accountsService as never,
    auditService as never,
    telegramPublisher as never,
    stocktwitsPublisher as never,
    telemetryService as never,
    publishQueue as never,
  );

  return {
    service,
    mocks: {
      prisma,
      configService,
      accountsService,
      auditService,
      stocktwitsPublisher,
      telemetryService,
    },
  };
}

describe('PublishingService stocktwits top-trending scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates stocktwits jobs for discovered top symbols and sets symbol as targetRef', async () => {
    const { service, mocks } = createService();

    jest
      .spyOn(service, 'syncTelegramCandidatesFromSeed')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'attemptApprovedTelegramJoins').mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'resolveStocktwitsTrendingSymbolsForCycle')
      .mockResolvedValue(['ORCL', 'IREN']);
    jest
      .spyOn(service as never, 'resolveTelegramTargets')
      .mockResolvedValue([]);
    const createSpy = jest
      .spyOn(service as never, 'createAndQueuePublishJob')
      .mockResolvedValue(1);

    mocks.prisma.contentDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      status: DraftStatus.AUTO_APPROVED,
      body: 'Base draft body',
    });
    mocks.accountsService.getEligibleAccount.mockImplementation(
      async (platform: AccountPlatform) => {
        if (platform === AccountPlatform.STOCKTWITS) {
          return { id: 'stock-acct-1', accountHandle: 'stocktestacct' };
        }
        return null;
      },
    );

    const scheduled = await service.scheduleDraftPublishes(['draft-1']);

    expect(scheduled).toBe(2);
    const stocktwitsInputs = createSpy.mock.calls
      .map((call) => call[0])
      .filter((input) => input.platform === PublishPlatform.STOCKTWITS);

    expect(stocktwitsInputs).toHaveLength(2);
    expect(stocktwitsInputs[0].targetRef).toBe('ORCL');
    expect(stocktwitsInputs[1].targetRef).toBe('IREN');
  });

  it('respects account quota constraints by scheduling only symbols with eligible account capacity', async () => {
    const { service, mocks } = createService();

    jest
      .spyOn(service, 'syncTelegramCandidatesFromSeed')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'attemptApprovedTelegramJoins').mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'resolveStocktwitsTrendingSymbolsForCycle')
      .mockResolvedValue([
        'ORCL',
        'IREN',
        'INTC',
        'GSAT',
        'BE',
        'ASTS',
        'NVO',
        'RKLB',
        'PLTR',
        'NVDA',
      ]);
    jest
      .spyOn(service as never, 'resolveTelegramTargets')
      .mockResolvedValue([]);
    const createSpy = jest
      .spyOn(service as never, 'createAndQueuePublishJob')
      .mockResolvedValue(1);

    mocks.prisma.contentDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      status: DraftStatus.AUTO_APPROVED,
      body: 'Draft body',
    });

    let stocktwitsCapacity = 0;
    mocks.accountsService.getEligibleAccount.mockImplementation(
      async (platform: AccountPlatform) => {
        if (platform !== AccountPlatform.STOCKTWITS) {
          return null;
        }
        stocktwitsCapacity += 1;
        if (stocktwitsCapacity <= 4) {
          return {
            id: `stock-acct-${stocktwitsCapacity}`,
            accountHandle: `stocktestacct${stocktwitsCapacity}`,
          };
        }
        return null;
      },
    );

    const scheduled = await service.scheduleDraftPublishes(['draft-1']);

    expect(scheduled).toBe(4);
    expect(createSpy).toHaveBeenCalledTimes(4);
  });

  it('continues telegram scheduling when stocktwits trending discovery fails', async () => {
    const { service, mocks } = createService();

    jest
      .spyOn(service, 'syncTelegramCandidatesFromSeed')
      .mockResolvedValue(undefined);
    jest.spyOn(service, 'attemptApprovedTelegramJoins').mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'resolveTelegramTargets')
      .mockResolvedValue(['-1003757642888']);
    const createSpy = jest
      .spyOn(service as never, 'createAndQueuePublishJob')
      .mockResolvedValue(1);

    mocks.prisma.contentDraft.findUnique.mockResolvedValue({
      id: 'draft-1',
      status: DraftStatus.AUTO_APPROVED,
      body: 'Draft body',
    });

    mocks.accountsService.getEligibleAccount.mockImplementation(
      async (platform: AccountPlatform) => {
        if (platform === AccountPlatform.STOCKTWITS) {
          return { id: 'stock-acct-1', accountHandle: 'stocktestacct' };
        }
        if (platform === AccountPlatform.TELEGRAM) {
          return { id: 'tg-acct-1', accountHandle: 'telegram-primary' };
        }
        return null;
      },
    );

    mocks.accountsService.getStocktwitsCredentials.mockReturnValue({
      username: 'stock-user',
      password: 'stock-pass',
      secretRef: 'local:test',
    });
    mocks.stocktwitsPublisher.discoverTopTrendingSymbols.mockRejectedValue(
      new Error('ui_selector_failed'),
    );

    const scheduled = await service.scheduleDraftPublishes(['draft-1']);

    expect(scheduled).toBe(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: PublishPlatform.TELEGRAM,
        targetRef: '-1003757642888',
      }),
    );
    expect(mocks.auditService.record).toHaveBeenCalledWith(
      'stocktwits.trending.discovery_failed',
      'stocktwits',
      'trending_all',
      expect.objectContaining({
        reason: expect.stringContaining('ui_selector_failed'),
      }),
    );
  });
});

import { BadRequestException } from '@nestjs/common';
import { AccountPlatform, DraftStatus, PublishPlatform } from '@prisma/client';
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
    getRotationPolicy: jest
      .fn()
      .mockImplementation(async (platform: AccountPlatform) => {
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
    recordPublishOutcome: jest.fn().mockResolvedValue(undefined),
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
    publishBatchForManual: jest.fn(),
  };

  const discordUiPublisher = {
    broadcastToWritableChannels: jest.fn(),
  };

  const stocktwitsComplianceService = {
    enforceManualPublishCompliance: jest.fn(),
    trimToLimit: jest.fn().mockImplementation((body: string) => body),
  };

  const telemetryService = {
    increment: jest.fn(),
  };

  const publishQueue = {
    add: jest.fn(),
  };

  const postingPolicyService = {
    hashContent: jest.fn().mockReturnValue('deadbeef00000001'),
    checkPolicy: jest.fn(),
    recordPost: jest.fn(),
    handleRateLimitResponse: jest.fn(),
    getInterPostDelayMs: jest.fn().mockReturnValue(300_000),
  };

  const service = new PublishingService(
    prisma as never,
    configService as never,
    accountsService as never,
    auditService as never,
    telegramPublisher as never,
    stocktwitsPublisher as never,
    discordUiPublisher as never,
    stocktwitsComplianceService as never,
    postingPolicyService as never,
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
      discordUiPublisher,
      stocktwitsComplianceService,
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
    jest
      .spyOn(service, 'attemptApprovedTelegramJoins')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'resolveStocktwitsTrendingSymbolsForCycle')
      .mockResolvedValue(['ORCL', 'IREN']);
    jest
      .spyOn(service as any, 'resolveTelegramTargets')
      .mockResolvedValue([]);
    const createSpy = jest
      .spyOn(service as any, 'createAndQueuePublishJob')
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
    const stocktwitsInputs = (createSpy.mock.calls as Array<[Record<string, unknown>]>)
      .map((call) => call[0])
      .filter((input) => input['platform'] === PublishPlatform.STOCKTWITS);

    expect(stocktwitsInputs).toHaveLength(2);
    expect(stocktwitsInputs[0]['targetRef']).toBe('ORCL');
    expect(stocktwitsInputs[1]['targetRef']).toBe('IREN');
  });

  it('respects account quota constraints by scheduling only symbols with eligible account capacity', async () => {
    const { service, mocks } = createService();

    jest
      .spyOn(service, 'syncTelegramCandidatesFromSeed')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service, 'attemptApprovedTelegramJoins')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'resolveStocktwitsTrendingSymbolsForCycle')
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
      .spyOn(service as any, 'resolveTelegramTargets')
      .mockResolvedValue([]);
    const createSpy = jest
      .spyOn(service as any, 'createAndQueuePublishJob')
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
    jest
      .spyOn(service, 'attemptApprovedTelegramJoins')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'resolveTelegramTargets')
      .mockResolvedValue(['-1003757642888']);
    const createSpy = jest
      .spyOn(service as any, 'createAndQueuePublishJob')
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

describe('PublishingService manual direct publish', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('publishes manual content to stocktwits and discord UI automation', async () => {
    const { service, mocks } = createService();

    mocks.accountsService.getEligibleAccount.mockResolvedValue({
      id: 'stock-acct-1',
      accountHandle: 'stock-main',
    });
    mocks.accountsService.getStocktwitsCredentials.mockReturnValue({
      username: 'stock-user',
      password: 'stock-pass',
      secretRef: 'local:test',
    });
    mocks.stocktwitsPublisher.publish.mockResolvedValue({
      externalPostId: 'st-post-1',
      evidenceUri: 'artifacts/stocktwits/manual.png',
    });
    mocks.discordUiPublisher.broadcastToWritableChannels.mockResolvedValue({
      guildId: '725851172266573915',
      channelCount: 2,
      postedCount: 2,
      skippedCount: 0,
      failedCount: 0,
      channels: [
        {
          channelId: '444444444444444444',
          channelUrl:
            'https://discord.com/channels/725851172266573915/444444444444444444',
          channelName: 'chan-1',
          posted: true,
          skipped: false,
          reason: null,
        },
        {
          channelId: '555555555555555555',
          channelUrl:
            'https://discord.com/channels/725851172266573915/555555555555555555',
          channelName: 'chan-2',
          posted: true,
          skipped: false,
          reason: null,
        },
      ],
    });

    const result = await service.publishManualPost({
      body: 'Manual trading update for today',
      stocktwitsSymbol: 'orcl',
      stocktwitsUsername: 'stock-user',
      stocktwitsPassword: 'stock-pass',
      discordServerUrl:
        'https://discord.com/channels/725851172266573915/1072593749978398850',
    });

    expect(result.success).toBe(true);
    expect(result.stocktwits.success).toBe(true);
    expect(result.stocktwits.targetSymbol).toBe('ORCL');
    expect(result.discord.successCount).toBe(2);
    expect(mocks.stocktwitsPublisher.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'stock-user',
      }),
      expect.stringContaining('$ORCL'),
      expect.stringContaining('manual-'),
      'ORCL',
      undefined,
    );
    expect(
      mocks.discordUiPublisher.broadcastToWritableChannels,
    ).toHaveBeenCalledTimes(1);
    expect(
      mocks.stocktwitsComplianceService.enforceManualPublishCompliance,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Manual trading update for today',
        symbol: 'ORCL',
        publishToStocktwits: true,
      }),
    );
  });

  it('returns partial failure when discord server url is missing', async () => {
    const { service, mocks } = createService();

    mocks.accountsService.getEligibleAccount.mockResolvedValue({
      id: 'stock-acct-1',
      accountHandle: 'stock-main',
    });
    mocks.accountsService.getStocktwitsCredentials.mockReturnValue({
      username: 'stock-user',
      password: 'stock-pass',
      secretRef: 'local:test',
    });
    mocks.stocktwitsPublisher.publish.mockResolvedValue({
      externalPostId: 'st-post-1',
      evidenceUri: 'artifacts/stocktwits/manual.png',
    });

    const result = await service.publishManualPost({
      body: 'Manual market note',
      stocktwitsSymbol: 'AAPL',
      stocktwitsUsername: 'stock-user',
      stocktwitsPassword: 'stock-pass',
      publishToStocktwits: true,
      publishToDiscord: true,
    });

    expect(result.success).toBe(false);
    expect(result.stocktwits.success).toBe(true);
    expect(result.discord.error).toContain('discord_ui_server_url_missing');
    expect(result.discord.successCount).toBe(0);
    expect(result.discord.failedCount).toBe(0);
  });

  it('blocks manual stocktwits publish when compliance rejects content', async () => {
    const { service, mocks } = createService();
    mocks.stocktwitsComplianceService.enforceManualPublishCompliance.mockImplementation(
      () => {
        throw new BadRequestException(
          'stocktwits_compliance_blocked_high_risk_content',
        );
      },
    );

    await expect(
      service.publishManualPost({
        body: 'Risk free returns guaranteed',
        stocktwitsSymbol: 'TSLA',
        stocktwitsUsername: 'stock-user',
        stocktwitsPassword: 'stock-pass',
        publishToStocktwits: true,
        publishToDiscord: false,
      }),
    ).rejects.toThrow('stocktwits_compliance_blocked_high_risk_content');
  });

  it('publishes one-click multi-symbol stocktwits posts with distinct bodies', async () => {
    const { service, mocks } = createService();
    mocks.stocktwitsPublisher.publishBatchForManual.mockResolvedValue([
      { symbol: 'AAPL', success: true, externalPostId: 'st-aapl-1', evidenceUri: 'artifacts/stocktwits/aapl.png', error: null },
      { symbol: 'TSLA', success: true, externalPostId: 'st-tsla-1', evidenceUri: 'artifacts/stocktwits/tsla.png', error: null },
    ]);

    const result = await service.publishManualPost({
      body: '',
      stocktwitsItems: [
        { symbol: 'AAPL', body: 'Apple-specific post body' },
        { symbol: 'TSLA', body: 'Tesla-specific post body' },
      ],
      stocktwitsUsername: 'stock-user',
      stocktwitsPassword: 'stock-pass',
      publishToStocktwits: true,
      publishToDiscord: false,
    });

    expect(result.success).toBe(true);
    expect(result.stocktwits.success).toBe(true);
    expect(result.stocktwits.targetSymbols).toEqual(['AAPL', 'TSLA']);
    expect(result.stocktwits.totalCount).toBe(2);
    expect(result.stocktwits.successCount).toBe(2);
    expect(mocks.stocktwitsPublisher.publishBatchForManual).toHaveBeenCalledTimes(1);
    expect(mocks.stocktwitsPublisher.publishBatchForManual).toHaveBeenCalledWith(
      expect.objectContaining({ username: 'stock-user' }),
      expect.arrayContaining([
        expect.objectContaining({ symbol: 'AAPL', message: expect.stringContaining('$AAPL') }),
        expect.objectContaining({ symbol: 'TSLA', message: expect.stringContaining('$TSLA') }),
      ]),
      undefined,
    );
    expect(
      mocks.stocktwitsComplianceService.enforceManualPublishCompliance,
    ).toHaveBeenCalledTimes(2);
  });

  it('publishes manual content to discord via UI mode across writable channels', async () => {
    const { service, mocks } = createService();
    mocks.discordUiPublisher.broadcastToWritableChannels.mockResolvedValue({
      guildId: '725851172266573915',
      channelCount: 3,
      postedCount: 2,
      skippedCount: 1,
      failedCount: 0,
      channels: [
        {
          channelId: '111111111111111111',
          channelUrl:
            'https://discord.com/channels/725851172266573915/111111111111111111',
          channelName: 'general',
          posted: true,
          skipped: false,
          reason: null,
        },
        {
          channelId: '222222222222222222',
          channelUrl:
            'https://discord.com/channels/725851172266573915/222222222222222222',
          channelName: 'alpha',
          posted: true,
          skipped: false,
          reason: null,
        },
        {
          channelId: '333333333333333333',
          channelUrl:
            'https://discord.com/channels/725851172266573915/333333333333333333',
          channelName: 'locked',
          posted: false,
          skipped: true,
          reason: 'discord_ui_channel_read_only',
        },
      ],
    });

    const result = await service.publishManualPost({
      body: 'UI mode broadcast',
      publishToStocktwits: false,
      publishToDiscord: true,
      discordServerUrl:
        'https://discord.com/channels/725851172266573915/1072593749978398850',
    });

    expect(result.success).toBe(true);
    expect(result.stocktwits.attempted).toBe(false);
    expect(result.discord.targetCount).toBe(3);
    expect(result.discord.successCount).toBe(2);
    expect(result.discord.failedCount).toBe(0);
    expect(
      mocks.discordUiPublisher.broadcastToWritableChannels,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl:
          'https://discord.com/channels/725851172266573915/1072593749978398850',
        message: 'UI mode broadcast',
      }),
    );
  });
});

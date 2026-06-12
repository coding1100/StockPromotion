import { AccountPlatform, AccountStatus } from '@prisma/client';
import { AccountsService } from './accounts.service';

describe('AccountsService', () => {
  it('quarantines an account when a restriction signal is recorded', async () => {
    const tx = {
      accountProfile: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      accountHealthState: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      restrictionEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    };

    const prisma = {
      accountProfile: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'acct-1',
          status: AccountStatus.ACTIVE,
          healthScore: 0.9,
          healthState: {
            rollingSuccessRate: 0.8,
            consecutiveFailures: 0,
            consecutiveSuccesses: 2,
            softFailureCount: 0,
            restrictionCount: 0,
            lastPublishedAt: null,
            lastRestrictedAt: null,
          },
        }),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (callback) => callback(tx)),
      accountHealthEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
    };

    const service = new AccountsService(
      prisma as never,
      {
        get: jest.fn().mockReturnValue(undefined),
        getOrThrow: jest.fn().mockImplementation((key: string) => {
          const values: Record<string, number> = {
            PHASE2_PER_ACCOUNT_QUOTA: 4,
            PHASE2_GLOBAL_QUOTA: 12,
            PHASE2_MIN_DELAY_MINUTES: 10,
            PHASE2_MAX_DELAY_MINUTES: 45,
            PHASE2_ADAPTIVE_COOLDOWN_MINUTES: 30,
            PHASE2_DUPLICATE_SIMILARITY_THRESHOLD: 0.82,
          };
          return values[key];
        }),
      } as never,
      {
        record: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await service.recordPublishOutcome('acct-1', {
      success: false,
      reason: 'Account blocked by platform challenge',
      restricted: true,
      metadata: {
        platform: AccountPlatform.STOCKTWITS,
      },
    });

    expect(tx.accountProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: AccountStatus.QUARANTINED,
        }),
      }),
    );
    expect(tx.restrictionEvent.create).toHaveBeenCalled();
  });
});

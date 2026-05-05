import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountPlatform,
  AccountProfile,
  AccountStatus,
  Prisma,
  PublishStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

type StocktwitsAccountSecret = {
  handle: string;
  username: string;
  password: string;
  secretRef: string;
};

type TelegramBotSecret = {
  handle: string;
  botToken: string;
  secretRef: string;
};

type PublishOutcome = {
  success: boolean;
  reason?: string;
  restricted?: boolean;
  metadata?: Prisma.JsonObject;
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async syncAccountsFromConfig(): Promise<void> {
    await this.ensureRotationPolicies();

    const stocktwitsAccounts = this.loadStocktwitsAccountsFromEnv();
    const telegramAccounts = this.loadTelegramAccountsFromEnv();

    await this.syncPlatformAccounts(AccountPlatform.STOCKTWITS, stocktwitsAccounts);
    await this.syncPlatformAccounts(AccountPlatform.TELEGRAM, telegramAccounts);
  }

  async getEligibleAccount(
    platform: AccountPlatform,
    options?: {
      excludeAccountId?: string | null;
      scheduledAt?: Date;
    },
  ): Promise<AccountProfile | null> {
    await this.syncAccountsFromConfig();
    const scheduledAt = options?.scheduledAt ?? new Date();
    const policy = await this.getRotationPolicy(platform);

    if (this.isQuietHours(policy, scheduledAt)) {
      return null;
    }

    const candidates = await this.prisma.accountProfile.findMany({
      where: {
        platform,
        status: AccountStatus.ACTIVE,
        ...(options?.excludeAccountId
          ? {
              id: {
                not: options.excludeAccountId,
              },
            }
          : {}),
      },
      include: {
        healthState: true,
      },
      orderBy: [{ healthScore: 'desc' }, { lastSelectedAt: 'asc' }],
    });

    for (const candidate of candidates) {
      const quotaOk = await this.isWithinQuota(candidate.id, policy, scheduledAt);
      if (!quotaOk) {
        continue;
      }

      await this.prisma.accountProfile.update({
        where: { id: candidate.id },
        data: {
          lastSelectedAt: scheduledAt,
        },
      });
      return candidate;
    }

    return null;
  }

  async ensureEligibleAccountForExecution(
    platform: AccountPlatform,
    currentAccountId: string | null,
  ): Promise<AccountProfile> {
    await this.syncAccountsFromConfig();

    const current = currentAccountId
      ? await this.prisma.accountProfile.findUnique({
          where: { id: currentAccountId },
        })
      : null;

    if (current && current.status === AccountStatus.ACTIVE) {
      return current;
    }

    const fallback = await this.getEligibleAccount(platform, {
      excludeAccountId: currentAccountId,
    });
    if (fallback) {
      return fallback;
    }

    if (currentAccountId) {
      const refreshedCurrent = await this.prisma.accountProfile.findUnique({
        where: { id: currentAccountId },
      });
      if (refreshedCurrent && refreshedCurrent.status === AccountStatus.ACTIVE) {
        return refreshedCurrent;
      }
    }

    throw new ServiceUnavailableException(
      `No eligible ${platform.toLowerCase()} account is available`,
    );
  }

  getStocktwitsCredentials(accountHandle: string): {
    username: string;
    password: string;
    secretRef: string;
  } | null {
    const match = this.loadStocktwitsAccountsFromEnv().find(
      (account) => account.handle === accountHandle,
    );
    if (!match) {
      return null;
    }
    return {
      username: match.username,
      password: match.password,
      secretRef: match.secretRef,
    };
  }

  getTelegramCredentials(accountHandle: string): {
    botToken: string;
    secretRef: string;
  } | null {
    const match = this.loadTelegramAccountsFromEnv().find(
      (account) => account.handle === accountHandle,
    );
    if (!match) {
      return null;
    }
    return {
      botToken: match.botToken,
      secretRef: match.secretRef,
    };
  }

  async recordHealthEvent(
    accountId: string,
    severity: 'info' | 'warn' | 'error',
    message: string,
    metadata: Prisma.JsonObject = {},
  ): Promise<void> {
    await this.prisma.accountHealthEvent.create({
      data: {
        accountId,
        severity,
        message,
        metadata,
      },
    });
  }

  async recordPublishOutcome(
    accountId: string,
    outcome: PublishOutcome,
  ): Promise<void> {
    const account = await this.prisma.accountProfile.findUnique({
      where: { id: accountId },
      include: {
        healthState: true,
      },
    });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    const currentState = account.healthState;
    const currentSuccessRate = currentState?.rollingSuccessRate ?? 1;
    const nextSuccessRate = outcome.success
      ? currentSuccessRate * 0.7 + 0.3
      : currentSuccessRate * 0.7;
    const healthDelta = outcome.success
      ? 0.08
      : outcome.restricted
        ? -0.35
        : -0.15;
    const nextHealth = clamp(account.healthScore + healthDelta, 0, 1);
    const nextStatus =
      outcome.restricted || nextHealth <= 0.35
        ? AccountStatus.QUARANTINED
        : account.status === AccountStatus.DISABLED
          ? AccountStatus.DISABLED
          : AccountStatus.ACTIVE;

    await this.prisma.$transaction(async (tx) => {
      await tx.accountProfile.update({
        where: { id: accountId },
        data: {
          healthScore: nextHealth,
          status: nextStatus,
          replacementRequestedAt:
            outcome.restricted || nextHealth <= 0.35 ? new Date() : null,
          replacementNotes:
            outcome.restricted || nextHealth <= 0.35
              ? outcome.reason ?? 'Account requires manual review'
              : null,
        },
      });

      await tx.accountHealthState.upsert({
        where: { accountId },
        create: {
          accountId,
          rollingSuccessRate: nextSuccessRate,
          consecutiveFailures: outcome.success ? 0 : 1,
          consecutiveSuccesses: outcome.success ? 1 : 0,
          softFailureCount: outcome.success ? 0 : 1,
          restrictionCount: outcome.restricted ? 1 : 0,
          lastOutcome: outcome.success ? 'success' : 'failure',
          lastPublishedAt: outcome.success ? new Date() : null,
          lastRestrictedAt: outcome.restricted ? new Date() : null,
        },
        update: {
          rollingSuccessRate: nextSuccessRate,
          consecutiveFailures: outcome.success
            ? 0
            : (currentState?.consecutiveFailures ?? 0) + 1,
          consecutiveSuccesses: outcome.success
            ? (currentState?.consecutiveSuccesses ?? 0) + 1
            : 0,
          softFailureCount: outcome.success
            ? currentState?.softFailureCount ?? 0
            : (currentState?.softFailureCount ?? 0) + 1,
          restrictionCount: outcome.restricted
            ? (currentState?.restrictionCount ?? 0) + 1
            : currentState?.restrictionCount ?? 0,
          lastOutcome: outcome.success ? 'success' : 'failure',
          lastPublishedAt: outcome.success
            ? new Date()
            : currentState?.lastPublishedAt ?? null,
          lastRestrictedAt: outcome.restricted
            ? new Date()
            : currentState?.lastRestrictedAt ?? null,
        },
      });

      if (outcome.restricted) {
        await tx.restrictionEvent.create({
          data: {
            accountId,
            restrictionType: classifyRestrictionType(outcome.reason),
            severity: 'high',
            message: outcome.reason ?? 'Restriction detected',
            metadata: outcome.metadata,
          },
        });
      }
    });

    await this.recordHealthEvent(
      accountId,
      outcome.success ? 'info' : outcome.restricted ? 'error' : 'warn',
      outcome.reason ?? (outcome.success ? 'Publish succeeded' : 'Publish failed'),
      outcome.metadata,
    );

    await this.auditService.record(
      outcome.success ? 'account.publish.success' : 'account.publish.failure',
      'account',
      accountId,
      {
        restricted: outcome.restricted ?? false,
        healthScore: nextHealth,
        rollingSuccessRate: nextSuccessRate,
        reason: outcome.reason ?? null,
      },
    );
  }

  async penalizeAccount(accountId: string, reason: string): Promise<void> {
    await this.recordPublishOutcome(accountId, {
      success: false,
      reason,
      restricted: isRestrictionSignal(reason),
    });
  }

  async quarantineAccount(accountId: string, reason: string): Promise<void> {
    const account = await this.prisma.accountProfile.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    await this.prisma.accountProfile.update({
      where: { id: accountId },
      data: {
        status: AccountStatus.QUARANTINED,
        replacementRequestedAt: new Date(),
        replacementNotes: reason,
      },
    });

    await this.recordHealthEvent(accountId, 'error', reason);
    await this.prisma.restrictionEvent.create({
      data: {
        accountId,
        restrictionType: classifyRestrictionType(reason),
        severity: 'high',
        message: reason,
      },
    });
    await this.auditService.record('account.quarantined', 'account', accountId, {
      reason,
    });
  }

  async requestReplacement(accountId: string, notes?: string): Promise<void> {
    const account = await this.prisma.accountProfile.findUnique({
      where: { id: accountId },
    });
    if (!account) {
      throw new NotFoundException('Account not found');
    }

    await this.prisma.accountProfile.update({
      where: { id: accountId },
      data: {
        replacementRequestedAt: new Date(),
        replacementNotes: notes ?? 'Manual replacement requested',
      },
    });

    await this.auditService.record('account.replacement.requested', 'account', accountId, {
      notes: notes ?? null,
    });
  }

  async activateReplacement(input: {
    platform: AccountPlatform;
    accountHandle: string;
    secretRef: string;
    username?: string;
  }): Promise<void> {
    const row = await this.prisma.accountProfile.upsert({
      where: {
        platform_accountHandle: {
          platform: input.platform,
          accountHandle: input.accountHandle,
        },
      },
      update: {
        status: AccountStatus.ACTIVE,
        healthScore: 1,
        replacementRequestedAt: null,
        replacementNotes: null,
      },
      create: {
        platform: input.platform,
        accountHandle: input.accountHandle,
        status: AccountStatus.ACTIVE,
        healthScore: 1,
        config: {},
      },
    });

    await this.prisma.accountCredentialsRef.upsert({
      where: { accountId: row.id },
      update: {
        secretRef: input.secretRef,
        username: input.username ?? null,
      },
      create: {
        accountId: row.id,
        secretRef: input.secretRef,
        username: input.username ?? null,
      },
    });

    await this.prisma.accountHealthState.upsert({
      where: { accountId: row.id },
      update: {
        rollingSuccessRate: 1,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        softFailureCount: 0,
        restrictionCount: 0,
        lastOutcome: 'replacement_activated',
      },
      create: {
        accountId: row.id,
        rollingSuccessRate: 1,
        lastOutcome: 'replacement_activated',
      },
    });

    await this.auditService.record('account.replacement.activated', 'account', row.id, {
      platform: input.platform,
      handle: input.accountHandle,
      secretRef: input.secretRef,
    });
  }

  async listAccountsDashboard(platform?: AccountPlatform): Promise<
    Array<{
      id: string;
      platform: AccountPlatform;
      accountHandle: string;
      status: AccountStatus;
      healthScore: number;
      rollingSuccessRate: number;
      consecutiveFailures: number;
      replacementRequestedAt: Date | null;
      lastRestrictedAt: Date | null;
      queuedJobs: number;
      successfulJobsLast24h: number;
    }>
  > {
    const rows = await this.prisma.accountProfile.findMany({
      where: platform ? { platform } : undefined,
      include: {
        healthState: true,
        _count: {
          select: {
            publishJobs: {
              where: {
                status: PublishStatus.PENDING,
              },
            },
          },
        },
      },
      orderBy: [{ platform: 'asc' }, { healthScore: 'desc' }],
    });

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const successRows = await this.prisma.publishJob.groupBy({
      by: ['accountId'],
      where: {
        accountId: {
          not: null,
        },
        status: PublishStatus.SUCCESS,
        scheduledAt: {
          gte: cutoff,
        },
      },
      _count: {
        _all: true,
      },
    });
    const successMap = new Map(
      successRows.map((row) => [row.accountId ?? '', row._count._all]),
    );

    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      accountHandle: row.accountHandle,
      status: row.status,
      healthScore: row.healthScore,
      rollingSuccessRate: row.healthState?.rollingSuccessRate ?? 1,
      consecutiveFailures: row.healthState?.consecutiveFailures ?? 0,
      replacementRequestedAt: row.replacementRequestedAt,
      lastRestrictedAt: row.healthState?.lastRestrictedAt ?? null,
      queuedJobs: row._count.publishJobs,
      successfulJobsLast24h: successMap.get(row.id) ?? 0,
    }));
  }

  async getRotationPolicy(platform: AccountPlatform) {
    await this.ensureRotationPolicies();
    return this.prisma.rotationPolicy.findUniqueOrThrow({
      where: {
        platform,
      },
    });
  }

  private async syncPlatformAccounts(
    platform: AccountPlatform,
    accounts: Array<
      StocktwitsAccountSecret | TelegramBotSecret
    >,
  ): Promise<void> {
    const handles = Array.from(new Set(accounts.map((account) => account.handle)));

    await this.prisma.$transaction(async (tx) => {
      for (const account of accounts) {
        const username =
          'username' in account && typeof account.username === 'string'
            ? account.username
            : null;

        const row = await tx.accountProfile.upsert({
          where: {
            platform_accountHandle: {
              platform,
              accountHandle: account.handle,
            },
          },
          update: {
            status: AccountStatus.ACTIVE,
            config: username ? ({ username } as Prisma.JsonObject) : {},
          },
          create: {
            platform,
            accountHandle: account.handle,
            status: AccountStatus.ACTIVE,
            config: username ? ({ username } as Prisma.JsonObject) : {},
          },
        });

        await tx.accountCredentialsRef.upsert({
          where: { accountId: row.id },
          update: {
            secretRef: account.secretRef,
            username,
            metadata:
              platform === AccountPlatform.TELEGRAM
                ? ({ type: 'bot_token' } as Prisma.JsonObject)
                : ({ type: 'username_password' } as Prisma.JsonObject),
          },
          create: {
            accountId: row.id,
            secretRef: account.secretRef,
            username,
            metadata:
              platform === AccountPlatform.TELEGRAM
                ? ({ type: 'bot_token' } as Prisma.JsonObject)
                : ({ type: 'username_password' } as Prisma.JsonObject),
          },
        });

        await tx.accountHealthState.upsert({
          where: { accountId: row.id },
          update: {},
          create: {
            accountId: row.id,
          },
        });
      }

      await tx.accountProfile.updateMany({
        where: {
          platform,
          status: {
            not: AccountStatus.DISABLED,
          },
          ...(handles.length > 0 ? { accountHandle: { notIn: handles } } : {}),
        },
        data: {
          status: AccountStatus.DISABLED,
          config: {},
        },
      });
    });
  }

  private async ensureRotationPolicies(): Promise<void> {
    const policies = [
      {
        platform: AccountPlatform.STOCKTWITS,
      },
      {
        platform: AccountPlatform.TELEGRAM,
      },
    ];

    for (const policy of policies) {
      await this.prisma.rotationPolicy.upsert({
        where: { platform: policy.platform },
        update: {
          perAccountQuota: this.configService.getOrThrow<number>(
            'PHASE2_PER_ACCOUNT_QUOTA',
          ),
          globalQuota: this.configService.getOrThrow<number>('PHASE2_GLOBAL_QUOTA'),
          quietHoursStart: this.optionalNumber('PHASE2_QUIET_HOURS_START'),
          quietHoursEnd: this.optionalNumber('PHASE2_QUIET_HOURS_END'),
          minDelayMinutes: this.configService.getOrThrow<number>(
            'PHASE2_MIN_DELAY_MINUTES',
          ),
          maxDelayMinutes: this.configService.getOrThrow<number>(
            'PHASE2_MAX_DELAY_MINUTES',
          ),
          adaptiveCooldownMinutes: this.configService.getOrThrow<number>(
            'PHASE2_ADAPTIVE_COOLDOWN_MINUTES',
          ),
          duplicateSimilarityThreshold: this.configService.getOrThrow<number>(
            'PHASE2_DUPLICATE_SIMILARITY_THRESHOLD',
          ),
        },
        create: {
          platform: policy.platform,
          perAccountQuota: this.configService.getOrThrow<number>(
            'PHASE2_PER_ACCOUNT_QUOTA',
          ),
          globalQuota: this.configService.getOrThrow<number>('PHASE2_GLOBAL_QUOTA'),
          quietHoursStart: this.optionalNumber('PHASE2_QUIET_HOURS_START'),
          quietHoursEnd: this.optionalNumber('PHASE2_QUIET_HOURS_END'),
          minDelayMinutes: this.configService.getOrThrow<number>(
            'PHASE2_MIN_DELAY_MINUTES',
          ),
          maxDelayMinutes: this.configService.getOrThrow<number>(
            'PHASE2_MAX_DELAY_MINUTES',
          ),
          adaptiveCooldownMinutes: this.configService.getOrThrow<number>(
            'PHASE2_ADAPTIVE_COOLDOWN_MINUTES',
          ),
          duplicateSimilarityThreshold: this.configService.getOrThrow<number>(
            'PHASE2_DUPLICATE_SIMILARITY_THRESHOLD',
          ),
        },
      });
    }
  }

  private async isWithinQuota(
    accountId: string,
    policy: {
      perAccountQuota: number;
      globalQuota: number;
    },
    scheduledAt: Date,
  ): Promise<boolean> {
    const windowStart = new Date(scheduledAt.getTime() - 24 * 60 * 60 * 1000);

    const [accountCount, globalCount] = await Promise.all([
      this.prisma.publishJob.count({
        where: {
          accountId,
          scheduledAt: {
            gte: windowStart,
            lte: scheduledAt,
          },
          status: {
            in: [PublishStatus.PENDING, PublishStatus.SUCCESS],
          },
        },
      }),
      this.prisma.publishJob.count({
        where: {
          scheduledAt: {
            gte: windowStart,
            lte: scheduledAt,
          },
          status: {
            in: [PublishStatus.PENDING, PublishStatus.SUCCESS],
          },
        },
      }),
    ]);

    return (
      accountCount < policy.perAccountQuota && globalCount < policy.globalQuota
    );
  }

  private isQuietHours(
    policy: {
      quietHoursStart: number | null;
      quietHoursEnd: number | null;
    },
    scheduledAt: Date,
  ): boolean {
    if (
      policy.quietHoursStart === null ||
      policy.quietHoursStart === undefined ||
      policy.quietHoursEnd === null ||
      policy.quietHoursEnd === undefined
    ) {
      return false;
    }

    const hour = scheduledAt.getHours();
    if (policy.quietHoursStart === policy.quietHoursEnd) {
      return false;
    }
    if (policy.quietHoursStart < policy.quietHoursEnd) {
      return hour >= policy.quietHoursStart && hour < policy.quietHoursEnd;
    }

    return hour >= policy.quietHoursStart || hour < policy.quietHoursEnd;
  }

  private loadStocktwitsAccountsFromEnv(): StocktwitsAccountSecret[] {
    const raw =
      this.configService.get<string>('STOCKTWITS_ACCOUNTS_JSON') || '[]';

    return parseJsonArray(raw, 'STOCKTWITS_ACCOUNTS_JSON')
      .map((item) => {
        const row = item as Record<string, unknown>;
        const handle = typeof row.handle === 'string' ? row.handle.trim() : '';
        const username =
          typeof row.username === 'string' ? row.username.trim() : '';
        const password =
          typeof row.password === 'string' ? row.password.trim() : '';
        const secretRef =
          typeof row.secretRef === 'string' && row.secretRef.trim()
            ? row.secretRef.trim()
            : `env:STOCKTWITS_ACCOUNTS_JSON:${handle}`;
        return {
          handle,
          username,
          password,
          secretRef,
        };
      })
      .filter((item) => item.handle && item.username && item.password);
  }

  private loadTelegramAccountsFromEnv(): TelegramBotSecret[] {
    const rawConfigured =
      this.configService.get<string>('TELEGRAM_BOT_ACCOUNTS_JSON') || '[]';
    const parsed = parseJsonArray(
      rawConfigured,
      'TELEGRAM_BOT_ACCOUNTS_JSON',
    ).map((item) => {
      const row = item as Record<string, unknown>;
      const handle = typeof row.handle === 'string' ? row.handle.trim() : '';
      const botToken =
        typeof row.botToken === 'string' ? row.botToken.trim() : '';
      const secretRef =
        typeof row.secretRef === 'string' && row.secretRef.trim()
          ? row.secretRef.trim()
          : `env:TELEGRAM_BOT_ACCOUNTS_JSON:${handle}`;
      return {
        handle,
        botToken,
        secretRef,
      };
    });

    const validConfigured = parsed.filter(
      (item) => item.handle && item.botToken,
    );
    if (validConfigured.length > 0) {
      return validConfigured;
    }

    const defaultToken =
      this.configService.get<string>('TELEGRAM_BOT_TOKEN')?.trim() || '';
    if (!defaultToken) {
      return [];
    }

    return [
      {
        handle: 'telegram-primary',
        botToken: defaultToken,
        secretRef: 'env:TELEGRAM_BOT_TOKEN',
      },
    ];
  }

  private optionalNumber(key: string): number | null {
    const value = this.configService.get<string | number | undefined>(key);
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
}

function parseJsonArray(raw: string, envName: string): unknown[] {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'invalid_json_payload';
    throw new Error(`${envName} must be valid JSON. Parse failed: ${message}`);
  }

  if (!Array.isArray(parsedUnknown)) {
    throw new Error(`${envName} must be a JSON array`);
  }

  return parsedUnknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRestrictionSignal(reason: string): boolean {
  return /(ban|blocked|restricted|suspended|captcha|locked|challenge)/i.test(
    reason,
  );
}

function classifyRestrictionType(reason?: string): string {
  if (!reason) {
    return 'unknown_restriction';
  }
  if (/captcha|challenge/i.test(reason)) {
    return 'challenge';
  }
  if (/suspend/i.test(reason)) {
    return 'suspension';
  }
  if (/ban|blocked|restricted|locked/i.test(reason)) {
    return 'restriction';
  }
  return 'publish_failure';
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountPlatform,
  AccountProfile,
  AccountStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

type StocktwitsAccountSecret = {
  handle: string;
  username: string;
  password: string;
};

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async syncAccountsFromConfig(): Promise<void> {
    const parsed = this.loadStocktwitsAccountsFromEnv();
    const handles = Array.from(
      new Set(parsed.map((account) => account.handle)),
    );

    await this.prisma.$transaction(async (tx) => {
      for (const account of parsed) {
        await tx.accountProfile.upsert({
          where: {
            platform_accountHandle: {
              platform: AccountPlatform.STOCKTWITS,
              accountHandle: account.handle,
            },
          },
          update: {
            status: AccountStatus.ACTIVE,
            // Secrets stay in environment/secret manager, not in database.
            config: {
              username: account.username,
            } as Prisma.JsonObject,
          },
          create: {
            platform: AccountPlatform.STOCKTWITS,
            accountHandle: account.handle,
            status: AccountStatus.ACTIVE,
            config: {
              username: account.username,
            } as Prisma.JsonObject,
          },
        });
      }

      await tx.accountProfile.updateMany({
        where: {
          platform: AccountPlatform.STOCKTWITS,
          status: {
            not: AccountStatus.DISABLED,
          },
          ...(handles.length > 0 ? { accountHandle: { notIn: handles } } : {}),
        },
        data: {
          status: AccountStatus.DISABLED,
          config: {} as Prisma.JsonObject,
        },
      });
    });
  }

  getStocktwitsCredentials(accountHandle: string): {
    username: string;
    password: string;
  } | null {
    const parsed = this.loadStocktwitsAccountsFromEnv();
    const match = parsed.find((account) => account.handle === accountHandle);
    if (!match) {
      return null;
    }
    return {
      username: match.username,
      password: match.password,
    };
  }

  async getActiveAccount(
    platform: AccountPlatform,
  ): Promise<AccountProfile | null> {
    return this.prisma.accountProfile.findFirst({
      where: {
        platform,
        status: AccountStatus.ACTIVE,
      },
      orderBy: {
        healthScore: 'desc',
      },
    });
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

  async penalizeAccount(accountId: string, reason: string): Promise<void> {
    const updated = await this.prisma.accountProfile.update({
      where: { id: accountId },
      data: {
        healthScore: {
          decrement: 0.2,
        },
        status: AccountStatus.QUARANTINED,
      },
    });

    await this.recordHealthEvent(accountId, 'error', reason);
    await this.auditService.record(
      'account.quarantined',
      'account',
      accountId,
      {
        reason,
        healthScore: updated.healthScore,
      },
    );
  }

  private loadStocktwitsAccountsFromEnv(): StocktwitsAccountSecret[] {
    const raw =
      this.configService.get<string>('STOCKTWITS_ACCOUNTS_JSON') || '[]';

    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(raw);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'invalid_json_payload';
      throw new Error(
        `STOCKTWITS_ACCOUNTS_JSON must be valid JSON. Parse failed: ${message}`,
      );
    }

    if (!Array.isArray(parsedUnknown)) {
      throw new Error('STOCKTWITS_ACCOUNTS_JSON must be a JSON array');
    }

    return parsedUnknown
      .map((item) => {
        const row = item as Record<string, unknown>;
        const handle = typeof row.handle === 'string' ? row.handle.trim() : '';
        const username =
          typeof row.username === 'string' ? row.username.trim() : '';
        const password =
          typeof row.password === 'string' ? row.password.trim() : '';
        return {
          handle,
          username,
          password,
        };
      })
      .filter((item) => item.handle && item.username && item.password);
  }
}

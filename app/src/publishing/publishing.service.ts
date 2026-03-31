import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  AccountPlatform,
  DraftStatus,
  Prisma,
  PublishPlatform,
  PublishStatus,
} from '@prisma/client';
import { createHash, randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { AuditService } from '../audit/audit.service';
import {
  PUBLISH_JOB_EXECUTE,
  PUBLISH_QUEUE,
} from '../common/constants/queue.constants';
import { TelegramPublisher } from './telegram.publisher';
import { StocktwitsPublisher } from './stocktwits.publisher';
import { TelemetryService } from '../telemetry/telemetry.service';

@Injectable()
export class PublishingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly accountsService: AccountsService,
    private readonly auditService: AuditService,
    private readonly telegramPublisher: TelegramPublisher,
    private readonly stocktwitsPublisher: StocktwitsPublisher,
    private readonly telemetryService: TelemetryService,
    @InjectQueue(PUBLISH_QUEUE) private readonly publishQueue: Queue,
  ) {}

  async syncTelegramCandidatesFromSeed(): Promise<void> {
    const seeds = (
      this.configService.get<string>('TELEGRAM_DISCOVERY_SEEDS') || ''
    )
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const seed of seeds) {
      const looksLikeChatId = /^-?\d+$/.test(seed);
      const data: Prisma.TelegramGroupCandidateUncheckedCreateInput = {
        title: seed,
        chatId: looksLikeChatId ? seed : null,
        inviteLink: looksLikeChatId ? null : seed,
      };

      if (looksLikeChatId) {
        await this.prisma.telegramGroupCandidate.upsert({
          where: { chatId: seed },
          create: data,
          update: {},
        });
      } else {
        await this.prisma.telegramGroupCandidate.upsert({
          where: { inviteLink: seed },
          create: data,
          update: {},
        });
      }
    }
  }

  async attemptApprovedTelegramJoins(): Promise<void> {
    const candidates = await this.prisma.telegramGroupCandidate.findMany({
      where: { approved: true },
      orderBy: { updatedAt: 'asc' },
    });

    for (const candidate of candidates) {
      const chatRef = this.resolveTelegramChatReference(candidate);
      const now = new Date();

      if (!chatRef) {
        await this.prisma.telegramGroupCandidate.update({
          where: { id: candidate.id },
          data: {
            joined: false,
            lastAttemptAt: now,
            statusNote:
              'No chat identifier resolved. Manual admin add may be required.',
          },
        });
        continue;
      }

      const accessible = await this.telegramPublisher.canAccessChat(chatRef);
      await this.prisma.telegramGroupCandidate.update({
        where: { id: candidate.id },
        data: {
          chatId: candidate.chatId ?? chatRef,
          joined: accessible,
          lastAttemptAt: now,
          statusNote: accessible
            ? 'Bot access verified for this chat.'
            : 'Bot cannot access chat yet. Add bot as admin/member and retry.',
        },
      });

      await this.auditService.record(
        'telegram.access.check',
        'telegram_candidate',
        candidate.id,
        {
          chatRef,
          success: accessible,
        },
      );
    }
  }

  async listTelegramCandidates(): Promise<
    Array<{
      id: string;
      title: string;
      approved: boolean;
      joined: boolean;
      chatId: string | null;
      inviteLink: string | null;
      statusNote: string | null;
      lastAttemptAt: Date | null;
    }>
  > {
    const rows = await this.prisma.telegramGroupCandidate.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      approved: row.approved,
      joined: row.joined,
      chatId: row.chatId,
      inviteLink: row.inviteLink,
      statusNote: row.statusNote,
      lastAttemptAt: row.lastAttemptAt,
    }));
  }

  async approveTelegramCandidate(candidateId: string): Promise<void> {
    await this.prisma.telegramGroupCandidate.update({
      where: { id: candidateId },
      data: { approved: true },
    });
    await this.auditService.record(
      'telegram.candidate.approved',
      'telegram_candidate',
      candidateId,
      {},
    );
    await this.attemptApprovedTelegramJoins();
  }

  async scheduleDraftPublishes(draftIds: string[]): Promise<number> {
    if (draftIds.length === 0) {
      return 0;
    }

    await this.accountsService.syncAccountsFromConfig();
    await this.syncTelegramCandidatesFromSeed();
    await this.attemptApprovedTelegramJoins();

    const publishCooldown = this.configService.getOrThrow<number>(
      'PUBLISH_COOLDOWN_MINUTES',
    );
    let scheduledCount = 0;

    for (const draftId of draftIds) {
      const draft = await this.prisma.contentDraft.findUnique({
        where: { id: draftId },
      });
      if (!draft || draft.status !== DraftStatus.AUTO_APPROVED) {
        continue;
      }

      const stocktwitsAccount = await this.accountsService.getActiveAccount(
        AccountPlatform.STOCKTWITS,
      );

      if (stocktwitsAccount) {
        const jitterMinutes = randomInt(5, Math.max(6, publishCooldown));
        scheduledCount += await this.createAndQueuePublishJob({
          draftId,
          platform: PublishPlatform.STOCKTWITS,
          accountId: stocktwitsAccount.id,
          targetRef: stocktwitsAccount.accountHandle,
          scheduleAt: new Date(Date.now() + jitterMinutes * 60_000),
          cooldownMinutes: publishCooldown,
        });
      }

      const telegramTargets = await this.resolveTelegramTargets();
      for (const target of telegramTargets) {
        const jitterMinutes = randomInt(2, Math.max(3, publishCooldown));
        scheduledCount += await this.createAndQueuePublishJob({
          draftId,
          platform: PublishPlatform.TELEGRAM,
          accountId: null,
          targetRef: target,
          scheduleAt: new Date(Date.now() + jitterMinutes * 60_000),
          cooldownMinutes: publishCooldown,
        });
      }
    }

    this.telemetryService.increment(
      'pipeline.publish.jobs_scheduled',
      scheduledCount,
    );
    return scheduledCount;
  }

  async executePublishJob(publishJobId: string): Promise<void> {
    const job = await this.prisma.publishJob.findUnique({
      where: { id: publishJobId },
      include: {
        draft: true,
        account: true,
      },
    });
    if (!job || job.status !== PublishStatus.PENDING) {
      return;
    }

    try {
      let externalPostId = '';
      let evidenceUri = '';
      let responsePayload: unknown = {};

      if (job.platform === PublishPlatform.TELEGRAM) {
        const result = await this.telegramPublisher.sendMessage(
          job.targetRef,
          job.draft.body,
        );
        externalPostId = result.externalPostId;
        responsePayload = result.responsePayload;
      } else {
        const accountHandle = job.account?.accountHandle || '';
        const credentials =
          this.accountsService.getStocktwitsCredentials(accountHandle);
        if (!credentials) {
          throw new Error('StockTwits account credentials missing');
        }

        const result = await this.stocktwitsPublisher.publish(
          credentials,
          job.draft.body,
          job.id,
        );
        externalPostId = result.externalPostId;
        evidenceUri = result.evidenceUri;
        responsePayload = result;
      }

      await this.prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: PublishStatus.SUCCESS,
          attempts: {
            increment: 1,
          },
          externalPostId,
          evidenceUri: evidenceUri || null,
        },
      });

      await this.prisma.publishAttempt.create({
        data: {
          publishJobId: job.id,
          success: true,
          responsePayload: responsePayload as Prisma.JsonObject,
          evidenceUri: evidenceUri || null,
        },
      });
      await this.reconcileDraftPublishState(job.draftId);

      this.telemetryService.increment('pipeline.publish.success');
      await this.auditService.record('publish.success', 'publish_job', job.id, {
        platform: job.platform,
        targetRef: job.targetRef,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected publish error';
      const evidenceUri = this.extractEvidenceUriFromError(message);

      await this.prisma.publishJob.update({
        where: { id: job.id },
        data: {
          status: PublishStatus.FAILED,
          attempts: {
            increment: 1,
          },
          lastError: message,
          evidenceUri: evidenceUri || null,
        },
      });

      await this.prisma.publishAttempt.create({
        data: {
          publishJobId: job.id,
          success: false,
          errorClass: 'publish_error',
          errorMessage: message,
          evidenceUri: evidenceUri || null,
        },
      });
      await this.reconcileDraftPublishState(job.draftId);

      if (job.accountId) {
        await this.accountsService.penalizeAccount(job.accountId, message);
      }

      this.telemetryService.increment('pipeline.publish.failed');
      await this.auditService.record('publish.failed', 'publish_job', job.id, {
        platform: job.platform,
        message,
        evidenceUri,
      });
    }
  }

  async listPublishJobs(
    limit = 100,
    status?: PublishStatus,
  ): Promise<
    Array<{
      id: string;
      platform: PublishPlatform;
      status: PublishStatus;
      targetRef: string;
      attempts: number;
      scheduledAt: Date;
      updatedAt: Date;
      externalPostId: string | null;
      evidenceUri: string | null;
      lastError: string | null;
    }>
  > {
    const rows = await this.prisma.publishJob.findMany({
      where: status ? { status } : undefined,
      orderBy: { scheduledAt: 'desc' },
      take: limit,
    });

    return rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      status: row.status,
      targetRef: row.targetRef,
      attempts: row.attempts,
      scheduledAt: row.scheduledAt,
      updatedAt: row.updatedAt,
      externalPostId: row.externalPostId,
      evidenceUri: row.evidenceUri,
      lastError: row.lastError,
    }));
  }

  async getPublishJob(jobId: string): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.publishJob.findUnique({
      where: { id: jobId },
      include: {
        attemptsLog: {
          orderBy: { attemptedAt: 'desc' },
          take: 20,
        },
      },
    });
    if (!row) {
      return null;
    }
    return row;
  }

  async retryPublishJob(publishJobId: string): Promise<void> {
    const maxRetries = this.configService.getOrThrow<number>(
      'PUBLISH_MAX_RETRIES',
    );
    const existing = await this.prisma.publishJob.findUnique({
      where: { id: publishJobId },
      select: {
        id: true,
        status: true,
        attempts: true,
        draftId: true,
      },
    });
    if (!existing) {
      throw new NotFoundException('Publish job not found');
    }
    if (existing.status !== PublishStatus.FAILED) {
      throw new BadRequestException('Only FAILED publish jobs can be retried');
    }
    if (existing.attempts >= maxRetries) {
      throw new ConflictException(
        `Retry limit reached (${maxRetries}) for publish job`,
      );
    }

    const job = await this.prisma.publishJob.update({
      where: { id: publishJobId },
      data: {
        status: PublishStatus.PENDING,
        scheduledAt: new Date(Date.now() + 30_000),
        lastError: null,
      },
    });
    await this.reconcileDraftPublishState(existing.draftId);

    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId },
      {
        jobId: `${job.id}:retry:${Date.now()}`,
        delay: 30_000,
      },
    );

    await this.auditService.record(
      'publish.retry.queued',
      'publish_job',
      job.id,
      {
        attempts: job.attempts,
        retryScheduledAt: job.scheduledAt.toISOString(),
      },
    );
  }

  private async resolveTelegramTargets(): Promise<string[]> {
    const defaults = (
      this.configService.get<string>('TELEGRAM_DEFAULT_CHAT_IDS') || ''
    )
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const approvedJoined = await this.prisma.telegramGroupCandidate.findMany({
      where: {
        approved: true,
        joined: true,
        chatId: {
          not: null,
        },
      },
      select: {
        chatId: true,
      },
    });

    const merged = new Set<string>(defaults);
    for (const row of approvedJoined) {
      if (row.chatId) {
        merged.add(row.chatId);
      }
    }
    return Array.from(merged);
  }

  private resolveTelegramChatReference(candidate: {
    chatId: string | null;
    inviteLink: string | null;
  }): string | null {
    if (candidate.chatId) {
      return candidate.chatId;
    }
    if (!candidate.inviteLink) {
      return null;
    }

    const trimmed = candidate.inviteLink.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return trimmed;
    }
    if (trimmed.startsWith('@')) {
      return trimmed;
    }

    const publicLinkMatch = trimmed.match(
      /(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/,
    );
    if (publicLinkMatch && publicLinkMatch[1]) {
      return `@${publicLinkMatch[1]}`;
    }

    return null;
  }

  private extractEvidenceUriFromError(message: string): string | null {
    const match = message.match(/\bevidence:(.+)$/);
    if (!match?.[1]) {
      return null;
    }
    return match[1].trim();
  }

  private async createAndQueuePublishJob(input: {
    draftId: string;
    platform: PublishPlatform;
    accountId: string | null;
    targetRef: string;
    scheduleAt: Date;
    cooldownMinutes: number;
  }): Promise<number> {
    const duplicateExists = await this.hasRecentDuplicateWithinCooldown(
      input.draftId,
      input.platform,
      input.targetRef,
      input.scheduleAt,
      input.cooldownMinutes,
    );
    if (duplicateExists) {
      await this.auditService.record(
        'publish.skipped.duplicate_cooldown',
        'draft',
        input.draftId,
        {
          platform: input.platform,
          targetRef: input.targetRef,
          cooldownMinutes: input.cooldownMinutes,
        },
      );
      return 0;
    }

    const cooldownBucket = Math.floor(
      input.scheduleAt.getTime() / (input.cooldownMinutes * 60_000),
    );
    const idempotencyKey = createHash('sha256')
      .update(
        `${input.draftId}:${input.platform}:${input.targetRef}:${cooldownBucket}`,
      )
      .digest('hex');

    const existing = await this.prisma.publishJob.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (existing) {
      return 0;
    }

    let row: {
      id: string;
      scheduledAt: Date;
    } | null = null;
    try {
      row = await this.prisma.publishJob.create({
        data: {
          draftId: input.draftId,
          platform: input.platform,
          accountId: input.accountId,
          targetRef: input.targetRef,
          scheduledAt: input.scheduleAt,
          status: PublishStatus.PENDING,
          idempotencyKey,
        },
        select: {
          id: true,
          scheduledAt: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return 0;
      }
      throw error;
    }

    const delay = Math.max(0, input.scheduleAt.getTime() - Date.now());
    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId: row.id },
      {
        jobId: row.id,
        delay,
      },
    );

    return 1;
  }

  private async reconcileDraftPublishState(draftId: string): Promise<void> {
    const jobs = await this.prisma.publishJob.findMany({
      where: { draftId },
      select: { status: true },
    });
    if (jobs.length === 0) {
      return;
    }

    if (jobs.some((job) => job.status === PublishStatus.PENDING)) {
      await this.prisma.contentDraft.update({
        where: { id: draftId },
        data: {
          status: DraftStatus.AUTO_APPROVED,
          publishedAt: null,
        },
      });
      return;
    }

    const allSucceededOrSkipped = jobs.every(
      (job) =>
        job.status === PublishStatus.SUCCESS ||
        job.status === PublishStatus.SKIPPED,
    );
    if (allSucceededOrSkipped) {
      await this.prisma.contentDraft.update({
        where: { id: draftId },
        data: {
          status: DraftStatus.PUBLISHED,
          publishedAt: new Date(),
        },
      });
      return;
    }

    if (jobs.some((job) => job.status === PublishStatus.FAILED)) {
      await this.prisma.contentDraft.update({
        where: { id: draftId },
        data: {
          status: DraftStatus.FAILED,
          publishedAt: null,
        },
      });
    }
  }

  private async hasRecentDuplicateWithinCooldown(
    draftId: string,
    platform: PublishPlatform,
    targetRef: string,
    scheduleAt: Date,
    cooldownMinutes: number,
  ): Promise<boolean> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: draftId },
      select: { contentHash: true },
    });
    if (!draft) {
      return false;
    }

    const cutoff = new Date(scheduleAt.getTime() - cooldownMinutes * 60_000);
    const existing = await this.prisma.publishJob.findFirst({
      where: {
        platform,
        targetRef,
        status: {
          in: [PublishStatus.PENDING, PublishStatus.SUCCESS],
        },
        scheduledAt: {
          gte: cutoff,
          lte: scheduleAt,
        },
        draft: {
          contentHash: draft.contentHash,
        },
      },
      select: { id: true },
    });
    return Boolean(existing);
  }
}

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
  ReviewStatus,
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
import { calculateContentSimilarity } from '../common/utils/content-similarity.util';

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
        reviewStatus: ReviewStatus.PENDING,
        priorityScore: this.scoreTelegramCandidate(seed),
        discoveryMetadata: {
          source: 'seed',
        },
      };

      if (looksLikeChatId) {
        await this.prisma.telegramGroupCandidate.upsert({
          where: { chatId: seed },
          create: data,
          update: {
            priorityScore: this.scoreTelegramCandidate(seed),
          },
        });
      } else {
        await this.prisma.telegramGroupCandidate.upsert({
          where: { inviteLink: seed },
          create: data,
          update: {
            priorityScore: this.scoreTelegramCandidate(seed),
          },
        });
      }
    }
  }

  async attemptApprovedTelegramJoins(): Promise<void> {
    const candidates = await this.prisma.telegramGroupCandidate.findMany({
      where: {
        approved: true,
        reviewStatus: ReviewStatus.APPROVED,
        OR: [{ throttleUntil: null }, { throttleUntil: { lte: new Date() } }],
      },
      orderBy: [{ priorityScore: 'desc' }, { updatedAt: 'asc' }],
      take: 100,
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
            throttleUntil: new Date(now.getTime() + 30 * 60_000),
          },
        });
        continue;
      }

      const account = await this.accountsService.getEligibleAccount(
        AccountPlatform.TELEGRAM,
      );
      const credentials = account
        ? this.accountsService.getTelegramCredentials(account.accountHandle)
        : null;

      const accessible = credentials
        ? await this.telegramPublisher.canAccessChat(chatRef, credentials.botToken)
        : false;
      await this.prisma.telegramGroupCandidate.update({
        where: { id: candidate.id },
        data: {
          chatId: candidate.chatId ?? chatRef,
          joined: accessible,
          lastAttemptAt: now,
          throttleUntil: accessible
            ? null
            : new Date(now.getTime() + 60 * 60_000),
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
          accountHandle: account?.accountHandle ?? null,
        },
      );
    }
  }

  async listTelegramCandidates(): Promise<
    Array<{
      id: string;
      title: string;
      approved: boolean;
      reviewStatus: ReviewStatus;
      priorityScore: number;
      joined: boolean;
      chatId: string | null;
      inviteLink: string | null;
      statusNote: string | null;
      lastAttemptAt: Date | null;
      throttleUntil: Date | null;
    }>
  > {
    const rows = await this.prisma.telegramGroupCandidate.findMany({
      orderBy: [{ priorityScore: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      approved: row.approved,
      reviewStatus: row.reviewStatus,
      priorityScore: row.priorityScore,
      joined: row.joined,
      chatId: row.chatId,
      inviteLink: row.inviteLink,
      statusNote: row.statusNote,
      lastAttemptAt: row.lastAttemptAt,
      throttleUntil: row.throttleUntil,
    }));
  }

  async approveTelegramCandidate(candidateId: string): Promise<void> {
    await this.prisma.telegramGroupCandidate.update({
      where: { id: candidateId },
      data: { approved: true, reviewStatus: ReviewStatus.APPROVED },
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
    const stocktwitsPolicy = await this.accountsService.getRotationPolicy(
      AccountPlatform.STOCKTWITS,
    );
    const telegramPolicy = await this.accountsService.getRotationPolicy(
      AccountPlatform.TELEGRAM,
    );

    let scheduledCount = 0;
    for (const [draftIndex, draftId] of draftIds.entries()) {
      const draft = await this.prisma.contentDraft.findUnique({
        where: { id: draftId },
      });
      if (!draft || draft.status !== DraftStatus.AUTO_APPROVED) {
        continue;
      }

      const stocktwitsAccount = await this.accountsService.getEligibleAccount(
        AccountPlatform.STOCKTWITS,
        {
          scheduledAt: this.resolveScheduledTime(stocktwitsPolicy, draftIndex),
        },
      );
      if (stocktwitsAccount) {
        scheduledCount += await this.createAndQueuePublishJob({
          draftId,
          platform: PublishPlatform.STOCKTWITS,
          accountId: stocktwitsAccount.id,
          targetRef: stocktwitsAccount.accountHandle,
          scheduleAt: this.resolveScheduledTime(stocktwitsPolicy, draftIndex),
          cooldownMinutes: publishCooldown,
          similarityThreshold: stocktwitsPolicy.duplicateSimilarityThreshold,
        });
      }

      const telegramTargets = await this.resolveTelegramTargets();
      for (const [targetIndex, target] of telegramTargets.entries()) {
        const scheduleAt = this.resolveScheduledTime(
          telegramPolicy,
          draftIndex + targetIndex,
        );
        const telegramAccount = await this.accountsService.getEligibleAccount(
          AccountPlatform.TELEGRAM,
          {
            scheduledAt: scheduleAt,
          },
        );
        if (!telegramAccount) {
          continue;
        }

        scheduledCount += await this.createAndQueuePublishJob({
          draftId,
          platform: PublishPlatform.TELEGRAM,
          accountId: telegramAccount.id,
          targetRef: target,
          scheduleAt,
          cooldownMinutes: publishCooldown,
          similarityThreshold: telegramPolicy.duplicateSimilarityThreshold,
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
      let activeAccount = job.account;
      if (job.platform === PublishPlatform.TELEGRAM) {
        activeAccount = await this.accountsService.ensureEligibleAccountForExecution(
          AccountPlatform.TELEGRAM,
          job.accountId,
        );
      }
      if (job.platform === PublishPlatform.STOCKTWITS) {
        activeAccount = await this.accountsService.ensureEligibleAccountForExecution(
          AccountPlatform.STOCKTWITS,
          job.accountId,
        );
      }

      if (activeAccount && activeAccount.id !== job.accountId) {
        await this.prisma.publishJob.update({
          where: { id: job.id },
          data: {
            accountId: activeAccount.id,
          },
        });
      }

      let externalPostId = '';
      let evidenceUri = '';
      let responsePayload: unknown = {};

      if (job.platform === PublishPlatform.TELEGRAM) {
        if (!activeAccount) {
          throw new Error('Telegram account is not available');
        }
        const credentials = this.accountsService.getTelegramCredentials(
          activeAccount.accountHandle,
        );
        if (!credentials) {
          throw new Error('Telegram bot credentials missing');
        }

        const result = await this.telegramPublisher.sendMessage(
          job.targetRef,
          job.draft.body,
          credentials.botToken,
        );
        externalPostId = result.externalPostId;
        responsePayload = result.responsePayload;
      } else {
        if (!activeAccount) {
          throw new Error('StockTwits account is not available');
        }
        const credentials = this.accountsService.getStocktwitsCredentials(
          activeAccount.accountHandle,
        );
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

      if (activeAccount?.id) {
        await this.accountsService.recordPublishOutcome(activeAccount.id, {
          success: true,
          metadata: {
            platform: job.platform,
            targetRef: job.targetRef,
          },
        });
      }

      this.telemetryService.increment('pipeline.publish.success');
      await this.auditService.record('publish.success', 'publish_job', job.id, {
        platform: job.platform,
        targetRef: job.targetRef,
        accountHandle: activeAccount?.accountHandle ?? null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unexpected publish error';
      const evidenceUri = this.extractEvidenceUriFromError(message);
      const restricted = isRestrictionError(message);

      if (job.accountId) {
        await this.accountsService.recordPublishOutcome(job.accountId, {
          success: false,
          reason: message,
          restricted,
          metadata: {
            platform: job.platform,
            targetRef: job.targetRef,
          },
        });
      }

      const rerouted = await this.tryRerouteFailedJob(job.id, message);
      if (rerouted) {
        return;
      }

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
          errorClass: restricted ? 'restriction' : 'publish_error',
          errorMessage: message,
          evidenceUri: evidenceUri || null,
        },
      });
      await this.reconcileDraftPublishState(job.draftId);

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
      accountId: string | null;
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
      accountId: row.accountId,
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
        account: {
          select: {
            accountHandle: true,
            platform: true,
            status: true,
            healthScore: true,
          },
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

  async dispatchPublishJobNow(publishJobId: string): Promise<void> {
    const existing = await this.prisma.publishJob.findUnique({
      where: { id: publishJobId },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
      },
    });
    if (!existing) {
      throw new NotFoundException('Publish job not found');
    }
    if (existing.status !== PublishStatus.PENDING) {
      throw new BadRequestException('Only PENDING publish jobs can be dispatched immediately');
    }

    const now = new Date();
    const job = await this.prisma.publishJob.update({
      where: { id: publishJobId },
      data: {
        scheduledAt: now,
      },
    });

    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId },
      {
        jobId: `${job.id}:dispatch-now:${Date.now()}`,
        delay: 0,
      },
    );

    await this.auditService.record(
      'publish.dispatch_now.queued',
      'publish_job',
      job.id,
      {
        previousScheduledAt: existing.scheduledAt.toISOString(),
        dispatchedAt: now.toISOString(),
      },
    );
  }

  async rerunFailedPublishJobNow(publishJobId: string): Promise<void> {
    const existing = await this.prisma.publishJob.findUnique({
      where: { id: publishJobId },
      select: {
        id: true,
        status: true,
        scheduledAt: true,
        draftId: true,
        attempts: true,
      },
    });
    if (!existing) {
      throw new NotFoundException('Publish job not found');
    }
    if (existing.status !== PublishStatus.FAILED) {
      throw new BadRequestException('Only FAILED publish jobs can be rerun immediately');
    }

    const now = new Date();
    const job = await this.prisma.publishJob.update({
      where: { id: publishJobId },
      data: {
        status: PublishStatus.PENDING,
        scheduledAt: now,
        lastError: null,
        evidenceUri: null,
        externalPostId: null,
      },
    });
    await this.reconcileDraftPublishState(existing.draftId);

    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId },
      {
        jobId: `${job.id}:rerun-now:${Date.now()}`,
        delay: 0,
      },
    );

    await this.auditService.record(
      'publish.rerun_now.queued',
      'publish_job',
      job.id,
      {
        previousScheduledAt: existing.scheduledAt.toISOString(),
        previousAttempts: existing.attempts,
        rerunAt: now.toISOString(),
      },
    );
  }

  async getOperationsDashboard(): Promise<Record<string, unknown>> {
    const [accountSummary, pendingCandidates, jobSummary, connectorSummary] =
      await Promise.all([
        this.accountsService.listAccountsDashboard(),
        this.prisma.telegramGroupCandidate.findMany({
          where: {
            reviewStatus: ReviewStatus.PENDING,
          },
          orderBy: [{ priorityScore: 'desc' }, { createdAt: 'asc' }],
          take: 25,
        }),
        this.prisma.publishJob.groupBy({
          by: ['status', 'platform'],
          _count: {
            _all: true,
          },
        }),
        this.prisma.sourceConnectorState.findMany({
          orderBy: [{ priority: 'desc' }],
        }),
      ]);

    return {
      accounts: accountSummary,
      telegramReviewQueue: pendingCandidates,
      publishJobs: jobSummary,
      connectors: connectorSummary,
    };
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
        reviewStatus: ReviewStatus.APPROVED,
        joined: true,
        chatId: {
          not: null,
        },
      },
      select: {
        chatId: true,
      },
      orderBy: [{ priorityScore: 'desc' }],
      take: 50,
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

  private resolveScheduledTime(
    policy: {
      minDelayMinutes: number;
      maxDelayMinutes: number;
    },
    offsetSeed = 0,
  ): Date {
    const jitterMinutes = randomInt(
      policy.minDelayMinutes,
      Math.max(policy.minDelayMinutes + 1, policy.maxDelayMinutes + 1),
    );
    return new Date(Date.now() + (jitterMinutes + offsetSeed * 2) * 60_000);
  }

  private async createAndQueuePublishJob(input: {
    draftId: string;
    platform: PublishPlatform;
    accountId: string | null;
    targetRef: string;
    scheduleAt: Date;
    cooldownMinutes: number;
    similarityThreshold: number;
  }): Promise<number> {
    const duplicateExists = await this.hasRecentDuplicateWithinCooldown(
      input.draftId,
      input.platform,
      input.targetRef,
      input.scheduleAt,
      input.cooldownMinutes,
      input.similarityThreshold,
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
        `${input.draftId}:${input.platform}:${input.targetRef}:${input.accountId ?? 'unassigned'}:${cooldownBucket}`,
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
    similarityThreshold: number,
  ): Promise<boolean> {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: draftId },
      select: { contentHash: true, body: true },
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
    if (existing) {
      return true;
    }

    const recentBodies = await this.prisma.publishJob.findMany({
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
      },
      include: {
        draft: {
          select: {
            body: true,
          },
        },
      },
      take: 20,
      orderBy: {
        scheduledAt: 'desc',
      },
    });

    return recentBodies.some(
      (row) =>
        calculateContentSimilarity(row.draft.body, draft.body) >=
        similarityThreshold,
    );
  }

  private async tryRerouteFailedJob(
    publishJobId: string,
    errorMessage: string,
  ): Promise<boolean> {
    const job = await this.prisma.publishJob.findUnique({
      where: { id: publishJobId },
      include: {
        account: true,
      },
    });
    if (!job || !job.accountId || !isReroutableFailure(errorMessage)) {
      return false;
    }

    const platform =
      job.platform === PublishPlatform.TELEGRAM
        ? AccountPlatform.TELEGRAM
        : AccountPlatform.STOCKTWITS;
    const fallback = await this.accountsService.getEligibleAccount(platform, {
      excludeAccountId: job.accountId,
      scheduledAt: new Date(
        Date.now() +
          this.configService.getOrThrow<number>('PHASE2_ADAPTIVE_COOLDOWN_MINUTES') *
            60_000,
      ),
    });
    if (!fallback) {
      return false;
    }

    const rescheduleAt = new Date(
      Date.now() +
        this.configService.getOrThrow<number>('PHASE2_ADAPTIVE_COOLDOWN_MINUTES') *
          60_000,
    );
    await this.prisma.publishJob.update({
      where: { id: publishJobId },
      data: {
        accountId: fallback.id,
        status: PublishStatus.PENDING,
        scheduledAt: rescheduleAt,
        lastError: `Rerouted after failure: ${errorMessage}`,
        attempts: {
          increment: 1,
        },
      },
    });
    await this.prisma.publishAttempt.create({
      data: {
        publishJobId,
        success: false,
        errorClass: 'rerouted',
        errorMessage,
      },
    });

    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId },
      {
        jobId: `${publishJobId}:reroute:${Date.now()}`,
        delay: Math.max(0, rescheduleAt.getTime() - Date.now()),
      },
    );

    await this.auditService.record('publish.rerouted', 'publish_job', publishJobId, {
      fromAccountId: job.accountId,
      toAccountId: fallback.id,
      reason: errorMessage,
      retryAt: rescheduleAt.toISOString(),
    });
    return true;
  }

  private scoreTelegramCandidate(seed: string): number {
    let score = 0.4;
    if (/stocks?|crypto|invest|trade|alpha/i.test(seed)) {
      score += 0.35;
    }
    if (/t\.me\/|^@/.test(seed)) {
      score += 0.15;
    }
    if (/vip|signals?|pump/i.test(seed)) {
      score -= 0.2;
    }
    return Math.max(0, Math.min(1, score));
  }
}

function isRestrictionError(message: string): boolean {
  return /(ban|blocked|restricted|suspended|captcha|locked|challenge)/i.test(
    message,
  );
}

function isReroutableFailure(message: string): boolean {
  return /(timeout|429|5\d\d|captcha|challenge|blocked|restricted|network)/i.test(
    message,
  );
}

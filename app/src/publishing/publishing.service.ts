import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import {
  AccountPlatform,
  AccountStatus,
  DeadLetterStatus,
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
import { DlvritPublisher } from './dlvrit.publisher';
import { DlvritSessionService } from './dlvrit-session.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { calculateContentSimilarity } from '../common/utils/content-similarity.util';
import { MANDATORY_DISCLAIMER } from '../common/constants/policy.constants';
import { DiscordUiPublisher } from './discord-ui.publisher';
import { StocktwitsComplianceService } from '../policy/stocktwits-compliance.service';
import { PostingPolicyService } from '../policy/posting-policy.service';

@Injectable()
export class PublishingService {
  private static readonly PUBLISH_LOCK_KEY_PREFIX = 'publish-job';
  private static readonly STOCKTWITS_TOP_SYMBOL_LIMIT = 10;
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly accountsService: AccountsService,
    private readonly auditService: AuditService,
    private readonly telegramPublisher: TelegramPublisher,
    private readonly stocktwitsPublisher: StocktwitsPublisher,
    private readonly dlvritPublisher: DlvritPublisher,
    private readonly dlvritSessionService: DlvritSessionService,
    private readonly discordUiPublisher: DiscordUiPublisher,
    private readonly stocktwitsComplianceService: StocktwitsComplianceService,
    private readonly postingPolicyService: PostingPolicyService,
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

      const accessResult = credentials
        ? await this.telegramPublisher.inspectChatAccess(
            chatRef,
            credentials.botToken,
          )
        : { accessible: false, resolvedChatId: chatRef };
      await this.prisma.telegramGroupCandidate.update({
        where: { id: candidate.id },
        data: {
          chatId: accessResult.resolvedChatId,
          joined: accessResult.accessible,
          lastAttemptAt: now,
          throttleUntil: accessResult.accessible
            ? null
            : new Date(now.getTime() + 60 * 60_000),
          statusNote: accessResult.accessible
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
          resolvedChatRef: accessResult.resolvedChatId,
          success: accessResult.accessible,
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
    const stocktwitsTrendingSymbols =
      await this.resolveStocktwitsTrendingSymbolsForCycle();

    let scheduledCount = 0;
    let stocktwitsScheduledCount = 0;
    let telegramScheduledCount = 0;
    for (const [draftIndex, draftId] of draftIds.entries()) {
      const draft = await this.prisma.contentDraft.findUnique({
        where: { id: draftId },
        include: { trendTopic: true },
      });
      if (!draft || draft.status !== DraftStatus.AUTO_APPROVED) {
        continue;
      }

      // Each draft is always posted to the symbol it was written about.
      // The old approach (post every draft to every trending symbol) was the
      // primary cause of account muting: StockTwits flags content posted to
      // unrelated symbol feeds as spam ("$AAPL\n\n<GME content>" on the AAPL
      // stream is explicitly against their rules). Each piece of content must
      // only appear on the feed for the ticker it discusses.
      const draftSymbol = draft.trendTopic?.symbol ?? null;
      if (!draftSymbol) {
        this.logger.warn(
          `Draft ${draftId} has no associated trend symbol — skipping StockTwits scheduling.`,
        );
      }

      // Additionally, check whether the draft's symbol is currently trending
      // so we prioritise while the ticker has momentum; skip if not in the
      // trending list (content about a symbol that isn't trending has lower
      // value and higher spam risk on feeds).
      const symbolIsTrending =
        draftSymbol !== null &&
        (stocktwitsTrendingSymbols.length === 0 ||
          stocktwitsTrendingSymbols.includes(draftSymbol));

      if (draftSymbol && symbolIsTrending) {
        const scheduleAt = this.resolveScheduledTime(
          stocktwitsPolicy,
          draftIndex,
        );
        const stocktwitsAccount = await this.accountsService.getEligibleAccount(
          AccountPlatform.STOCKTWITS,
          { scheduledAt: scheduleAt },
        );

        if (stocktwitsAccount) {
          const createdCount = await this.createAndQueuePublishJob({
            draftId,
            platform: PublishPlatform.STOCKTWITS,
            accountId: stocktwitsAccount.id,
            targetRef: draftSymbol,
            scheduleAt,
            cooldownMinutes: publishCooldown,
            similarityThreshold: stocktwitsPolicy.duplicateSimilarityThreshold,
          });
          scheduledCount += createdCount;
          stocktwitsScheduledCount += createdCount;

          if (createdCount > 0) {
            await this.auditService.record(
              'stocktwits.trending_job.queued',
              'draft',
              draftId,
              {
                symbol: draftSymbol,
                accountId: stocktwitsAccount.id,
                scheduleAt: scheduleAt.toISOString(),
                source: 'draft_own_symbol',
              },
            );
          }
        }
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

        const createdCount = await this.createAndQueuePublishJob({
          draftId,
          platform: PublishPlatform.TELEGRAM,
          accountId: telegramAccount.id,
          targetRef: target,
          scheduleAt,
          cooldownMinutes: publishCooldown,
          similarityThreshold: telegramPolicy.duplicateSimilarityThreshold,
        });
        scheduledCount += createdCount;
        telegramScheduledCount += createdCount;
      }
    }

    this.logger.log(
      `Scheduled publish jobs -> stocktwits:${stocktwitsScheduledCount}, telegram:${telegramScheduledCount}, total:${scheduledCount}. ` +
        `Trending symbols (used as filter): ${stocktwitsTrendingSymbols.join(', ') || 'none'}`,
    );

    this.telemetryService.increment(
      'pipeline.publish.jobs_scheduled',
      scheduledCount,
    );
    return scheduledCount;
  }

  async executePublishJob(publishJobId: string): Promise<void> {
    const lockKey = `${PublishingService.PUBLISH_LOCK_KEY_PREFIX}:${publishJobId}`;
    const lockAcquired = await this.acquirePublishJobLock(lockKey);
    if (!lockAcquired) {
      return;
    }

    try {
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
      this.logger.log(
        `Executing publish job ${job.id} (${job.platform}) -> ${job.targetRef}`,
      );

      if (job.platform === PublishPlatform.DISCORD) {
        await this.prisma.publishJob.update({
          where: { id: job.id },
          data: {
            status: PublishStatus.SKIPPED,
            attempts: {
              increment: 1,
            },
            lastError:
              'discord_webhook_publishing_removed_use_manual_discord_ui_mode',
          },
        });
        await this.prisma.publishAttempt.create({
          data: {
            publishJobId: job.id,
            success: false,
            errorClass: 'platform_removed',
            errorMessage:
              'Discord webhook/bot publishing removed. Use manual publish with discord UI mode.',
          },
        });
        await this.reconcileDraftPublishState(job.draftId);
        await this.auditService.record(
          'publish.skipped',
          'publish_job',
          job.id,
          {
            platform: job.platform,
            reason:
              'discord_webhook_publishing_removed_use_manual_discord_ui_mode',
          },
        );
        return;
      }

      try {
        let activeAccount = job.account;
        if (job.platform === PublishPlatform.TELEGRAM) {
          activeAccount =
            await this.accountsService.ensureEligibleAccountForExecution(
              AccountPlatform.TELEGRAM,
              job.accountId,
            );
        }
        if (job.platform === PublishPlatform.STOCKTWITS) {
          activeAccount =
            await this.accountsService.ensureEligibleAccountForExecution(
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
        let resolvedTargetRef = job.targetRef;
        const sanitizedBody = this.stripMandatoryDisclaimer(job.draft.body);

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
            sanitizedBody,
            credentials.botToken,
          );
          externalPostId = result.externalPostId;
          responsePayload = result.responsePayload;
          if (result.resolvedChatId) {
            resolvedTargetRef = result.resolvedChatId;
          }
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

          const stocktwitsTargetSymbol = this.normalizeStocktwitsTargetSymbol(
            job.targetRef,
          );
          const stocktwitsMessage = this.buildStocktwitsSymbolMessage(
            sanitizedBody,
            stocktwitsTargetSymbol,
          );

          // ── Gate 1: Market hours ────────────────────────────────────────────
          const enforceMarketHours =
            this.configService.get<boolean>(
              'STOCKTWITS_ENFORCE_MARKET_HOURS',
            ) ?? false;
          if (
            enforceMarketHours &&
            !this.postingPolicyService.isMarketHours()
          ) {
            this.logger.warn(
              `Job ${job.id}: skipping StockTwits post — outside market hours ` +
                `(Mon–Fri 8 AM–6 PM ET). Set STOCKTWITS_ENFORCE_MARKET_HOURS=false to disable.`,
            );
            await this.prisma.publishJob.update({
              where: { id: job.id },
              data: {
                status: PublishStatus.SKIPPED,
                attempts: { increment: 1 },
                lastError: 'stocktwits_off_hours',
              },
            });
            await this.reconcileDraftPublishState(job.draftId);
            return;
          }

          // ── Gate 2: Account warm-up ─────────────────────────────────────────
          const minWarmupPosts =
            this.configService.get<number>('STOCKTWITS_MIN_WARMUP_POSTS') ?? 0;
          if (minWarmupPosts > 0) {
            const successfulPosts = await this.prisma.publishJob.count({
              where: {
                accountId: activeAccount.id,
                platform: PublishPlatform.STOCKTWITS,
                status: PublishStatus.SUCCESS,
              },
            });
            if (successfulPosts < minWarmupPosts) {
              this.logger.warn(
                `Job ${job.id}: account "${activeAccount.accountHandle}" is in ` +
                  `warm-up phase (${successfulPosts}/${minWarmupPosts} successful posts). ` +
                  `Running engagement session to build account trust instead of skipping.`,
              );
              // Run an engagement session (browse + like) instead of silently
              // skipping. This builds genuine activity history even while the
              // account is below the promotional-post threshold.
              try {
                await this.stocktwitsPublisher.runEngagementSession(credentials);
                this.logger.log(
                  `Warm-up engagement for "${activeAccount.accountHandle}" complete.`,
                );
              } catch (engErr) {
                this.logger.warn(
                  `Warm-up engagement failed (non-fatal): ${engErr instanceof Error ? engErr.message : engErr}`,
                );
              }
              await this.prisma.publishJob.update({
                where: { id: job.id },
                data: {
                  status: PublishStatus.SKIPPED,
                  attempts: { increment: 1 },
                  lastError: `stocktwits_warmup_required:${successfulPosts}/${minWarmupPosts}`,
                },
              });
              await this.reconcileDraftPublishState(job.draftId);
              return;
            }
          }

          // ── Gate 3: DB-backed minimum inter-post spacing ────────────────────
          // The in-memory token bucket in PostingPolicyService resets on restart.
          // This DB check enforces the same minimum gap using the persisted
          // lastPublishedAt timestamp, so the constraint survives process bounces.
          const minInterPostMs =
            this.configService.get<number>('STOCKTWITS_API_MIN_INTER_POST_MS') ?? 0;
          if (minInterPostMs > 0) {
            const healthState = await this.prisma.accountHealthState.findUnique({
              where: { accountId: activeAccount.id },
              select: { lastPublishedAt: true },
            });
            const lastPublishedAt = healthState?.lastPublishedAt;
            if (lastPublishedAt) {
              const elapsed = Date.now() - lastPublishedAt.getTime();
              if (elapsed < minInterPostMs) {
                const waitSec = Math.ceil((minInterPostMs - elapsed) / 1_000);
                throw new Error(
                  `stocktwits_posting_policy_rate_limit: account ` +
                    `"${activeAccount.accountHandle}" posted ` +
                    `${Math.round(elapsed / 1_000)}s ago — minimum spacing is ` +
                    `${Math.round(minInterPostMs / 1_000)}s. Retry in ${waitSec}s.`,
                );
              }
            }
          }

          const useLegacyPoster =
            this.configService.get<boolean>('STOCKTWITS_USE_LEGACY_POSTER') ??
            false;

          if (useLegacyPoster) {
            const result = await this.stocktwitsPublisher.publish(
              credentials,
              stocktwitsMessage,
              job.id,
              stocktwitsTargetSymbol ?? undefined,
            );
            externalPostId = result.externalPostId;
            evidenceUri = result.evidenceUri;
            responsePayload = result;
          } else {
            const dlvritAccountId =
              await this.accountsService.getDlvritAccountId(
                activeAccount.accountHandle,
              );
            if (!dlvritAccountId) {
              throw new Error(
                `dlvrit_account_not_configured: account "${activeAccount.accountHandle}" ` +
                  `has no dlvritAccountId set. Configure it via the Manual UI → Account Management.`,
              );
            }
            const result = await this.dlvritPublisher.postToAccount({
              dlvritAccountId,
              message: stocktwitsMessage,
              jobId: job.id,
            });
            externalPostId = result.externalPostId;
            evidenceUri = result.evidenceUri;
            responsePayload = result;
          }

          if (stocktwitsTargetSymbol) {
            resolvedTargetRef = stocktwitsTargetSymbol;
          }
        }

        if (!externalPostId) {
          throw new Error(
            `${job.platform.toLowerCase()}_publish_not_confirmed`,
          );
        }

        await this.prisma.publishJob.update({
          where: { id: job.id },
          data: {
            status: PublishStatus.SUCCESS,
            attempts: {
              increment: 1,
            },
            targetRef: resolvedTargetRef,
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
              targetRef: resolvedTargetRef,
            },
          });
        }

        this.telemetryService.increment('pipeline.publish.success');
        await this.auditService.record(
          'publish.success',
          'publish_job',
          job.id,
          {
            platform: job.platform,
            targetRef: resolvedTargetRef,
            accountHandle: activeAccount?.accountHandle ?? null,
          },
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unexpected publish error';
        const evidenceUri = this.extractEvidenceUriFromError(message);
        const restricted = isRestrictionError(message);
        const nextAttempts = job.attempts + 1;
        const failurePayload = this.extractFailurePayload(error);

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

        // Account restriction (muted/banned) must HALT posting immediately.
        // Rerouting to another account burns that account on identical content
        // and signals coordinated spam to StockTwits moderation — exactly wrong.
        if (PostingPolicyService.isAccountRestrictionError(message)) {
          // isRestrictionError() already matched "muted"/"restricted" above,
          // so recordPublishOutcome(restricted:true) was already called at
          // line 816 — the account is already being QUARANTINED. Just log loudly
          // and skip the reroute.
          this.logger.error(
            `[POSTING HALTED] Account restriction detected for job ${job.id}. ` +
              `Account "${job.account?.accountHandle ?? job.accountId}" ` +
              `is muted or restricted by StockTwits. Account QUARANTINED. ` +
              `Do NOT retry through proxies or other accounts. ` +
              `Check the account at stocktwits.com manually.`,
          );
          // No reroute — fall through to FAILED recording.
        } else {
          const rerouted = await this.tryRerouteFailedJob(job.id, message);
          if (rerouted) {
            return;
          }
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
            responsePayload: failurePayload ?? undefined,
            evidenceUri: evidenceUri || null,
          },
        });
        await this.reconcileDraftPublishState(job.draftId);
        await this.moveToDeadLetterIfExhausted({
          publishJobId: job.id,
          attempts: nextAttempts,
          reason: message,
          metadata: {
            platform: job.platform,
            targetRef: job.targetRef,
            evidenceUri: evidenceUri ?? null,
          },
        });

        this.telemetryService.increment('pipeline.publish.failed');
        this.logger.error(
          `Publish failed for job ${job.id} (${job.platform}) -> ${job.targetRef}. ${message}`,
        );
        await this.auditService.record(
          'publish.failed',
          'publish_job',
          job.id,
          {
            platform: job.platform,
            message,
            evidenceUri,
          },
        );
      }
    } finally {
      await this.releasePublishJobLock(lockKey);
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

  async listDeadLetterJobs(
    limit = 100,
    status?: DeadLetterStatus,
  ): Promise<
    Array<{
      id: string;
      publishJobId: string;
      status: DeadLetterStatus;
      reason: string;
      attempts: number;
      firstFailedAt: Date;
      movedAt: Date;
      replayedAt: Date | null;
      platform: PublishPlatform;
      targetRef: string;
      publishStatus: PublishStatus;
      draftId: string;
      accountId: string | null;
    }>
  > {
    const rows = await this.prisma.publishDeadLetter.findMany({
      where: status ? { status } : undefined,
      include: {
        publishJob: {
          select: {
            id: true,
            platform: true,
            targetRef: true,
            status: true,
            draftId: true,
            accountId: true,
          },
        },
      },
      orderBy: { movedAt: 'desc' },
      take: Math.max(1, Math.min(limit, 500)),
    });

    return rows.map((row) => ({
      id: row.id,
      publishJobId: row.publishJobId,
      status: row.status,
      reason: row.reason,
      attempts: row.attempts,
      firstFailedAt: row.firstFailedAt,
      movedAt: row.movedAt,
      replayedAt: row.replayedAt,
      platform: row.publishJob.platform,
      targetRef: row.publishJob.targetRef,
      publishStatus: row.publishJob.status,
      draftId: row.publishJob.draftId,
      accountId: row.publishJob.accountId,
    }));
  }

  async dismissDeadLetter(deadLetterId: string, note?: string): Promise<void> {
    const existing = await this.prisma.publishDeadLetter.findUnique({
      where: { id: deadLetterId },
    });
    if (!existing) {
      throw new NotFoundException('Dead-letter entry not found');
    }

    await this.prisma.publishDeadLetter.update({
      where: { id: deadLetterId },
      data: {
        status: DeadLetterStatus.DISMISSED,
        metadata: this.mergeDeadLetterMetadata(existing.metadata, {
          dismissedAt: new Date().toISOString(),
          dismissalNote: note ?? null,
        }),
      },
    });

    await this.auditService.record(
      'publish.dead_letter.dismissed',
      'publish_dead_letter',
      deadLetterId,
      {
        publishJobId: existing.publishJobId,
        note: note ?? null,
      },
    );
  }

  async replayDeadLetter(deadLetterId: string): Promise<void> {
    const existing = await this.prisma.publishDeadLetter.findUnique({
      where: { id: deadLetterId },
      include: {
        publishJob: {
          select: {
            id: true,
            status: true,
            draftId: true,
            scheduledAt: true,
          },
        },
      },
    });
    if (!existing) {
      throw new NotFoundException('Dead-letter entry not found');
    }
    if (existing.status !== DeadLetterStatus.OPEN) {
      throw new BadRequestException(
        'Only OPEN dead-letter entries can be replayed',
      );
    }
    if (existing.publishJob.status !== PublishStatus.FAILED) {
      throw new BadRequestException(
        'Replay requires the linked publish job to be in FAILED status',
      );
    }

    const replayAt = new Date();
    await this.prisma.publishJob.update({
      where: { id: existing.publishJobId },
      data: {
        status: PublishStatus.PENDING,
        attempts: 0,
        lastError: null,
        evidenceUri: null,
        externalPostId: null,
        scheduledAt: replayAt,
      },
    });
    await this.reconcileDraftPublishState(existing.publishJob.draftId);

    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId: existing.publishJobId },
      {
        jobId: `${existing.publishJobId}:dlq-replay:${Date.now()}`,
        delay: 0,
      },
    );

    await this.markDeadLetterAsReplayedIfOpen(
      existing.publishJobId,
      'dlq_replay',
    );

    await this.auditService.record(
      'publish.dead_letter.replayed',
      'publish_dead_letter',
      deadLetterId,
      {
        publishJobId: existing.publishJobId,
      },
    );
  }

  async replayFailedWindow(input: {
    fromIso: string;
    toIso: string;
    platform?: PublishPlatform;
  }): Promise<Record<string, unknown>> {
    const from = new Date(input.fromIso);
    const to = new Date(input.toIso);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
      throw new BadRequestException(
        'fromIso/toIso must be valid ISO timestamps',
      );
    }
    if (from > to) {
      throw new BadRequestException('fromIso cannot be after toIso');
    }

    const batchSize = this.configService.getOrThrow<number>(
      'PUBLISH_REPLAY_BATCH_SIZE',
    );
    const candidates = await this.prisma.publishJob.findMany({
      where: {
        status: PublishStatus.FAILED,
        scheduledAt: {
          gte: from,
          lte: to,
        },
        ...(input.platform ? { platform: input.platform } : {}),
      },
      select: {
        id: true,
        draftId: true,
      },
      orderBy: { scheduledAt: 'asc' },
      take: batchSize,
    });

    let replayed = 0;
    const replayedDraftIds = new Set<string>();
    const replayAnchor = Date.now();
    for (const [index, candidate] of candidates.entries()) {
      const replayAt = new Date(replayAnchor + index * 250);
      const updateResult = await this.prisma.publishJob.updateMany({
        where: {
          id: candidate.id,
          status: PublishStatus.FAILED,
        },
        data: {
          status: PublishStatus.PENDING,
          attempts: 0,
          lastError: null,
          evidenceUri: null,
          externalPostId: null,
          scheduledAt: replayAt,
        },
      });
      if (updateResult.count === 0) {
        continue;
      }

      await this.publishQueue.add(
        PUBLISH_JOB_EXECUTE,
        { publishJobId: candidate.id },
        {
          jobId: `${candidate.id}:window-replay:${Date.now()}:${index}`,
          delay: Math.max(0, replayAt.getTime() - Date.now()),
        },
      );
      await this.markDeadLetterAsReplayedIfOpen(candidate.id, 'window_replay');
      replayedDraftIds.add(candidate.draftId);
      replayed += 1;
    }

    for (const draftId of replayedDraftIds) {
      await this.reconcileDraftPublishState(draftId);
    }

    await this.auditService.record(
      'publish.failed_window.replayed',
      'system',
      'publish_window',
      {
        fromIso: from.toISOString(),
        toIso: to.toISOString(),
        platform: input.platform ?? null,
        matched: candidates.length,
        replayed,
        replayBatchSize: batchSize,
      },
    );

    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      platform: input.platform ?? null,
      matched: candidates.length,
      replayed,
      replayBatchSize: batchSize,
    };
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
    const retryDelayMs =
      this.configService.getOrThrow<number>('PUBLISH_RETRY_DELAY_SECONDS') *
      1000;

    const job = await this.prisma.publishJob.update({
      where: { id: publishJobId },
      data: {
        status: PublishStatus.PENDING,
        scheduledAt: new Date(Date.now() + retryDelayMs),
        lastError: null,
      },
    });
    await this.reconcileDraftPublishState(existing.draftId);

    await this.publishQueue.add(
      PUBLISH_JOB_EXECUTE,
      { publishJobId },
      {
        jobId: `${job.id}:retry:${Date.now()}`,
        delay: retryDelayMs,
      },
    );
    await this.markDeadLetterAsReplayedIfOpen(job.id, 'retry');

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
      throw new BadRequestException(
        'Only PENDING publish jobs can be dispatched immediately',
      );
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
      throw new BadRequestException(
        'Only FAILED publish jobs can be rerun immediately',
      );
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
    await this.markDeadLetterAsReplayedIfOpen(job.id, 'rerun_now');

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

  async getStocktwitsSessionStatus(): Promise<Record<string, unknown>> {
    return this.stocktwitsPublisher.getSessionStatus();
  }

  /**
   * Run engagement-only sessions (browse + like) for all StockTwits accounts
   * that are below the warm-up post threshold.
   *
   * Call this endpoint manually after creating new accounts to build genuine
   * activity history before switching to promotional posting.
   * Also useful for existing muted accounts while waiting for mutes to expire —
   * engagement sessions keep the account behaviorally warm.
   */
  async runWarmupEngagementForEligibleAccounts(): Promise<{
    attempted: number;
    succeeded: number;
    results: Array<{ handle: string; success: boolean; error?: string; likesPerformed?: number }>;
  }> {
    await this.accountsService.syncAccountsFromConfig();
    const minWarmupPosts =
      this.configService.get<number>('STOCKTWITS_MIN_WARMUP_POSTS') ?? 50;

    const allActive = await this.prisma.accountProfile.findMany({
      where: {
        platform: AccountPlatform.STOCKTWITS,
        status: AccountStatus.ACTIVE,
      },
      select: { id: true, accountHandle: true },
    });

    const results: Array<{ handle: string; success: boolean; error?: string; likesPerformed?: number }> = [];

    for (const account of allActive) {
      const successfulPosts = await this.prisma.publishJob.count({
        where: {
          accountId: account.id,
          platform: PublishPlatform.STOCKTWITS,
          status: PublishStatus.SUCCESS,
        },
      });

      if (successfulPosts >= minWarmupPosts) {
        continue; // Already warmed up
      }

      const credentials = this.accountsService.getStocktwitsCredentials(
        account.accountHandle,
      );
      if (!credentials) {
        results.push({ handle: account.accountHandle, success: false, error: 'credentials_missing' });
        continue;
      }

      try {
        const result = await this.stocktwitsPublisher.runEngagementSession({
          ...credentials,
          handle: account.accountHandle,
        });
        results.push({
          handle: account.accountHandle,
          success: true,
          likesPerformed: result.likesPerformed,
        });
        await this.auditService.record('stocktwits.warmup.engagement', 'account', account.id, {
          accountHandle: account.accountHandle,
          successfulPosts,
          minWarmupPosts,
          ...result,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results.push({ handle: account.accountHandle, success: false, error: errMsg });
        this.logger.warn(`Warm-up engagement failed for @${account.accountHandle}: ${errMsg}`);
      }
    }

    return {
      attempted: results.length,
      succeeded: results.filter((r) => r.success).length,
      results,
    };
  }

  async bootstrapStocktwitsSession(): Promise<Record<string, unknown>> {
    await this.accountsService.syncAccountsFromConfig();
    const account = await this.accountsService.getEligibleAccount(
      AccountPlatform.STOCKTWITS,
    );
    if (!account) {
      throw new NotFoundException('No active StockTwits account configured');
    }

    const credentials = this.accountsService.getStocktwitsCredentials(
      account.accountHandle,
    );
    if (!credentials) {
      throw new NotFoundException('StockTwits account credentials missing');
    }

    const result = await this.stocktwitsPublisher.bootstrapSession(credentials);
    await this.auditService.record(
      'stocktwits.session.bootstrap',
      'account',
      account.id,
      {
        accountHandle: account.accountHandle,
        ...result,
      },
    );
    return {
      accountHandle: account.accountHandle,
      ...result,
    };
  }

  /**
   * Opens Chrome through the configured Stocktwits proxy to verify connectivity.
   * Headed on a desktop; headless in Docker (no X11), returning `detectedPublicIp` when possible.
   */
  async openStocktwitsProxyTestWindow(
    manualProxyOverride?: string,
  ): Promise<{
    ok: boolean;
    message: string;
    testUrl: string;
    proxyServer?: string;
    headless?: boolean;
    detectedPublicIp?: string;
    visualCheckUrl?: string;
    screenshotMimeType?: string;
    screenshotBase64?: string;
    verification?: 'playwright' | 'nodejs_axios_fallback';
    chromeError?: string;
    manualProxyOverrideUsed?: boolean;
    error?: string;
  }> {
    return this.stocktwitsPublisher.openProxyVerificationWindow(
      manualProxyOverride,
    );
  }

  async publishManualPost(input: {
    body: string;
    stocktwitsSymbol?: string;
    stocktwitsItems?: Array<{ symbol?: string; body?: string }>;
    stocktwitsUsername?: string;
    stocktwitsPassword?: string;
    stocktwitsProxy?: string;
    stocktwitsAccountHandle?: string;
    publishToStocktwits?: boolean;
    publishToDiscord?: boolean;
    discordServerUrl?: string;
    discordServerUrls?: string[];
    discordEmail?: string;
    discordPassword?: string;
  }): Promise<{
    id: string;
    body: string;
    success: boolean;
    stocktwits: {
      attempted: boolean;
      success: boolean;
      accountId: string | null;
      accountHandle: string | null;
      targetSymbol: string | null;
      targetSymbols: string[];
      totalCount: number;
      successCount: number;
      failedCount: number;
      manualCredentialsUsed: boolean;
      proxyOverrideUsed: boolean;
      externalPostId: string | null;
      evidenceUri: string | null;
      error: string | null;
      results: Array<{
        symbol: string;
        success: boolean;
        externalPostId: string | null;
        evidenceUri: string | null;
        error: string | null;
      }>;
    };
    discord: {
      attempted: boolean;
      targetCount: number;
      successCount: number;
      skippedCount: number;
      failedCount: number;
      error: string | null;
      results: Array<{
        channelId: string;
        success: boolean;
        externalPostId: string | null;
        error: string | null;
      }>;
    };
  }> {
    const sanitizedBody = this.stripMandatoryDisclaimer(
      input.body || '',
    ).trim();
    const runtimeStocktwitsUsername = (input.stocktwitsUsername || '').trim();
    const runtimeStocktwitsPassword = (input.stocktwitsPassword || '').trim();
    const runtimeStocktwitsProxy = (input.stocktwitsProxy || '').trim();
    const hasManualStocktwitsCredentials =
      runtimeStocktwitsUsername.length > 0 ||
      runtimeStocktwitsPassword.length > 0;
    if (
      hasManualStocktwitsCredentials &&
      (!runtimeStocktwitsUsername || !runtimeStocktwitsPassword)
    ) {
      throw new BadRequestException(
        'Both stocktwitsUsername and stocktwitsPassword are required when using manual StockTwits credentials.',
      );
    }

    const useLegacyPoster =
      this.configService.get<boolean>('STOCKTWITS_USE_LEGACY_POSTER') ?? false;

    const publishToStocktwits = input.publishToStocktwits !== false;
    const publishToDiscord = input.publishToDiscord !== false;
    if (!publishToStocktwits && !publishToDiscord) {
      throw new BadRequestException(
        'At least one destination must be enabled (StockTwits or Discord).',
      );
    }

    if (publishToStocktwits && useLegacyPoster) {
      if (!runtimeStocktwitsUsername) {
        throw new BadRequestException(
          'StockTwits Username and Password are required for manual publishing.',
        );
      }
      if (!runtimeStocktwitsPassword) {
        throw new BadRequestException(
          'StockTwits Password is required for manual publishing.',
        );
      }
    }

    if (publishToStocktwits && runtimeStocktwitsProxy) {
      if (!runtimeStocktwitsUsername || !runtimeStocktwitsPassword) {
        throw new BadRequestException(
          'When StockTwits Proxy is set, StockTwits Username and Password are required so StockTwits login and the browser use that account through this proxy only (not a .env-configured account or .env proxy).',
        );
      }
    }
    const normalizedStocktwitsItems = (input.stocktwitsItems ?? []).map(
      (row, index) => {
        const symbolRaw = (row?.symbol ?? '').trim();
        const bodyRaw = this.stripMandatoryDisclaimer(row?.body ?? '').trim();
        if (!symbolRaw || !bodyRaw) {
          throw new BadRequestException(
            `stocktwitsItems[${index}] requires both symbol and body`,
          );
        }

        const normalizedSymbol =
          this.normalizeStocktwitsTargetSymbol(symbolRaw);
        if (!normalizedSymbol) {
          throw new BadRequestException(
            `stocktwitsItems[${index}].symbol is invalid. Use a ticker like AAPL.`,
          );
        }

        return {
          symbol: normalizedSymbol,
          body: bodyRaw,
        };
      },
    );

    const stocktwitsSymbolRaw = (input.stocktwitsSymbol || '').trim();
    let normalizedStocktwitsSymbol: string | null = null;
    if (stocktwitsSymbolRaw) {
      normalizedStocktwitsSymbol =
        this.normalizeStocktwitsTargetSymbol(stocktwitsSymbolRaw);
      if (!normalizedStocktwitsSymbol) {
        throw new BadRequestException(
          'stocktwitsSymbol is invalid. Use a ticker like AAPL.',
        );
      }
    }

    if (publishToDiscord && !sanitizedBody) {
      throw new BadRequestException(
        'body is required when Discord publish is enabled',
      );
    }

    if (publishToStocktwits) {
      const maxMsgLen =
        this.configService.get<number>('STOCKTWITS_MAX_MESSAGE_LENGTH') ?? 140;
      if (normalizedStocktwitsItems.length > 0) {
        for (const item of normalizedStocktwitsItems) {
          this.stocktwitsComplianceService.enforceManualPublishCompliance({
            body: item.body,
            symbol: item.symbol,
            publishToStocktwits: true,
            maxMessageLength: maxMsgLen,
          });
        }
      } else {
        this.stocktwitsComplianceService.enforceManualPublishCompliance({
          body: sanitizedBody,
          symbol: normalizedStocktwitsSymbol,
          publishToStocktwits: true,
          maxMessageLength: maxMsgLen,
        });
      }
    }

    const manualPublishId = `manual-${Date.now()}-${randomInt(100000, 1_000_000)}`;

    const stocktwitsResult: {
      attempted: boolean;
      success: boolean;
      accountId: string | null;
      accountHandle: string | null;
      targetSymbol: string | null;
      targetSymbols: string[];
      totalCount: number;
      successCount: number;
      failedCount: number;
      manualCredentialsUsed: boolean;
      proxyOverrideUsed: boolean;
      externalPostId: string | null;
      evidenceUri: string | null;
      error: string | null;
      results: Array<{
        symbol: string;
        success: boolean;
        externalPostId: string | null;
        evidenceUri: string | null;
        error: string | null;
      }>;
    } = {
      attempted: publishToStocktwits,
      success: false,
      accountId: null,
      accountHandle: null,
      targetSymbol: normalizedStocktwitsSymbol,
      targetSymbols:
        normalizedStocktwitsItems.length > 0
          ? normalizedStocktwitsItems.map((item) => item.symbol)
          : normalizedStocktwitsSymbol
            ? [normalizedStocktwitsSymbol]
            : [],
      totalCount: 0,
      successCount: 0,
      failedCount: 0,
      manualCredentialsUsed: hasManualStocktwitsCredentials,
      proxyOverrideUsed: Boolean(runtimeStocktwitsProxy),
      externalPostId: null,
      evidenceUri: null,
      error: null,
      results: [],
    };

    const discordResult: {
      attempted: boolean;
      targetCount: number;
      successCount: number;
      skippedCount: number;
      failedCount: number;
      error: string | null;
      results: Array<{
        channelId: string;
        success: boolean;
        externalPostId: string | null;
        error: string | null;
      }>;
    } = {
      attempted: publishToDiscord,
      targetCount: 0,
      successCount: 0,
      skippedCount: 0,
      failedCount: 0,
      error: null,
      results: [],
    };

    await this.accountsService.syncAccountsFromConfig();

    if (publishToStocktwits) {
      {
      let selectedAccount: {
        id: string;
        accountHandle: string;
      } | null = null;
      try {
        const publisherOverrides = runtimeStocktwitsProxy
          ? { proxy: runtimeStocktwitsProxy }
          : undefined;

        // ── Resolve account ────────────────────────────────────────────────────
        // dlvr.it path: pick by handle from UI or auto-select eligible account.
        // Legacy path: use manual credentials if provided, otherwise auto-select.
        if (!useLegacyPoster) {
          const handle =
            (input.stocktwitsAccountHandle || '').trim() ||
            (await this.accountsService.getEligibleAccount(
              AccountPlatform.STOCKTWITS,
              { scheduledAt: new Date() },
            ).then((a) => a?.accountHandle ?? null));

          if (!handle) {
            throw new Error('stocktwits_no_eligible_account');
          }

          const dlvritProfile = await this.prisma.accountProfile.findUnique({
            where: {
              platform_accountHandle: {
                platform: AccountPlatform.STOCKTWITS,
                accountHandle: handle,
              },
            },
          });

          if (!dlvritProfile) {
            throw new Error(
              `stocktwits_account_not_found: "${handle}" not found in DB.`,
            );
          }

          selectedAccount = dlvritProfile;
          const dlvritAccountId = dlvritProfile.dlvritAccountId;
          if (!dlvritAccountId) {
            throw new Error(
              `dlvrit_account_not_configured: account "${handle}" has no ` +
                `dlvritAccountId. Set it via Manual UI → Account Management.`,
            );
          }

          const stocktwitsPublishId = `${manualPublishId}-stocktwits`;
          const items =
            normalizedStocktwitsItems.length > 0
              ? normalizedStocktwitsItems
              : normalizedStocktwitsSymbol
                ? [{ symbol: normalizedStocktwitsSymbol, body: sanitizedBody }]
                : [];

          if (items.length === 0) {
            throw new BadRequestException(
              'stocktwitsSymbol is required when publishing to StockTwits.',
            );
          }

          const rowResults: Array<{
            symbol: string;
            success: boolean;
            externalPostId: string | null;
            evidenceUri: string | null;
            error: string | null;
          }> = [];

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const message = this.buildStocktwitsSymbolMessage(
              item.body,
              item.symbol,
            );
            try {
              const result = await this.dlvritPublisher.postToAccount({
                dlvritAccountId,
                message,
                jobId: `${stocktwitsPublishId}-${item.symbol}-${i + 1}`,
              });
              rowResults.push({
                symbol: item.symbol,
                success: true,
                externalPostId: result.externalPostId,
                evidenceUri: result.evidenceUri,
                error: null,
              });
            } catch (err) {
              rowResults.push({
                symbol: item.symbol,
                success: false,
                externalPostId: null,
                evidenceUri: null,
                error: err instanceof Error ? err.message : 'unknown',
              });
            }
          }

          const successRows = rowResults.filter((r) => r.success);
          const failedRows = rowResults.filter((r) => !r.success);
          stocktwitsResult.results = rowResults;
          stocktwitsResult.totalCount = rowResults.length;
          stocktwitsResult.successCount = successRows.length;
          stocktwitsResult.failedCount = failedRows.length;
          stocktwitsResult.success =
            failedRows.length === 0 && successRows.length > 0;
          stocktwitsResult.accountId = selectedAccount.id;
          stocktwitsResult.accountHandle = selectedAccount.accountHandle;
          stocktwitsResult.targetSymbols = items.map((i) => i.symbol);
          stocktwitsResult.targetSymbol =
            items.length === 1 ? items[0].symbol : null;
          stocktwitsResult.externalPostId =
            successRows
              .map((r) => `${r.symbol}:${r.externalPostId ?? ''}`)
              .filter((t) => !t.endsWith(':'))
              .join(',') || null;
          stocktwitsResult.evidenceUri = successRows[0]?.evidenceUri ?? null;
          if (failedRows.length > 0) {
            stocktwitsResult.error = failedRows
              .map((r) => `${r.symbol}=${r.error ?? 'unknown'}`)
              .join('; ');
          }

          if (selectedAccount.id) {
            await this.recordAccountOutcomeSafe(selectedAccount.id, {
              success: stocktwitsResult.success,
              reason: stocktwitsResult.error ?? undefined,
              metadata: {
                mode: 'manual_dlvrit',
                platform: PublishPlatform.STOCKTWITS,
                targetRef: stocktwitsResult.targetSymbols.join(','),
              },
            });
          }
        } else {
        // ── Legacy Playwright path ─────────────────────────────────────────────
        const credentials = hasManualStocktwitsCredentials
          ? {
              username: runtimeStocktwitsUsername,
              password: runtimeStocktwitsPassword,
              handle: runtimeStocktwitsUsername,
            }
          : (() => {
              selectedAccount = null;
              return null;
            })();

        let resolvedCredentials = credentials;
        if (!resolvedCredentials) {
          selectedAccount = await this.accountsService.getEligibleAccount(
            AccountPlatform.STOCKTWITS,
            {
              scheduledAt: new Date(),
            },
          );
          if (!selectedAccount) {
            throw new Error('stocktwits_no_eligible_account');
          }
          const credentialsRaw = this.accountsService.getStocktwitsCredentials(
            selectedAccount.accountHandle,
          );
          if (!credentialsRaw) {
            throw new Error('stocktwits_credentials_missing');
          }
          resolvedCredentials = {
            ...credentialsRaw,
            handle: selectedAccount.accountHandle,
          };
        }

        const stocktwitsPublishId = `${manualPublishId}-stocktwits`;
        if (normalizedStocktwitsItems.length > 0) {
          const batchItems = normalizedStocktwitsItems.map((item, index) => ({
            symbol: item.symbol,
            message: this.buildStocktwitsSymbolMessage(item.body, item.symbol),
            jobId: `${stocktwitsPublishId}-${item.symbol}-${index + 1}`,
          }));

          const rowResults = await this.stocktwitsPublisher.publishBatchForManual(
            resolvedCredentials,
            batchItems,
            runtimeStocktwitsProxy || undefined,
          );

          const successRows = rowResults.filter((row) => row.success);
          const failedRows = rowResults.filter((row) => !row.success);
          stocktwitsResult.results = rowResults;
          stocktwitsResult.totalCount = rowResults.length;
          stocktwitsResult.successCount = successRows.length;
          stocktwitsResult.failedCount = failedRows.length;
          stocktwitsResult.success =
            failedRows.length === 0 && successRows.length > 0;
          stocktwitsResult.accountId = selectedAccount?.id ?? null;
          stocktwitsResult.accountHandle =
            selectedAccount?.accountHandle ??
            (hasManualStocktwitsCredentials ? runtimeStocktwitsUsername : null);
          stocktwitsResult.targetSymbol = null;
          stocktwitsResult.targetSymbols = normalizedStocktwitsItems.map(
            (item) => item.symbol,
          );
          stocktwitsResult.externalPostId =
            successRows
              .map((row) => `${row.symbol}:${row.externalPostId ?? ''}`)
              .filter((token) => !token.endsWith(':'))
              .join(',') || null;
          stocktwitsResult.evidenceUri =
            successRows[0]?.evidenceUri ?? rowResults[0]?.evidenceUri ?? null;
          if (failedRows.length > 0) {
            stocktwitsResult.error = failedRows
              .map((row) => `${row.symbol}=${row.error ?? 'unknown'}`)
              .join('; ');
          }

          if (selectedAccount?.id) {
            await this.recordAccountOutcomeSafe(selectedAccount.id, {
              success: stocktwitsResult.success,
              reason: stocktwitsResult.error ?? undefined,
              metadata: {
                mode: 'manual_multi_symbol',
                platform: PublishPlatform.STOCKTWITS,
                targetRef: stocktwitsResult.targetSymbols.join(','),
                totalCount: stocktwitsResult.totalCount,
                successCount: stocktwitsResult.successCount,
                failedCount: stocktwitsResult.failedCount,
              },
            });
          }
        } else {
          const stocktwitsMessage = this.buildStocktwitsSymbolMessage(
            sanitizedBody,
            normalizedStocktwitsSymbol,
          );
          const publishResult = await this.stocktwitsPublisher.publish(
            resolvedCredentials,
            stocktwitsMessage,
            stocktwitsPublishId,
            normalizedStocktwitsSymbol ?? undefined,
            publisherOverrides,
          );

          stocktwitsResult.success = true;
          stocktwitsResult.accountId = selectedAccount?.id ?? null;
          stocktwitsResult.accountHandle =
            selectedAccount?.accountHandle ??
            (hasManualStocktwitsCredentials ? runtimeStocktwitsUsername : null);
          stocktwitsResult.targetSymbol = normalizedStocktwitsSymbol;
          stocktwitsResult.targetSymbols = normalizedStocktwitsSymbol
            ? [normalizedStocktwitsSymbol]
            : [];
          stocktwitsResult.totalCount = 1;
          stocktwitsResult.successCount = 1;
          stocktwitsResult.failedCount = 0;
          stocktwitsResult.externalPostId = publishResult.externalPostId;
          stocktwitsResult.evidenceUri = publishResult.evidenceUri;
          stocktwitsResult.results = [
            {
              symbol: normalizedStocktwitsSymbol ?? '',
              success: true,
              externalPostId: publishResult.externalPostId,
              evidenceUri: publishResult.evidenceUri,
              error: null,
            },
          ];

          if (selectedAccount?.id) {
            await this.recordAccountOutcomeSafe(selectedAccount.id, {
              success: true,
              metadata: {
                mode: 'manual_direct',
                platform: PublishPlatform.STOCKTWITS,
                targetRef: normalizedStocktwitsSymbol ?? 'home',
              },
            });
          }
        }
        } // end legacy Playwright else block
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'stocktwits_publish_failed';
        stocktwitsResult.success = false;
        stocktwitsResult.accountId = selectedAccount?.id ?? null;
        stocktwitsResult.accountHandle = selectedAccount?.accountHandle ?? null;
        stocktwitsResult.error = message;

        if (selectedAccount?.id) {
          await this.recordAccountOutcomeSafe(selectedAccount.id, {
            success: false,
            reason: message,
            restricted: isRestrictionError(message),
            metadata: {
              mode: 'manual_direct',
              platform: PublishPlatform.STOCKTWITS,
              targetRef: normalizedStocktwitsSymbol ?? 'home',
            },
          });
        }
      }
      }
    }

    if (publishToDiscord) {
      const serverUrls: string[] = [];

      if (Array.isArray(input.discordServerUrls) && input.discordServerUrls.length > 0) {
        serverUrls.push(...input.discordServerUrls.map((u) => u.trim()).filter(Boolean));
      }

      if (serverUrls.length === 0) {
        const fallback =
          input.discordServerUrl?.trim() ||
          this.configService.get<string>('DISCORD_UI_SERVER_URL')?.trim() ||
          '';
        if (fallback) {
          serverUrls.push(fallback);
        }
      }

      if (serverUrls.length === 0) {
        discordResult.error =
          'discord_ui_server_url_missing (provide discordServerUrls)';
      } else {
        try {
          const multiResult =
            await this.discordUiPublisher.broadcastToMultipleServers({
              serverUrls,
              message: sanitizedBody,
              email: input.discordEmail,
              password: input.discordPassword,
            });

          discordResult.targetCount = multiResult.totalChannelCount;
          discordResult.successCount = multiResult.totalPostedCount;
          discordResult.skippedCount = multiResult.totalSkippedCount;
          discordResult.failedCount = multiResult.totalFailedCount;
          for (const server of multiResult.servers) {
            discordResult.results.push(
              ...server.channels.map((row) => ({
                channelId: row.channelId,
                success: row.posted,
                externalPostId: null,
                error: row.reason,
              })),
            );
            if (server.error && !discordResult.error) {
              discordResult.error = server.error;
            }
          }
        } catch (error) {
          discordResult.error =
            error instanceof Error
              ? error.message
              : 'discord_ui_publish_failed';
          discordResult.failedCount += 1;
        }
      }
    }

    const stocktwitsSucceeded =
      !publishToStocktwits || stocktwitsResult.success;
    const discordSucceeded =
      !publishToDiscord ||
      (discordResult.error === null &&
        discordResult.failedCount === 0 &&
        discordResult.successCount > 0);
    const success = stocktwitsSucceeded && discordSucceeded;

    this.telemetryService.increment(
      success
        ? 'pipeline.publish.manual.success'
        : 'pipeline.publish.manual.partial_or_failed',
    );

    await this.auditService.record(
      'publish.manual.direct',
      'manual_post',
      manualPublishId,
      {
        success,
        publishToStocktwits,
        publishToDiscord,
        discordMode: 'ui',
        stocktwits: {
          success: stocktwitsResult.success,
          accountHandle: stocktwitsResult.accountHandle,
          manualCredentialsUsed: stocktwitsResult.manualCredentialsUsed,
          proxyOverrideUsed: stocktwitsResult.proxyOverrideUsed,
          targetSymbol: stocktwitsResult.targetSymbol,
          targetSymbols: stocktwitsResult.targetSymbols,
          totalCount: stocktwitsResult.totalCount,
          successCount: stocktwitsResult.successCount,
          failedCount: stocktwitsResult.failedCount,
          externalPostId: stocktwitsResult.externalPostId,
          error: stocktwitsResult.error,
        },
        discord: {
          targetCount: discordResult.targetCount,
          successCount: discordResult.successCount,
          skippedCount: discordResult.skippedCount,
          failedCount: discordResult.failedCount,
          error: discordResult.error,
        },
      },
    );

    return {
      id: manualPublishId,
      body: sanitizedBody,
      success,
      stocktwits: stocktwitsResult,
      discord: discordResult,
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

  private async resolveStocktwitsTrendingSymbolsForCycle(): Promise<string[]> {
    const limit = PublishingService.STOCKTWITS_TOP_SYMBOL_LIMIT;
    const discoveryAccount = await this.accountsService.getEligibleAccount(
      AccountPlatform.STOCKTWITS,
      {
        scheduledAt: new Date(),
      },
    );

    if (!discoveryAccount) {
      this.logger.warn(
        'Skipping StockTwits trending discovery: no eligible account is currently available.',
      );
      await this.auditService.record(
        'stocktwits.trending.discovery_skipped',
        'stocktwits',
        'trending_all',
        {
          reason: 'no_eligible_account',
          requestedLimit: limit,
        },
      );
      return [];
    }

    const credentials = this.accountsService.getStocktwitsCredentials(
      discoveryAccount.accountHandle,
    );
    if (!credentials) {
      this.logger.warn(
        `Skipping StockTwits trending discovery: missing credentials for account ${discoveryAccount.accountHandle}.`,
      );
      await this.auditService.record(
        'stocktwits.trending.discovery_skipped',
        'stocktwits',
        'trending_all',
        {
          reason: 'credentials_missing',
          accountId: discoveryAccount.id,
          accountHandle: discoveryAccount.accountHandle,
          requestedLimit: limit,
        },
      );
      return [];
    }

    try {
      const symbols = await this.stocktwitsPublisher.discoverTopTrendingSymbols(
        {
          username: credentials.username,
          password: credentials.password,
        },
        limit,
      );

      if (symbols.length === 0) {
        this.logger.warn(
          'StockTwits trending discovery returned no symbols; skipping StockTwits scheduling for this cycle.',
        );
        await this.auditService.record(
          'stocktwits.trending.discovery_failed',
          'stocktwits',
          'trending_all',
          {
            reason: 'no_symbols_returned',
            accountId: discoveryAccount.id,
            accountHandle: discoveryAccount.accountHandle,
            requestedLimit: limit,
          },
        );
        return [];
      }

      if (symbols.length < limit) {
        this.logger.warn(
          `StockTwits trending discovery returned ${symbols.length}/${limit} symbols.`,
        );
      } else {
        this.logger.log(
          `StockTwits trending discovery returned ${symbols.length} symbols.`,
        );
      }

      await this.auditService.record(
        'stocktwits.trending.symbols.discovered',
        'stocktwits',
        'trending_all',
        {
          accountId: discoveryAccount.id,
          accountHandle: discoveryAccount.accountHandle,
          requestedLimit: limit,
          returnedCount: symbols.length,
          symbols,
        },
      );

      return symbols;
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'unknown_discovery_error';
      this.logger.error(
        `StockTwits trending discovery failed and StockTwits scheduling will be skipped for this cycle: ${reason}`,
      );
      await this.auditService.record(
        'stocktwits.trending.discovery_failed',
        'stocktwits',
        'trending_all',
        {
          reason,
          accountId: discoveryAccount.id,
          accountHandle: discoveryAccount.accountHandle,
          requestedLimit: limit,
        },
      );
      return [];
    }
  }

  private normalizeStocktwitsTargetSymbol(value: string): string | null {
    const normalized = value.trim().replace(/^\$/, '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.-]{0,10}$/.test(normalized)) {
      return null;
    }
    if (normalized.length > 6) {
      return null;
    }
    return normalized;
  }

  private buildStocktwitsSymbolMessage(
    body: string,
    symbol: string | null,
  ): string {
    const trimmedBody = body.trim();
    let message: string;

    if (!symbol) {
      message = trimmedBody;
    } else {
      const cashtag = `$${symbol}`;
      message = trimmedBody.toUpperCase().startsWith(cashtag.toUpperCase())
        ? trimmedBody
        : `${cashtag}\n\n${trimmedBody}`;
    }

    // Enforce Stocktwits character limit before the post reaches the browser.
    // The cashtag prefix added above counts toward the limit.
    const maxLength =
      this.configService.get<number>('STOCKTWITS_MAX_MESSAGE_LENGTH') ??
      140;
    return this.stocktwitsComplianceService.trimToLimit(message, maxLength);
  }

  private stripMandatoryDisclaimer(body: string): string {
    const disclaimer = MANDATORY_DISCLAIMER.trim().toLowerCase();
    const withoutDisclaimer = body
      .split(/\r?\n/)
      .filter((line) => line.trim().toLowerCase() !== disclaimer)
      .join('\n');

    return withoutDisclaimer.replace(/\n{3,}/g, '\n\n').trim();
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
        : job.platform === PublishPlatform.STOCKTWITS
          ? AccountPlatform.STOCKTWITS
          : null;
    if (!platform) {
      return false;
    }
    const fallback = await this.accountsService.getEligibleAccount(platform, {
      excludeAccountId: job.accountId,
      scheduledAt: new Date(
        Date.now() +
          this.configService.getOrThrow<number>(
            'PHASE2_ADAPTIVE_COOLDOWN_MINUTES',
          ) *
            60_000,
      ),
    });
    if (!fallback) {
      return false;
    }

    const rescheduleAt = new Date(
      Date.now() +
        this.configService.getOrThrow<number>(
          'PHASE2_ADAPTIVE_COOLDOWN_MINUTES',
        ) *
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

    await this.auditService.record(
      'publish.rerouted',
      'publish_job',
      publishJobId,
      {
        fromAccountId: job.accountId,
        toAccountId: fallback.id,
        reason: errorMessage,
        retryAt: rescheduleAt.toISOString(),
      },
    );
    return true;
  }

  private async moveToDeadLetterIfExhausted(input: {
    publishJobId: string;
    attempts: number;
    reason: string;
    metadata?: Prisma.JsonObject;
  }): Promise<void> {
    const deadLetterEnabled = this.configService.getOrThrow<boolean>(
      'PUBLISH_DEAD_LETTER_ENABLED',
    );
    if (!deadLetterEnabled) {
      return;
    }

    const maxRetries = this.configService.getOrThrow<number>(
      'PUBLISH_MAX_RETRIES',
    );
    if (input.attempts < maxRetries) {
      return;
    }

    const now = new Date();
    const existing = await this.prisma.publishDeadLetter.findUnique({
      where: { publishJobId: input.publishJobId },
      select: {
        metadata: true,
        firstFailedAt: true,
      },
    });

    await this.prisma.publishDeadLetter.upsert({
      where: { publishJobId: input.publishJobId },
      update: {
        status: DeadLetterStatus.OPEN,
        reason: input.reason,
        attempts: input.attempts,
        movedAt: now,
        replayedAt: null,
        metadata: this.mergeDeadLetterMetadata(
          existing?.metadata,
          input.metadata,
        ),
      },
      create: {
        publishJobId: input.publishJobId,
        status: DeadLetterStatus.OPEN,
        reason: input.reason,
        attempts: input.attempts,
        firstFailedAt: existing?.firstFailedAt ?? now,
        movedAt: now,
        metadata: input.metadata ?? {},
      },
    });

    this.telemetryService.increment('pipeline.publish.dead_lettered');
    await this.auditService.record(
      'publish.dead_lettered',
      'publish_job',
      input.publishJobId,
      {
        attempts: input.attempts,
        reason: input.reason,
      },
    );
  }

  private async markDeadLetterAsReplayedIfOpen(
    publishJobId: string,
    replaySource: 'retry' | 'rerun_now' | 'dlq_replay' | 'window_replay',
  ): Promise<void> {
    const existing = await this.prisma.publishDeadLetter.findUnique({
      where: { publishJobId },
      select: {
        id: true,
        status: true,
        metadata: true,
      },
    });
    if (!existing || existing.status !== DeadLetterStatus.OPEN) {
      return;
    }

    await this.prisma.publishDeadLetter.update({
      where: { publishJobId },
      data: {
        status: DeadLetterStatus.REPLAYED,
        replayedAt: new Date(),
        metadata: this.mergeDeadLetterMetadata(existing.metadata, {
          replaySource,
        }),
      },
    });
  }

  private mergeDeadLetterMetadata(
    existing: Prisma.JsonValue | null | undefined,
    patch: Prisma.JsonObject | undefined,
  ): Prisma.JsonObject {
    const base =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? existing
        : {};
    return {
      ...base,
      ...(patch ?? {}),
    };
  }

  private extractFailurePayload(error: unknown): Prisma.JsonObject | null {
    if (error instanceof AxiosError) {
      const status = error.response?.status ?? null;
      const data = error.response?.data;
      return {
        provider: 'http',
        status,
        data:
          data && typeof data === 'object'
            ? (data as Prisma.JsonObject)
            : data !== undefined
              ? { raw: String(data) }
              : null,
      };
    }

    if (error instanceof Error) {
      return {
        provider: 'runtime',
        message: error.message,
        name: error.name,
      };
    }

    return null;
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

  private async recordAccountOutcomeSafe(
    accountId: string,
    outcome: {
      success: boolean;
      reason?: string;
      restricted?: boolean;
      metadata?: Prisma.JsonObject;
    },
  ): Promise<void> {
    try {
      await this.accountsService.recordPublishOutcome(accountId, outcome);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'record_outcome_failed';
      this.logger.warn(
        `Failed to record account outcome for ${accountId}: ${message}`,
      );
    }
  }

  private async acquirePublishJobLock(lockKey: string): Promise<boolean> {
    const result = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext(${lockKey})::bigint) AS locked
    `;
    return result[0]?.locked === true;
  }

  private async releasePublishJobLock(lockKey: string): Promise<void> {
    await this.prisma.$queryRaw`
      SELECT pg_advisory_unlock(hashtext(${lockKey})::bigint)
    `;
  }

  // ── dlvr.it account management (delegated to AccountsService) ────────────────

  async listDlvritAccounts() {
    return this.accountsService.listDlvritAccounts();
  }

  async upsertDlvritAccount(accountHandle: string, dlvritAccountId: number) {
    return this.accountsService.upsertDlvritAccount(
      accountHandle,
      dlvritAccountId,
    );
  }

  async setDlvritAccountStatus(accountId: string, status: AccountStatus) {
    return this.accountsService.setDlvritAccountStatus(accountId, status);
  }

  async deleteDlvritAccounts(ids: string[]): Promise<number> {
    return this.accountsService.deleteStocktwitsAccounts(ids);
  }

  async listDlvritConnectedAccounts() {
    return this.dlvritPublisher.listConnectedAccounts();
  }

  async listDlvritConnectedAccountsRaw() {
    return this.dlvritPublisher.listConnectedAccountsRaw();
  }

  async refreshDlvritSession(): Promise<void> {
    await this.dlvritSessionService.refreshSession();
  }

}

function isRestrictionError(message: string): boolean {
  return /(ban|blocked|restricted|suspended|captcha|locked|challenge|rate_limited|muted)/i.test(
    message,
  );
}

function isReroutableFailure(message: string): boolean {
  // Only transient errors (network, timeout, 5xx, captcha) are reroutable.
  // Account restriction / mute errors must NEVER trigger a reroute — doing so
  // burns additional accounts on identical promotional content and signals
  // coordinated spam to StockTwits moderation.
  if (PostingPolicyService.isAccountRestrictionError(message)) return false;
  return /(timeout|429|5\d\d|captcha|challenge|blocked|network|rate_limited|stocktwits_posting_policy_backoff)/i.test(
    message,
  );
}

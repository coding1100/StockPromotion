import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { DraftStatus } from '@prisma/client';
import {
  PIPELINE_JOB_RUN,
  PIPELINE_QUEUE,
} from '../common/constants/queue.constants';
import { IngestionService } from '../ingestion/ingestion.service';
import { TrendsService } from '../trends/trends.service';
import { ContentService } from '../content/content.service';
import { PublishingService } from '../publishing/publishing.service';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OrchestrationService {
  private static readonly PIPELINE_LOCK_KEY = 900_410_037;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingestionService: IngestionService,
    private readonly trendsService: TrendsService,
    private readonly contentService: ContentService,
    private readonly publishingService: PublishingService,
    private readonly auditService: AuditService,
    private readonly telemetryService: TelemetryService,
    @InjectQueue(PIPELINE_QUEUE) private readonly pipelineQueue: Queue,
  ) {}

  async enqueuePipelineRun(trigger: 'manual' | 'scheduler'): Promise<void> {
    const now = Date.now();
    const schedulerBucket = Math.floor(now / 60_000);
    const jobId =
      trigger === 'scheduler'
        ? `scheduler-${schedulerBucket}`
        : `manual-${now}-${randomUUID()}`;

    try {
      await this.pipelineQueue.add(
        PIPELINE_JOB_RUN,
        { trigger },
        {
          jobId,
        },
      );
    } catch (error) {
      if (
        trigger === 'scheduler' &&
        error instanceof Error &&
        /jobId|already exists/i.test(error.message)
      ) {
        return;
      }
      throw error;
    }
  }

  async runPipeline(
    trigger: 'manual' | 'scheduler',
  ): Promise<Record<string, unknown>> {
    const lockAcquired = await this.acquirePipelineRunLock();
    if (!lockAcquired) {
      this.telemetryService.increment('pipeline.run.skipped_lock_contention');
      await this.auditService.record(
        'pipeline.run.blocked',
        'system',
        'pipeline',
        {
          reason: 'pipeline_lock_contention',
          trigger,
        },
      );
      throw new Error('Pipeline run already in progress');
    }

    try {
      const ingestion = await this.ingestionService.runIngestionCycle();
      if (ingestion.activeSources.length < 2) {
        await this.auditService.record(
          'pipeline.run.blocked',
          'system',
          'pipeline',
          {
            reason: 'minimum_active_sources_not_met',
            activeSources: ingestion.activeSources,
            connectors: ingestion.connectors,
          },
        );
        throw new Error(
          `Pipeline requires at least 2 active sources. Active: ${ingestion.activeSources.join(', ') || 'none'}`,
        );
      }

      const trends = await this.trendsService.computeTrends();
      const drafts = await this.contentService.generateDraftsForTrends(trends);
      const scheduledPublishes =
        await this.publishingService.scheduleDraftPublishes(
          drafts.autoApprovedDraftIds,
        );

      const summary = {
        trigger,
        ingestion,
        trendCount: trends.length,
        createdDrafts: drafts.createdDraftIds.length,
        autoApprovedDrafts: drafts.autoApprovedDraftIds.length,
        scheduledPublishes,
        timestamp: new Date().toISOString(),
      };

      this.telemetryService.increment('pipeline.run.success');
      await this.auditService.record(
        'pipeline.run.completed',
        'system',
        'pipeline',
        summary,
      );
      return summary;
    } finally {
      await this.releasePipelineRunLock();
    }
  }

  async listTrends(limit = 20): Promise<Record<string, unknown>[]> {
    const rows = await this.trendsService.listLatest(limit);
    return rows.map((row) => ({
      id: row.id,
      symbol: row.symbol,
      score: row.score,
      mentionCount: row.mentionCount,
      createdAt: row.createdAt,
    }));
  }

  async listDrafts(status?: DraftStatus): Promise<Record<string, unknown>[]> {
    return this.contentService.listDrafts(status);
  }

  async approveDraft(draftId: string): Promise<void> {
    await this.contentService.approveDraft(draftId);
    await this.publishingService.scheduleDraftPublishes([draftId]);
  }

  private async acquirePipelineRunLock(): Promise<boolean> {
    const result = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(${OrchestrationService.PIPELINE_LOCK_KEY}) AS locked
    `;
    return result[0]?.locked === true;
  }

  private async releasePipelineRunLock(): Promise<void> {
    await this.prisma.$queryRaw`
      SELECT pg_advisory_unlock(${OrchestrationService.PIPELINE_LOCK_KEY})
    `;
  }
}

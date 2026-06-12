import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  DeadLetterStatus,
  DraftStatus,
  PublishPlatform,
  PublishStatus,
} from '@prisma/client';
import { OrchestrationService } from './orchestration.service';
import { PublishingService } from '../publishing/publishing.service';
import { IngestionService } from '../ingestion/ingestion.service';
import { RetentionService } from '../retention/retention.service';

@Controller('orchestration')
@ApiTags('orchestration')
export class OrchestrationController {
  constructor(
    private readonly orchestrationService: OrchestrationService,
    private readonly publishingService: PublishingService,
    private readonly ingestionService: IngestionService,
    private readonly retentionService: RetentionService,
  ) {}

  @Post('run')
  async runPipeline(
    @Body() body: { mode?: 'sync' | 'async' } = { mode: 'async' },
  ): Promise<Record<string, unknown>> {
    if (body.mode === 'sync') {
      return this.orchestrationService.runPipeline('manual');
    }

    await this.orchestrationService.enqueuePipelineRun('manual');
    return { accepted: true };
  }

  @Get('trends')
  async listTrends(
    @Query('limit') limit?: string,
  ): Promise<Record<string, unknown>[]> {
    const parsedLimit = limit ? Number(limit) : 20;
    return this.orchestrationService.listTrends(
      Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 100))
        : 20,
    );
  }

  @Get('drafts')
  async listDrafts(
    @Query('status') status?: string,
  ): Promise<Record<string, unknown>[]> {
    const parsedStatus = this.parseDraftStatus(status);
    return this.orchestrationService.listDrafts(parsedStatus);
  }

  @Post('drafts/:id/approve')
  async approveDraft(
    @Param('id') draftId: string,
  ): Promise<{ approved: boolean }> {
    await this.orchestrationService.approveDraft(draftId);
    return { approved: true };
  }

  @Get('telegram/candidates')
  async listTelegramCandidates(): Promise<Record<string, unknown>[]> {
    return this.publishingService.listTelegramCandidates();
  }

  @Post('telegram/candidates/:id/approve')
  async approveTelegramCandidate(
    @Param('id') candidateId: string,
  ): Promise<{ approved: boolean }> {
    await this.publishingService.approveTelegramCandidate(candidateId);
    return { approved: true };
  }

  @Post('telegram/candidates/sync-join')
  async syncTelegramJoinState(): Promise<{ synced: boolean }> {
    await this.publishingService.attemptApprovedTelegramJoins();
    return { synced: true };
  }

  @Post('publish/manual')
  async publishManualPost(
    @Body()
    body: {
      body?: string;
      stocktwitsSymbol?: string;
      stocktwitsItems?: Array<{
        symbol?: string;
        body?: string;
      }>;
      publishToStocktwits?: boolean;
      publishToDiscord?: boolean;
      discordServerUrl?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.publishingService.publishManualPost({
      body: body.body ?? '',
      stocktwitsSymbol: body.stocktwitsSymbol,
      stocktwitsItems: body.stocktwitsItems,
      publishToStocktwits: body.publishToStocktwits,
      publishToDiscord: body.publishToDiscord,
      discordServerUrl: body.discordServerUrl,
    });
  }

  @Get('publish/jobs')
  async listPublishJobs(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<Record<string, unknown>[]> {
    const parsedLimit = limit ? Number(limit) : 100;
    const parsedStatus = this.parsePublishStatus(status);
    return this.publishingService.listPublishJobs(
      Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 500))
        : 100,
      parsedStatus,
    );
  }

  @Get('publish/jobs/:id')
  async getPublishJob(
    @Param('id') publishJobId: string,
  ): Promise<Record<string, unknown> | null> {
    return this.publishingService.getPublishJob(publishJobId);
  }

  @Get('publish/dlq')
  async listDeadLetterJobs(
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ): Promise<Record<string, unknown>[]> {
    const parsedLimit = limit ? Number(limit) : 100;
    const parsedStatus = this.parseDeadLetterStatus(status);
    return this.publishingService.listDeadLetterJobs(
      Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(parsedLimit, 500))
        : 100,
      parsedStatus,
    );
  }

  @Post('publish/dlq/:id/replay')
  async replayDeadLetter(
    @Param('id') deadLetterId: string,
  ): Promise<{ queued: boolean }> {
    await this.publishingService.replayDeadLetter(deadLetterId);
    return { queued: true };
  }

  @Post('publish/dlq/:id/dismiss')
  async dismissDeadLetter(
    @Param('id') deadLetterId: string,
    @Body() body: { note?: string },
  ): Promise<{ dismissed: boolean }> {
    await this.publishingService.dismissDeadLetter(deadLetterId, body.note);
    return { dismissed: true };
  }

  @Post('publish/replay-window')
  async replayFailedWindow(
    @Body()
    body: {
      fromIso: string;
      toIso: string;
      platform?: string;
    },
  ): Promise<Record<string, unknown>> {
    const platform = this.parsePublishPlatform(body.platform);
    return this.publishingService.replayFailedWindow({
      fromIso: body.fromIso,
      toIso: body.toIso,
      platform,
    });
  }

  @Get('dashboard/operations')
  async getOperationsDashboard(): Promise<Record<string, unknown>> {
    return this.publishingService.getOperationsDashboard();
  }

  @Get('connectors')
  async listConnectors(): Promise<Record<string, unknown>[]> {
    return this.ingestionService.listConnectorStates();
  }

  @Get('stocktwits/session')
  async getStocktwitsSessionStatus(): Promise<Record<string, unknown>> {
    return this.publishingService.getStocktwitsSessionStatus();
  }

  @Get('retention/policy')
  async getRetentionPolicy(): Promise<Record<string, unknown>> {
    return this.retentionService.getPolicy();
  }

  @Post('retention/run')
  async runRetentionNow(): Promise<Record<string, unknown>> {
    return this.retentionService.runRetentionNow('manual');
  }

  @Post('stocktwits/session/bootstrap')
  async bootstrapStocktwitsSession(): Promise<Record<string, unknown>> {
    return this.publishingService.bootstrapStocktwitsSession();
  }

  @Post('publish/jobs/:id/retry')
  async retryPublishJob(
    @Param('id') publishJobId: string,
  ): Promise<{ queued: boolean }> {
    await this.publishingService.retryPublishJob(publishJobId);
    return { queued: true };
  }

  @Post('publish/jobs/:id/dispatch-now')
  async dispatchPublishJobNow(
    @Param('id') publishJobId: string,
  ): Promise<{ queued: boolean }> {
    await this.publishingService.dispatchPublishJobNow(publishJobId);
    return { queued: true };
  }

  @Post('publish/jobs/:id/rerun-now')
  async rerunFailedPublishJobNow(
    @Param('id') publishJobId: string,
  ): Promise<{ queued: boolean }> {
    await this.publishingService.rerunFailedPublishJobNow(publishJobId);
    return { queued: true };
  }

  private parseDraftStatus(value?: string): DraftStatus | undefined {
    if (!value) {
      return undefined;
    }
    if ((Object.values(DraftStatus) as string[]).includes(value)) {
      return value as DraftStatus;
    }
    throw new BadRequestException(`Invalid draft status: ${value}`);
  }

  private parsePublishStatus(value?: string): PublishStatus | undefined {
    if (!value) {
      return undefined;
    }
    if ((Object.values(PublishStatus) as string[]).includes(value)) {
      return value as PublishStatus;
    }
    throw new BadRequestException(`Invalid publish status: ${value}`);
  }

  private parseDeadLetterStatus(value?: string): DeadLetterStatus | undefined {
    if (!value) {
      return undefined;
    }
    if ((Object.values(DeadLetterStatus) as string[]).includes(value)) {
      return value as DeadLetterStatus;
    }
    throw new BadRequestException(`Invalid dead-letter status: ${value}`);
  }

  private parsePublishPlatform(value?: string): PublishPlatform | undefined {
    if (!value) {
      return undefined;
    }
    if ((Object.values(PublishPlatform) as string[]).includes(value)) {
      return value as PublishPlatform;
    }
    throw new BadRequestException(`Invalid publish platform: ${value}`);
  }
}

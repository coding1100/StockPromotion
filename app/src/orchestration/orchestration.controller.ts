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
import { DraftStatus, PublishStatus } from '@prisma/client';
import { OrchestrationService } from './orchestration.service';
import { PublishingService } from '../publishing/publishing.service';

@Controller('orchestration')
@ApiTags('orchestration')
export class OrchestrationController {
  constructor(
    private readonly orchestrationService: OrchestrationService,
    private readonly publishingService: PublishingService,
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

  @Post('publish/jobs/:id/retry')
  async retryPublishJob(
    @Param('id') publishJobId: string,
  ): Promise<{ queued: boolean }> {
    await this.publishingService.retryPublishJob(publishJobId);
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
}

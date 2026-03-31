import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { OrchestrationService } from './orchestration.service';

@Injectable()
export class OrchestrationScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrchestrationScheduler.name);
  private job: CronJob | null = null;

  constructor(
    private readonly orchestrationService: OrchestrationService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit(): void {
    const cron = this.configService.getOrThrow<string>('PIPELINE_CRON');
    this.job = CronJob.from({
      cronTime: cron,
      onTick: () => {
        void this.onTick();
      },
      start: true,
    });
    this.logger.log(`Scheduler started with cron: ${cron}`);
  }

  onModuleDestroy(): void {
    void this.job?.stop();
  }

  private async onTick(): Promise<void> {
    try {
      await this.orchestrationService.enqueuePipelineRun('scheduler');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'scheduler_enqueue_failed';
      this.logger.error(`Failed to enqueue scheduled pipeline run: ${message}`);
    }
  }
}

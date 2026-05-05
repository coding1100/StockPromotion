import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  PUBLISH_JOB_EXECUTE,
  PUBLISH_QUEUE,
} from '../common/constants/queue.constants';
import { PublishingService } from './publishing.service';

@Processor(PUBLISH_QUEUE)
export class PublishProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishProcessor.name);

  constructor(private readonly publishingService: PublishingService) {
    super();
  }

  async process(job: Job<{ publishJobId: string }>): Promise<void> {
    if (job.name !== PUBLISH_JOB_EXECUTE) {
      return;
    }
    this.logger.log(`Processing queue job ${job.id} -> ${job.data.publishJobId}`);
    await this.publishingService.executePublishJob(job.data.publishJobId);
  }
}

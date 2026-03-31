import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  PUBLISH_JOB_EXECUTE,
  PUBLISH_QUEUE,
} from '../common/constants/queue.constants';
import { PublishingService } from './publishing.service';

@Processor(PUBLISH_QUEUE)
export class PublishProcessor extends WorkerHost {
  constructor(private readonly publishingService: PublishingService) {
    super();
  }

  async process(job: Job<{ publishJobId: string }>): Promise<void> {
    if (job.name !== PUBLISH_JOB_EXECUTE) {
      return;
    }

    await this.publishingService.executePublishJob(job.data.publishJobId);
  }
}

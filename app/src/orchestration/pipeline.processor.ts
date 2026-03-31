import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import {
  PIPELINE_JOB_RUN,
  PIPELINE_QUEUE,
} from '../common/constants/queue.constants';
import { OrchestrationService } from './orchestration.service';

@Processor(PIPELINE_QUEUE)
export class PipelineProcessor extends WorkerHost {
  constructor(private readonly orchestrationService: OrchestrationService) {
    super();
  }

  async process(
    job: Job<{ trigger: 'manual' | 'scheduler' }>,
  ): Promise<Record<string, unknown> | undefined> {
    if (job.name !== PIPELINE_JOB_RUN) {
      return undefined;
    }

    return this.orchestrationService.runPipeline(job.data.trigger);
  }
}

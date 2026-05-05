import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrchestrationService } from './orchestration.service';
import { OrchestrationController } from './orchestration.controller';
import { IngestionModule } from '../ingestion/ingestion.module';
import { TrendsModule } from '../trends/trends.module';
import { ContentModule } from '../content/content.module';
import { PublishingModule } from '../publishing/publishing.module';
import { AuditModule } from '../audit/audit.module';
import { PIPELINE_QUEUE } from '../common/constants/queue.constants';
import { PipelineProcessor } from './pipeline.processor';
import { OrchestrationScheduler } from './orchestration.scheduler';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { PrismaModule } from '../prisma/prisma.module';
import { RetentionModule } from '../retention/retention.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: PIPELINE_QUEUE,
    }),
    IngestionModule,
    TrendsModule,
    ContentModule,
    PublishingModule,
    AuditModule,
    TelemetryModule,
    PrismaModule,
    RetentionModule,
  ],
  providers: [OrchestrationService, PipelineProcessor, OrchestrationScheduler],
  controllers: [OrchestrationController],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}

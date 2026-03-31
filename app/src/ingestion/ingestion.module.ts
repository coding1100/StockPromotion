import { Module } from '@nestjs/common';
import { IngestionService } from './ingestion.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { TelemetryModule } from '../telemetry/telemetry.module';

@Module({
  imports: [PrismaModule, AuditModule, TelemetryModule],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}

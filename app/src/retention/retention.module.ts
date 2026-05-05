import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { TelemetryModule } from '../telemetry/telemetry.module';

@Module({
  imports: [PrismaModule, AuditModule, TelemetryModule],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}

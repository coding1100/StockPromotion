import { Module } from '@nestjs/common';
import { TrendsService } from './trends.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { TelemetryModule } from '../telemetry/telemetry.module';

@Module({
  imports: [PrismaModule, AuditModule, TelemetryModule],
  providers: [TrendsService],
  exports: [TrendsService],
})
export class TrendsModule {}

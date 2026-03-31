import { Module } from '@nestjs/common';
import { ContentService } from './content.service';
import { PrismaModule } from '../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { PolicyModule } from '../policy/policy.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, LlmModule, PolicyModule, AuditModule],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}

import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { AccountsController } from './accounts.controller';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [AccountsService],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class AccountsModule {}

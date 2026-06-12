import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PublishingService } from './publishing.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AccountsModule } from '../accounts/accounts.module';
import { AuditModule } from '../audit/audit.module';
import { PUBLISH_QUEUE } from '../common/constants/queue.constants';
import { TelegramPublisher } from './telegram.publisher';
import { StocktwitsPublisher } from './stocktwits.publisher';
import { DlvritPublisher } from './dlvrit.publisher';
import { DlvritSessionService } from './dlvrit-session.service';
import { PublishProcessor } from './publish.processor';
import { TelemetryModule } from '../telemetry/telemetry.module';
import { DiscordUiPublisher } from './discord-ui.publisher';
import { PolicyModule } from '../policy/policy.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: PUBLISH_QUEUE,
    }),
    PrismaModule,
    AccountsModule,
    AuditModule,
    TelemetryModule,
    PolicyModule,
  ],
  providers: [
    PublishingService,
    TelegramPublisher,
    StocktwitsPublisher,
    DlvritSessionService,
    DlvritPublisher,
    DiscordUiPublisher,
    PublishProcessor,
  ],
  exports: [PublishingService],
})
export class PublishingModule {}

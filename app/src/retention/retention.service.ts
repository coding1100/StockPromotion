import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { DeadLetterStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';

type RetentionTrigger = 'manual' | 'scheduler';

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionService.name);
  private job: CronJob | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly telemetryService: TelemetryService,
  ) {}

  onModuleInit(): void {
    const cron = this.configService.getOrThrow<string>('RETENTION_CRON');
    this.job = CronJob.from({
      cronTime: cron,
      onTick: () => {
        void this.runRetentionNow('scheduler');
      },
      start: true,
    });
    this.logger.log(`Retention scheduler started with cron: ${cron}`);
  }

  onModuleDestroy(): void {
    void this.job?.stop();
  }

  getPolicy(): Record<string, unknown> {
    return {
      enabled: this.configService.getOrThrow<boolean>('RETENTION_ENABLED'),
      cron: this.configService.getOrThrow<string>('RETENTION_CRON'),
      sourceEventsDays: this.configService.getOrThrow<number>(
        'RETENTION_SOURCE_EVENTS_DAYS',
      ),
      auditEventsDays: this.configService.getOrThrow<number>(
        'RETENTION_AUDIT_EVENTS_DAYS',
      ),
      publishAttemptsDays: this.configService.getOrThrow<number>(
        'RETENTION_PUBLISH_ATTEMPTS_DAYS',
      ),
      deadLetterDays:
        this.configService.getOrThrow<number>('RETENTION_DLQ_DAYS'),
    };
  }

  async runRetentionNow(
    trigger: RetentionTrigger = 'manual',
  ): Promise<Record<string, unknown>> {
    const enabled = this.configService.getOrThrow<boolean>('RETENTION_ENABLED');
    if (!enabled) {
      return {
        trigger,
        enabled,
        skipped: true,
        reason: 'retention_disabled',
        timestamp: new Date().toISOString(),
      };
    }

    const now = Date.now();
    const sourceCutoff = new Date(
      now -
        this.configService.getOrThrow<number>('RETENTION_SOURCE_EVENTS_DAYS') *
          24 *
          60 *
          60 *
          1000,
    );
    const auditCutoff = new Date(
      now -
        this.configService.getOrThrow<number>('RETENTION_AUDIT_EVENTS_DAYS') *
          24 *
          60 *
          60 *
          1000,
    );
    const attemptsCutoff = new Date(
      now -
        this.configService.getOrThrow<number>(
          'RETENTION_PUBLISH_ATTEMPTS_DAYS',
        ) *
          24 *
          60 *
          60 *
          1000,
    );
    const deadLetterCutoff = new Date(
      now -
        this.configService.getOrThrow<number>('RETENTION_DLQ_DAYS') *
          24 *
          60 *
          60 *
          1000,
    );

    const [sourceEvents, publishAttempts, auditEvents, deadLetters] =
      await this.prisma.$transaction([
        this.prisma.sourceEvent.deleteMany({
          where: {
            ingestedAt: {
              lt: sourceCutoff,
            },
          },
        }),
        this.prisma.publishAttempt.deleteMany({
          where: {
            attemptedAt: {
              lt: attemptsCutoff,
            },
          },
        }),
        this.prisma.auditEvent.deleteMany({
          where: {
            createdAt: {
              lt: auditCutoff,
            },
          },
        }),
        this.prisma.publishDeadLetter.deleteMany({
          where: {
            movedAt: {
              lt: deadLetterCutoff,
            },
            status: {
              in: [DeadLetterStatus.REPLAYED, DeadLetterStatus.DISMISSED],
            },
          },
        }),
      ]);

    const summary = {
      trigger,
      enabled,
      skipped: false,
      deleted: {
        sourceEvents: sourceEvents.count,
        publishAttempts: publishAttempts.count,
        auditEvents: auditEvents.count,
        deadLetters: deadLetters.count,
      },
      cutoffs: {
        sourceEvents: sourceCutoff.toISOString(),
        publishAttempts: attemptsCutoff.toISOString(),
        auditEvents: auditCutoff.toISOString(),
        deadLetters: deadLetterCutoff.toISOString(),
      },
      timestamp: new Date().toISOString(),
    };

    this.telemetryService.increment('retention.run.success');
    await this.auditService.record(
      'retention.run.completed',
      'system',
      'retention',
      summary,
    );

    return summary;
  }
}

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    eventType: string,
    entityType: string,
    entityId: string,
    metadata: Prisma.InputJsonValue,
    actorType = 'system',
    actorId?: string,
  ): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        eventType,
        actorType,
        actorId,
        entityType,
        entityId,
        metadata,
      },
    });
  }
}

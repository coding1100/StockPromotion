import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetClass, TrendTopic, TrendWindow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';

type WindowSpec = {
  type: TrendWindow;
  hours: number;
};

@Injectable()
export class TrendsService {
  private readonly windows: WindowSpec[] = [
    { type: TrendWindow.H1, hours: 1 },
    { type: TrendWindow.H6, hours: 6 },
    { type: TrendWindow.H24, hours: 24 },
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly telemetryService: TelemetryService,
  ) {}

  async computeTrends(): Promise<TrendTopic[]> {
    const now = new Date();
    const topLimit = this.configService.getOrThrow<number>('TOP_TRENDS_LIMIT');
    const connectorStates = await this.prisma.sourceConnectorState.findMany();
    const weightBySource = new Map(
      connectorStates.map((row) => [row.source, row.weight]),
    );

    const created: TrendTopic[] = [];
    for (const windowSpec of this.windows) {
      const rows = await this.computeWindowTrends(
        windowSpec,
        now,
        topLimit,
        weightBySource,
      );
      created.push(...rows);
    }

    this.telemetryService.increment('pipeline.trends.batches');
    this.telemetryService.increment('pipeline.trends.records', created.length);

    await this.auditService.record('trend.computed', 'system', 'trend_batch', {
      count: created.length,
      windows: this.windows.map((windowSpec) => windowSpec.type),
      symbols: created.map((item) => item.symbol),
    });

    return created;
  }

  async listLatest(limit = 20): Promise<TrendTopic[]> {
    return this.prisma.trendTopic.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  private async computeWindowTrends(
    windowSpec: WindowSpec,
    now: Date,
    topLimit: number,
    weightBySource: Map<string, number>,
  ): Promise<TrendTopic[]> {
    const windowStart = new Date(
      now.getTime() - windowSpec.hours * 60 * 60 * 1000,
    );

    const events = await this.prisma.sourceEvent.findMany({
      where: {
        occurredAt: { gte: windowStart, lte: now },
      },
      orderBy: {
        occurredAt: 'desc',
      },
    });

    const grouped = new Map<
      string,
      {
        mentions: number;
        engagementTotal: number;
        sentimentTotal: number;
        sentimentCount: number;
        evidenceIds: string[];
      }
    >();

    for (const event of events) {
      const sourceWeight = weightBySource.get(event.source) ?? 1;
      for (const symbol of event.symbols) {
        const current = grouped.get(symbol) ?? {
          mentions: 0,
          engagementTotal: 0,
          sentimentTotal: 0,
          sentimentCount: 0,
          evidenceIds: [],
        };
        current.mentions += sourceWeight;
        current.engagementTotal += (event.engagementScore ?? 0) * sourceWeight;
        if (event.sentimentScore !== null) {
          current.sentimentTotal += event.sentimentScore * sourceWeight;
          current.sentimentCount += sourceWeight;
        }
        current.evidenceIds.push(event.id);
        grouped.set(symbol, current);
      }
    }

    const scored = Array.from(grouped.entries())
      .map(([symbol, value]) => {
        const averageSentiment =
          value.sentimentCount > 0
            ? value.sentimentTotal / value.sentimentCount
            : null;
        const score =
          value.mentions +
          value.engagementTotal * 0.05 +
          (averageSentiment ? averageSentiment * 2 : 0);

        return {
          symbol,
          mentions: Math.round(value.mentions),
          averageSentiment,
          score,
          evidenceIds: value.evidenceIds.slice(0, 20),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topLimit);

    if (scored.length === 0) {
      return [];
    }

    const created: TrendTopic[] = [];
    for (const trend of scored) {
      const row = await this.prisma.trendTopic.create({
        data: {
          symbol: trend.symbol,
          assetClass: this.classifyAsset(trend.symbol),
          windowType: windowSpec.type,
          score: trend.score,
          mentionCount: trend.mentions,
          averageSentiment: trend.averageSentiment,
          windowStart,
          windowEnd: now,
          evidence: {
            eventIds: trend.evidenceIds,
          },
        },
      });
      created.push(row);
    }
    return created;
  }

  private classifyAsset(symbol: string): AssetClass {
    const crypto = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE']);
    return crypto.has(symbol) ? AssetClass.CRYPTO : AssetClass.EQUITY;
  }
}

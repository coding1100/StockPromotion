import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssetClass,
  SourceEvent,
  TrendTopic,
  TrendWindow,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { parseTrendWindowHours } from '../common/utils/trend-window.util';

type WindowSpec = {
  type: TrendWindow;
  hours: number;
};

@Injectable()
export class TrendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly telemetryService: TelemetryService,
  ) {}

  async computeTrends(): Promise<TrendTopic[]> {
    const now = new Date();
    const windows = this.resolveWindows();
    const topLimit = this.configService.getOrThrow<number>('TOP_TRENDS_LIMIT');
    const minWeightedMentions = this.configService.getOrThrow<number>(
      'TREND_MIN_WEIGHTED_MENTIONS',
    );
    const minUniqueEvents = this.configService.getOrThrow<number>(
      'TREND_MIN_UNIQUE_EVENTS',
    );
    const minScore = this.configService.getOrThrow<number>('TREND_MIN_SCORE');
    const connectorStates = await this.prisma.sourceConnectorState.findMany();
    const weightBySource = new Map(
      connectorStates.map((row) => [row.source, row.weight]),
    );
    const maxWindowHours = Math.max(...windows.map((window) => window.hours));
    const maxWindowStart = new Date(
      now.getTime() - maxWindowHours * 60 * 60 * 1000,
    );
    const recentEvents = await this.prisma.sourceEvent.findMany({
      where: {
        occurredAt: { gte: maxWindowStart, lte: now },
      },
      orderBy: {
        occurredAt: 'desc',
      },
    });

    const created: TrendTopic[] = [];
    for (const windowSpec of windows) {
      const rows = await this.computeWindowTrends(
        windowSpec,
        now,
        topLimit,
        weightBySource,
        recentEvents,
        minWeightedMentions,
        minUniqueEvents,
        minScore,
      );
      created.push(...rows);
    }

    this.telemetryService.increment('pipeline.trends.batches');
    this.telemetryService.increment('pipeline.trends.records', created.length);

    await this.auditService.record('trend.computed', 'system', 'trend_batch', {
      count: created.length,
      windows: windows.map((windowSpec) => windowSpec.type),
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
    events: SourceEvent[],
    minWeightedMentions: number,
    minUniqueEvents: number,
    minScore: number,
  ): Promise<TrendTopic[]> {
    const windowStart = new Date(
      now.getTime() - windowSpec.hours * 60 * 60 * 1000,
    );

    const grouped = new Map<
      string,
      {
        weightedMentions: number;
        engagementTotal: number;
        sentimentTotal: number;
        sentimentCount: number;
        evidenceIds: Set<string>;
        sources: Set<string>;
      }
    >();

    for (const event of events) {
      if (event.occurredAt < windowStart || event.occurredAt > now) {
        continue;
      }

      const sourceWeight = weightBySource.get(event.source) ?? 1;
      for (const symbol of event.symbols) {
        const current = grouped.get(symbol) ?? {
          weightedMentions: 0,
          engagementTotal: 0,
          sentimentTotal: 0,
          sentimentCount: 0,
          evidenceIds: new Set<string>(),
          sources: new Set<string>(),
        };
        current.weightedMentions += sourceWeight;
        current.engagementTotal += (event.engagementScore ?? 0) * sourceWeight;
        if (event.sentimentScore !== null) {
          current.sentimentTotal += event.sentimentScore * sourceWeight;
          current.sentimentCount += sourceWeight;
        }
        current.evidenceIds.add(event.id);
        current.sources.add(event.source);
        grouped.set(symbol, current);
      }
    }

    const scored = Array.from(grouped.entries())
      .map(([symbol, value]) => {
        const averageSentiment =
          value.sentimentCount > 0
            ? value.sentimentTotal / value.sentimentCount
            : null;
        const uniqueEventCount = value.evidenceIds.size;
        const sourceDiversity = value.sources.size;
        const normalizedEngagement = Math.log10(1 + value.engagementTotal);
        const score =
          value.weightedMentions * 1.5 +
          uniqueEventCount * 1.2 +
          sourceDiversity * 0.8 +
          normalizedEngagement +
          (averageSentiment ?? 0) * 2;

        return {
          symbol,
          mentions: Math.max(1, Math.round(value.weightedMentions)),
          weightedMentions: value.weightedMentions,
          uniqueEventCount,
          averageSentiment,
          score,
          evidenceIds: Array.from(value.evidenceIds).slice(0, 20),
        };
      })
      .filter((trend) => {
        return (
          trend.weightedMentions >= minWeightedMentions &&
          trend.uniqueEventCount >= minUniqueEvents &&
          trend.score >= minScore
        );
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

  private resolveWindows(): WindowSpec[] {
    const hours = parseTrendWindowHours(
      this.configService.get<string>('TREND_WINDOWS_HOURS'),
    );
    return hours.map((value) => ({
      type: value === 1 ? TrendWindow.H1 : value === 6 ? TrendWindow.H6 : TrendWindow.H24,
      hours: value,
    }));
  }
}

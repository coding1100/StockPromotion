import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig } from 'axios';
import { Prisma, SourceType } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { extractSymbols } from '../common/utils/symbol.util';
import {
  parseTrendWindowHours,
  toRedditTimeRange,
} from '../common/utils/trend-window.util';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { executeWithRetry } from '../common/utils/http.util';

type ConnectorName = 'reddit' | 'stocktwitsSignal' | 'news';

type ConnectorResult = {
  configured: boolean;
  healthy: boolean;
  fresh: boolean;
  ingested: number;
  error: string | null;
  weight: number;
  priority: number;
  mockMode: boolean;
};

export type IngestionSummary = {
  reddit: number;
  stocktwitsSignal: number;
  news: number;
  connectors: Record<ConnectorName, ConnectorResult>;
  activeSources: ConnectorName[];
};

type RedditRapidApiConfig = {
  key: string;
  host: string;
  baseUrl: string;
  pathTemplate: string;
  method: 'GET' | 'POST';
  limitParam: string;
  timeParam: string;
  timeValue: string;
  syncTrendWindow: boolean;
  itemsPath: string;
  itemDataPath: string;
};

type EventCandidate = {
  source: SourceType;
  sourceUrl: string;
  title: string;
  body: string;
  author: string;
  createdRaw: unknown;
  explicitExternalId?: unknown;
};

@Injectable()
export class IngestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly telemetryService: TelemetryService,
  ) {}

  async runIngestionCycle(): Promise<IngestionSummary> {
    const redditConfigured = this.isRedditConfigured();
    const stocktwitsConfigured = this.isStocktwitsSignalConfigured();
    const newsConfigured = this.isNewsConfigured();

    const [reddit, stocktwitsSignal, news] = await Promise.all([
      this.runConnector('reddit', SourceType.REDDIT, redditConfigured, () =>
        this.ingestReddit(),
      ),
      this.runConnector(
        'stocktwitsSignal',
        SourceType.STOCKTWITS_SIGNAL,
        stocktwitsConfigured,
        () => this.ingestStocktwitsSignals(),
      ),
      this.runConnector('news', SourceType.NEWS_API, newsConfigured, () =>
        this.ingestNewsSentiment(),
      ),
    ]);

    const activeSources = Object.entries({
      reddit,
      stocktwitsSignal,
      news,
    })
      .filter(
        ([, value]) => value.configured && value.healthy && value.fresh,
      )
      .sort(([, left], [, right]) => right.priority - left.priority)
      .map(([key]) => key as ConnectorName);

    const summary: IngestionSummary = {
      reddit: reddit.ingested,
      stocktwitsSignal: stocktwitsSignal.ingested,
      news: news.ingested,
      connectors: {
        reddit,
        stocktwitsSignal,
        news,
      },
      activeSources,
    };

    this.telemetryService.increment('pipeline.ingestion.cycles');
    this.telemetryService.increment(
      'pipeline.ingestion.records',
      reddit.ingested,
    );
    this.telemetryService.increment(
      'pipeline.ingestion.records',
      stocktwitsSignal.ingested,
    );
    this.telemetryService.increment('pipeline.ingestion.records', news.ingested);

    await this.auditService.record(
      'ingestion.completed',
      'system',
      'pipeline',
      summary as Prisma.InputJsonValue,
    );

    return summary;
  }

  async listConnectorStates() {
    return this.prisma.sourceConnectorState.findMany({
      orderBy: [{ priority: 'desc' }, { source: 'asc' }],
    });
  }

  private get requestTimeoutMs(): number {
    return this.configService.getOrThrow<number>('HTTP_REQUEST_TIMEOUT_MS');
  }

  private get maxRetries(): number {
    return this.configService.getOrThrow<number>('HTTP_MAX_RETRIES');
  }

  private async runConnector(
    name: ConnectorName,
    source: SourceType,
    configured: boolean,
    fn: () => Promise<number>,
  ): Promise<ConnectorResult> {
    const { weight, priority } = this.getConnectorPolicy(source);
    const mockMode = this.shouldUseMockData();

    if (!configured) {
      await this.persistConnectorState(source, {
        configured: false,
        healthy: false,
        fresh: false,
        ingested: 0,
        weight,
        priority,
        error: 'connector_not_configured',
        mockMode,
      });
      return {
        configured: false,
        healthy: false,
        fresh: false,
        ingested: 0,
        error: 'connector_not_configured',
        weight,
        priority,
        mockMode,
      };
    }

    try {
      const ingested = await fn();
      // A healthy connector can legitimately ingest 0 new rows when upstream
      // data is unchanged and createMany(skipDuplicates) filters everything.
      // Treat healthy executions as fresh to avoid false source degradation.
      const fresh = true;
      this.telemetryService.increment(`connector.${name}.success`);
      await this.persistConnectorState(source, {
        configured: true,
        healthy: true,
        fresh,
        ingested,
        weight,
        priority,
        error: null,
        mockMode,
      });
      return {
        configured: true,
        healthy: true,
        fresh,
        ingested,
        error: null,
        weight,
        priority,
        mockMode,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'connector_execution_failed';
      this.telemetryService.increment(`connector.${name}.failed`);
      await this.persistConnectorState(source, {
        configured: true,
        healthy: false,
        fresh: false,
        ingested: 0,
        weight,
        priority,
        error: message,
        mockMode,
      });
      await this.auditService.record(
        'ingestion.connector.failed',
        'source_connector',
        name,
        {
          message,
        },
      );
      return {
        configured: true,
        healthy: false,
        fresh: false,
        ingested: 0,
        error: message,
        weight,
        priority,
        mockMode,
      };
    }
  }

  private isRedditConfigured(): boolean {
    if (this.shouldUseMockData()) {
      return true;
    }

    const rapidApiKey =
      this.configService.get<string>('REDDIT_RAPIDAPI_KEY') || '';
    const rapidApiHost =
      this.configService.get<string>('REDDIT_RAPIDAPI_HOST') || '';
    const rapidApiBaseUrl =
      this.configService.get<string>('REDDIT_RAPIDAPI_BASE_URL') || '';
    const rapidApiPathTemplate =
      this.configService.get<string>('REDDIT_RAPIDAPI_PATH_TEMPLATE') || '';
    const subreddits = this.configService
      .getOrThrow<string>('REDDIT_SUBREDDITS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return Boolean(
      rapidApiKey &&
        rapidApiHost &&
        rapidApiBaseUrl &&
        rapidApiPathTemplate &&
        subreddits.length > 0,
    );
  }

  private isStocktwitsSignalConfigured(): boolean {
    if (this.shouldUseMockData()) {
      return true;
    }
    return Boolean(this.configService.get<string>('STOCKTWITS_SIGNAL_API_URL'));
  }

  private isNewsConfigured(): boolean {
    if (this.shouldUseMockData()) {
      return true;
    }
    return Boolean(this.configService.get<string>('NEWS_SENTIMENT_API_URL'));
  }

  private async ingestReddit(): Promise<number> {
    if (this.shouldUseMockData()) {
      return this.ingestMockReddit();
    }

    const rapidConfig = this.getRedditRapidApiConfig();
    const subreddits = this.configService
      .getOrThrow<string>('REDDIT_SUBREDDITS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const fetchLimit =
      this.configService.getOrThrow<number>('REDDIT_FETCH_LIMIT');
    const timeRange = this.resolveRedditTimeRange(rapidConfig);
    let ingested = 0;

    for (const subreddit of subreddits) {
      const requestUrl = this.buildRapidApiUrl(
        rapidConfig.baseUrl,
        rapidConfig.pathTemplate,
        subreddit,
        rapidConfig.timeParam,
        timeRange,
      );
      const request: AxiosRequestConfig = {
        method: rapidConfig.method,
        url: requestUrl,
        params: { [rapidConfig.limitParam]: fetchLimit },
        headers: {
          'X-RapidAPI-Key': rapidConfig.key,
          'X-RapidAPI-Host': rapidConfig.host,
        },
      };

      const response = await executeWithRetry(
        () =>
          axios.request<Record<string, unknown>>({
            ...request,
            timeout: this.requestTimeoutMs,
          }),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: 200,
          maxDelayMs: 2000,
        },
      );

      const payloadRows = this.extractRapidApiItems(
        response.data,
        rapidConfig.itemsPath,
        rapidConfig.itemDataPath,
      );
      const rows = payloadRows.map((item) => this.mapRedditEvent(item, false));

      if (rows.length === 0) {
        continue;
      }

      const result = await this.prisma.sourceEvent.createMany({
        data: rows,
        skipDuplicates: true,
      });
      ingested += result.count;
    }

    return ingested;
  }

  private async ingestMockReddit(): Promise<number> {
    const payload = this.parseMockRows('REDDIT_MOCK_DATA_JSON');
    if (payload.length === 0) {
      return 0;
    }

    const rows = payload.map((item, index) =>
      this.mapRedditEvent(
        {
          id:
            this.asString(item.id) ||
            `mock-reddit-${String(index + 1).padStart(2, '0')}`,
          title: this.asString(item.title),
          selftext: this.asString(item.body),
          permalink:
            this.asString(item.permalink) || `/r/mock/comments/${index + 1}`,
          score: this.asNumber(item.score) || 1,
          author: this.asString(item.author) || 'mock-user',
          created_utc: this.asDate(item.createdAt).getTime() / 1000,
          mock: true,
        },
        true,
      ),
    );

    const result = await this.prisma.sourceEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return result.count;
  }

  private mapRedditEvent(
    payload: Record<string, unknown>,
    mockMode: boolean,
  ): Prisma.SourceEventCreateManyInput {
    const title = this.asString(payload.title);
    const body =
      this.asString(payload.selftext) ||
      this.asString(payload.body) ||
      this.asString(payload.text);
    const combined = `${title}\n${body}`.trim();
    const permalink = this.asString(payload.permalink);
    const directUrl = this.asString(payload.url);
    const sourceUrl = permalink
      ? permalink.startsWith('http')
        ? permalink
        : `https://reddit.com${permalink}`
      : directUrl;
    const author =
      this.asString(payload.author) ||
      this.asString(payload.username) ||
      this.asString(payload.user);
    const createdRaw = payload.created_utc ?? payload.createdAt ?? payload.created;
    const occurredAt = this.asDate(createdRaw);

    return {
      source: SourceType.REDDIT,
      externalId: this.resolveExternalId({
        source: SourceType.REDDIT,
        sourceUrl,
        title,
        body: combined,
        author,
        createdRaw,
        explicitExternalId:
          this.asString(payload.id) ||
          this.asString(payload.post_id) ||
          this.asString(payload.fullname),
      }),
      sourceUrl,
      title,
      body: combined.slice(0, 6000),
      symbols: extractSymbols(combined, {
        allowedSymbols: this.watchlistSymbols,
      }),
      sentimentScore: null,
      engagementScore:
        this.asNumber(payload.score) ||
        this.asNumber(payload.ups) ||
        this.asNumber(payload.upvotes),
      author,
      rawPayload: {
        ...(payload as Prisma.JsonObject),
        mockMode,
      },
      occurredAt,
    };
  }

  private async ingestStocktwitsSignals(): Promise<number> {
    if (this.shouldUseMockData()) {
      return this.ingestMockStocktwitsSignals();
    }

    const apiUrl = this.configService.getOrThrow<string>(
      'STOCKTWITS_SIGNAL_API_URL',
    );
    const symbols = this.configService
      .getOrThrow<string>('WATCHLIST_SYMBOLS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    let ingested = 0;
    for (const symbol of symbols) {
      const requestUrl = this.resolveStocktwitsSignalUrl(apiUrl, symbol);
      const response = await executeWithRetry(
        () =>
          axios.get<{
            messages?: Array<Record<string, unknown>>;
          }>(requestUrl, {
            timeout: this.requestTimeoutMs,
          }),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: 200,
          maxDelayMs: 2000,
        },
      );
      const messages = response.data.messages ?? [];

      const rows = messages.slice(0, 20).map((message) => {
        const body = this.asString(message.body);
        const joinedSymbols = [
          symbol,
          ...extractSymbols(body, {
            allowedSymbols: this.watchlistSymbols,
          }).filter((value) => value !== symbol),
        ];
        const sourceUrl = this.asString(message.url);
        const author = this.asString(
          (message.user as { username?: unknown })?.username,
        );
        const createdRaw = message.created_at;
        const occurredAt = this.asDate(createdRaw);

        return {
          source: SourceType.STOCKTWITS_SIGNAL,
          externalId: this.resolveExternalId({
            source: SourceType.STOCKTWITS_SIGNAL,
            sourceUrl,
            title: '',
            body,
            author,
            createdRaw,
            explicitExternalId: this.asString(message.id),
          }),
          sourceUrl,
          title: null,
          body: body.slice(0, 6000),
          symbols: joinedSymbols,
          sentimentScore: null,
          engagementScore: this.asNumber(message.likes),
          author,
          rawPayload: message as Prisma.JsonObject,
          occurredAt,
        };
      });

      if (rows.length > 0) {
        const result = await this.prisma.sourceEvent.createMany({
          data: rows,
          skipDuplicates: true,
        });
        ingested += result.count;
      }
    }

    return ingested;
  }

  private async ingestMockStocktwitsSignals(): Promise<number> {
    const payload = this.parseMockRows('STOCKTWITS_SIGNAL_MOCK_DATA_JSON');
    if (payload.length === 0) {
      return 0;
    }

    const rows = payload.map((item, index) => {
      const body = this.asString(item.body);
      const primarySymbol =
        extractSymbols(this.asString(item.symbol) || body, {
          allowedSymbols: this.watchlistSymbols,
        })[0] || 'AAPL';
      const symbols = [
        primarySymbol,
        ...extractSymbols(body, {
          allowedSymbols: this.watchlistSymbols,
        }).filter((value) => value !== primarySymbol),
      ];
      const sourceUrl =
        this.asString(item.url) || `https://stocktwits.com/symbol/${primarySymbol}`;
      const author = this.asString(item.author) || 'mock-stocktwits-user';
      const createdRaw = item.createdAt;
      const occurredAt = this.asDate(createdRaw);

      return {
        source: SourceType.STOCKTWITS_SIGNAL,
        externalId: this.resolveExternalId({
          source: SourceType.STOCKTWITS_SIGNAL,
          sourceUrl,
          title: '',
          body,
          author,
          createdRaw,
          explicitExternalId: this.asString(item.id),
        }),
        sourceUrl,
        title: null,
        body: body.slice(0, 6000),
        symbols,
        sentimentScore: this.asNumber(item.sentiment) || null,
        engagementScore: this.asNumber(item.likes),
        author,
        rawPayload: {
          ...(item as Prisma.JsonObject),
          mockMode: true,
        },
        occurredAt,
      };
    });

    const result = await this.prisma.sourceEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return result.count;
  }

  private resolveStocktwitsSignalUrl(template: string, symbol: string): string {
    if (template.includes('{symbol}')) {
      return template.replaceAll('{symbol}', encodeURIComponent(symbol));
    }

    if (/%7Bsymbol%7D/i.test(template)) {
      return template.replace(/%7Bsymbol%7D/gi, encodeURIComponent(symbol));
    }

    const url = new URL(template);
    url.searchParams.set('symbol', symbol);
    return url.toString();
  }

  private async ingestNewsSentiment(): Promise<number> {
    if (this.shouldUseMockData()) {
      return this.ingestMockNewsSentiment();
    }

    const url = this.configService.getOrThrow<string>('NEWS_SENTIMENT_API_URL');
    const apiKey =
      this.configService.get<string>('NEWS_SENTIMENT_API_KEY') || '';
    const response = await executeWithRetry(
      () =>
        axios.get<{
          data?: Array<Record<string, unknown>>;
          items?: Array<Record<string, unknown>>;
        }>(url, {
          headers: apiKey ? { 'X-API-Key': apiKey } : undefined,
          timeout: this.requestTimeoutMs,
        }),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 2000,
      },
    );

    const payload = response.data.data ?? response.data.items ?? [];
    const rows = payload.slice(0, 50).map((item) => {
      const title = this.asString(item.title) || this.asString(item.headline);
      const body =
        this.asString(item.summary) || this.asString(item.description) || title;
      const sourceUrl = this.asString(item.url);
      const author = this.asString(item.source);
      const createdRaw = item.publishedAt ?? item.time;
      const occurredAt = this.asDate(createdRaw);

      return {
        source: SourceType.NEWS_API,
        externalId: this.resolveExternalId({
          source: SourceType.NEWS_API,
          sourceUrl,
          title,
          body,
          author,
          createdRaw,
          explicitExternalId: this.asString(item.id),
        }),
        sourceUrl,
        title: title.slice(0, 512),
        body: body.slice(0, 6000),
        symbols: extractSymbols(`${title}\n${body}`, {
          allowedSymbols: this.watchlistSymbols,
        }),
        sentimentScore: this.asNumber(item.sentiment),
        engagementScore: this.asNumber(item.rank),
        author,
        rawPayload: item as Prisma.JsonObject,
        occurredAt,
      };
    });

    if (rows.length === 0) {
      return 0;
    }

    const result = await this.prisma.sourceEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return result.count;
  }

  private async ingestMockNewsSentiment(): Promise<number> {
    const payload = this.parseMockRows('NEWS_MOCK_DATA_JSON');
    if (payload.length === 0) {
      return 0;
    }

    const rows = payload.map((item, index) => {
      const title = this.asString(item.title) || `Mock market update ${index + 1}`;
      const body =
        this.asString(item.summary) ||
        this.asString(item.description) ||
        this.asString(item.body) ||
        title;
      const sourceUrl =
        this.asString(item.url) || `https://example.test/mock-news/${index + 1}`;
      const author = this.asString(item.source) || 'mock-news';
      const createdRaw = item.publishedAt ?? item.time ?? item.createdAt;
      const occurredAt = this.asDate(createdRaw);

      return {
        source: SourceType.NEWS_API,
        externalId: this.resolveExternalId({
          source: SourceType.NEWS_API,
          sourceUrl,
          title,
          body,
          author,
          createdRaw,
          explicitExternalId: this.asString(item.id),
        }),
        sourceUrl,
        title: title.slice(0, 512),
        body: body.slice(0, 6000),
        symbols: extractSymbols(`${title}\n${body}`, {
          allowedSymbols: this.watchlistSymbols,
        }),
        sentimentScore: this.asNumber(item.sentiment),
        engagementScore: this.asNumber(item.rank),
        author,
        rawPayload: {
          ...(item as Prisma.JsonObject),
          mockMode: true,
        },
        occurredAt,
      };
    });

    const result = await this.prisma.sourceEvent.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return result.count;
  }

  private async persistConnectorState(
    source: SourceType,
    input: {
      configured: boolean;
      healthy: boolean;
      fresh: boolean;
      ingested: number;
      weight: number;
      priority: number;
      error: string | null;
      mockMode: boolean;
    },
  ): Promise<void> {
    await this.prisma.sourceConnectorState.upsert({
      where: {
        source,
      },
      update: {
        configured: input.configured,
        healthy: input.healthy,
        weight: input.weight,
        priority: input.priority,
        lastSuccessAt: input.healthy ? new Date() : undefined,
        lastFailureAt: input.healthy ? undefined : new Date(),
        lastError: input.error,
        consecutiveFailures: input.healthy
          ? 0
          : {
              increment: 1,
            },
        metadata: {
          mockMode: input.mockMode,
          fresh: input.fresh,
          lastIngestedCount: input.ingested,
          lastIngestedAt: new Date().toISOString(),
        },
      },
      create: {
        source,
        configured: input.configured,
        healthy: input.healthy,
        weight: input.weight,
        priority: input.priority,
        lastSuccessAt: input.healthy ? new Date() : null,
        lastFailureAt: input.healthy ? null : new Date(),
        lastError: input.error,
        consecutiveFailures: input.healthy ? 0 : 1,
        metadata: {
          mockMode: input.mockMode,
          fresh: input.fresh,
          lastIngestedCount: input.ingested,
          lastIngestedAt: new Date().toISOString(),
        },
      },
    });
  }

  private getConnectorPolicy(source: SourceType): {
    weight: number;
    priority: number;
  } {
    const weights = this.parseJsonMap('SOURCE_CONNECTOR_WEIGHTS_JSON');
    const priorities = this.parseJsonMap('SOURCE_CONNECTOR_PRIORITIES_JSON');

    return {
      weight: Number(weights[source] ?? 1),
      priority: Number(priorities[source] ?? 100),
    };
  }

  private parseJsonMap(envName: string): Record<string, number> {
    const raw = this.configService.get<string>(envName)?.trim();
    if (!raw) {
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, Number(value)]),
    );
  }

  private parseMockRows(envKey: string): Array<Record<string, unknown>> {
    const raw = this.configService.get<string>(envKey) || '[]';
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((row): row is Record<string, unknown> => {
            return Boolean(row && typeof row === 'object');
          })
        : [];
    } catch {
      return [];
    }
  }

  private getRedditRapidApiConfig(): RedditRapidApiConfig {
    const rawMethod = this.configService
      .getOrThrow<string>('REDDIT_RAPIDAPI_METHOD')
      .trim()
      .toUpperCase();
    const method: 'GET' | 'POST' = rawMethod === 'POST' ? 'POST' : 'GET';

    return {
      key: this.configService.getOrThrow<string>('REDDIT_RAPIDAPI_KEY').trim(),
      host: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_HOST')
        .trim(),
      baseUrl: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_BASE_URL')
        .trim(),
      pathTemplate: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_PATH_TEMPLATE')
        .trim(),
      method,
      limitParam: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_LIMIT_PARAM')
        .trim(),
      timeParam: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_TIME_PARAM')
        .trim(),
      timeValue: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_TIME_VALUE')
        .trim(),
      syncTrendWindow:
        this.configService.get<boolean>('REDDIT_SYNC_TREND_WINDOW') !== false,
      itemsPath: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_ITEMS_PATH')
        .trim(),
      itemDataPath: this.configService
        .getOrThrow<string>('REDDIT_RAPIDAPI_ITEM_DATA_PATH')
        .trim(),
    };
  }

  private buildRapidApiUrl(
    baseUrl: string,
    pathTemplate: string,
    subreddit: string,
    timeParam: string,
    timeRange: string,
  ): string {
    const populatedPath = pathTemplate.replaceAll(
      '{subreddit}',
      encodeURIComponent(subreddit),
    );
    const url = new URL(populatedPath, baseUrl);

    if (timeParam) {
      url.searchParams.set(timeParam, timeRange);
    }

    return url.toString();
  }

  private resolveRedditTimeRange(config: RedditRapidApiConfig): string {
    if (!config.syncTrendWindow) {
      return config.timeValue || 'day';
    }

    const windows = parseTrendWindowHours(
      this.configService.get<string>('TREND_WINDOWS_HOURS'),
    );
    const maxWindowHours = Math.max(...windows);
    return toRedditTimeRange(maxWindowHours);
  }

  private extractRapidApiItems(
    payload: Record<string, unknown>,
    itemsPath: string,
    itemDataPath: string,
  ): Array<Record<string, unknown>> {
    const container = this.getByPath(payload, itemsPath);
    if (!Array.isArray(container)) {
      return [];
    }

    return container
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return null;
        }
        const base = item as Record<string, unknown>;
        const nested = itemDataPath ? this.getByPath(base, itemDataPath) : base;
        if (nested && typeof nested === 'object') {
          return nested as Record<string, unknown>;
        }
        return base;
      })
      .filter((item): item is Record<string, unknown> => Boolean(item));
  }

  private getByPath(source: unknown, path: string): unknown {
    if (!path) {
      return source;
    }

    return path
      .split('.')
      .map((segment) => segment.trim())
      .filter(Boolean)
      .reduce<unknown>((current, segment) => {
        if (!current || typeof current !== 'object') {
          return undefined;
        }
        return (current as Record<string, unknown>)[segment];
      }, source);
  }

  private resolveExternalId(candidate: EventCandidate): string {
    const explicitId = this.asString(candidate.explicitExternalId);
    if (explicitId) {
      return explicitId;
    }

    const createdValue =
      typeof candidate.createdRaw === 'number' ||
      typeof candidate.createdRaw === 'string'
        ? String(candidate.createdRaw)
        : '';

    const fingerprint = [
      candidate.source,
      candidate.sourceUrl,
      candidate.title,
      candidate.body,
      candidate.author,
      createdValue,
    ].join('|');

    return createHash('sha256').update(fingerprint).digest('hex');
  }

  private get watchlistSymbols(): Set<string> {
    const raw = this.configService.get<string>('WATCHLIST_SYMBOLS') || '';
    return new Set(
      raw
        .split(',')
        .map((value) => value.trim().toUpperCase())
        .filter(Boolean),
    );
  }

  private shouldUseMockData(): boolean {
    return this.configService.get<string>('NODE_ENV') === 'development';
  }

  private asString(value: unknown): string {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return '';
  }

  private asNumber(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private asDate(value: unknown): Date {
    if (value instanceof Date) {
      return value;
    }
    if (typeof value === 'number') {
      const normalized = value > 1e12 ? value : value * 1000;
      return new Date(normalized);
    }
    if (typeof value === 'string' && value.trim() !== '') {
      return new Date(value);
    }
    return new Date();
  }
}

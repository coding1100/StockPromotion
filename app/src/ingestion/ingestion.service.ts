import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosRequestConfig } from 'axios';
import { Prisma, SourceType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { extractSymbols } from '../common/utils/symbol.util';
import { AuditService } from '../audit/audit.service';
import { TelemetryService } from '../telemetry/telemetry.service';
import { executeWithRetry } from '../common/utils/http.util';

type ConnectorName = 'reddit' | 'stocktwitsSignal' | 'news';

type ConnectorResult = {
  configured: boolean;
  healthy: boolean;
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
      .filter(([, value]) => value.configured && value.healthy)
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
    const mockMode = source === SourceType.REDDIT && this.isRedditMockEnabled();

    if (!configured) {
      await this.persistConnectorState(source, {
        configured: false,
        healthy: false,
        weight,
        priority,
        error: 'connector_not_configured',
        mockMode,
      });
      return {
        configured: false,
        healthy: false,
        ingested: 0,
        error: 'connector_not_configured',
        weight,
        priority,
        mockMode,
      };
    }

    try {
      const ingested = await fn();
      this.telemetryService.increment(`connector.${name}.success`);
      await this.persistConnectorState(source, {
        configured: true,
        healthy: true,
        weight,
        priority,
        error: null,
        mockMode,
      });
      return {
        configured: true,
        healthy: true,
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
        ingested: 0,
        error: message,
        weight,
        priority,
        mockMode,
      };
    }
  }

  private isRedditConfigured(): boolean {
    if (this.isRedditMockEnabled()) {
      return true;
    }

    const clientId = this.configService.get<string>('REDDIT_CLIENT_ID') || '';
    const clientSecret =
      this.configService.get<string>('REDDIT_CLIENT_SECRET') || '';
    const subreddits = this.configService
      .getOrThrow<string>('REDDIT_SUBREDDITS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return Boolean(clientId && clientSecret && subreddits.length > 0);
  }

  private isRedditMockEnabled(): boolean {
    return this.configService.get<boolean>('REDDIT_MOCK_ENABLED') === true;
  }

  private isStocktwitsSignalConfigured(): boolean {
    if (this.isStocktwitsSignalMockEnabled()) {
      return true;
    }
    return Boolean(this.configService.get<string>('STOCKTWITS_SIGNAL_API_URL'));
  }

  private isStocktwitsSignalMockEnabled(): boolean {
    return (
      this.configService.get<boolean>('STOCKTWITS_SIGNAL_MOCK_ENABLED') === true
    );
  }

  private isNewsConfigured(): boolean {
    if (this.isNewsMockEnabled()) {
      return true;
    }
    return Boolean(this.configService.get<string>('NEWS_SENTIMENT_API_URL'));
  }

  private isNewsMockEnabled(): boolean {
    return this.configService.get<boolean>('NEWS_MOCK_ENABLED') === true;
  }

  private async ingestReddit(): Promise<number> {
    if (this.isRedditMockEnabled()) {
      return this.ingestMockReddit();
    }

    const clientId = this.configService.get<string>('REDDIT_CLIENT_ID') || '';
    const clientSecret =
      this.configService.get<string>('REDDIT_CLIENT_SECRET') || '';
    const userAgent =
      this.configService.getOrThrow<string>('REDDIT_USER_AGENT');
    const subreddits = this.configService
      .getOrThrow<string>('REDDIT_SUBREDDITS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const fetchLimit =
      this.configService.getOrThrow<number>('REDDIT_FETCH_LIMIT');

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenResponse = await executeWithRetry(
      () =>
        axios.post<{ access_token: string }>(
          'https://www.reddit.com/api/v1/access_token',
          'grant_type=client_credentials',
          {
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': userAgent,
            },
            timeout: this.requestTimeoutMs,
          },
        ),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 2000,
      },
    );

    const token = tokenResponse.data.access_token;
    let ingested = 0;

    for (const subreddit of subreddits) {
      const request: AxiosRequestConfig = {
        method: 'GET',
        url: `https://oauth.reddit.com/r/${subreddit}/hot`,
        params: { limit: fetchLimit },
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent,
        },
      };

      const response = await executeWithRetry(
        () =>
          axios.request<{
            data: { children: Array<{ data: Record<string, unknown> }> };
          }>({
            ...request,
            timeout: this.requestTimeoutMs,
          }),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: 200,
          maxDelayMs: 2000,
        },
      );

      const rows = response.data.data.children.map((item) =>
        this.mapRedditEvent(item.data, false),
      );

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
            `mock-reddit-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
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
    const body = this.asString(payload.selftext);
    const combined = `${title}\n${body}`.trim();

    return {
      source: SourceType.REDDIT,
      externalId: this.asString(payload.id),
      sourceUrl: `https://reddit.com${this.asString(payload.permalink)}`,
      title,
      body: combined.slice(0, 6000),
      symbols: extractSymbols(combined),
      sentimentScore: null,
      engagementScore: this.asNumber(payload.score),
      author: this.asString(payload.author),
      rawPayload: {
        ...(payload as Prisma.JsonObject),
        mockMode,
      },
      occurredAt: this.asDate(payload.created_utc),
    };
  }

  private async ingestStocktwitsSignals(): Promise<number> {
    if (this.isStocktwitsSignalMockEnabled()) {
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
          ...extractSymbols(body).filter((value) => value !== symbol),
        ];

        return {
          source: SourceType.STOCKTWITS_SIGNAL,
          externalId: this.asString(message.id) || `${symbol}-${Date.now()}`,
          sourceUrl: this.asString(message.url),
          title: null,
          body: body.slice(0, 6000),
          symbols: joinedSymbols,
          sentimentScore: null,
          engagementScore: this.asNumber(message.likes),
          author: this.asString(
            (message.user as { username?: unknown })?.username,
          ),
          rawPayload: message as Prisma.JsonObject,
          occurredAt: this.asDate(message.created_at),
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
        extractSymbols(this.asString(item.symbol) || body)[0] || 'AAPL';
      const symbols = [
        primarySymbol,
        ...extractSymbols(body).filter((value) => value !== primarySymbol),
      ];

      return {
        source: SourceType.STOCKTWITS_SIGNAL,
        externalId:
          this.asString(item.id) ||
          `mock-stocktwits-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
        sourceUrl: this.asString(item.url) || `https://stocktwits.com/symbol/${primarySymbol}`,
        title: null,
        body: body.slice(0, 6000),
        symbols,
        sentimentScore: this.asNumber(item.sentiment) || null,
        engagementScore: this.asNumber(item.likes),
        author: this.asString(item.author) || 'mock-stocktwits-user',
        rawPayload: {
          ...(item as Prisma.JsonObject),
          mockMode: true,
        },
        occurredAt: this.asDate(item.createdAt),
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
    if (this.isNewsMockEnabled()) {
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

      return {
        source: SourceType.NEWS_API,
        externalId:
          this.asString(item.id) || this.asString(item.url) || `${Date.now()}`,
        sourceUrl: this.asString(item.url),
        title: title.slice(0, 512),
        body: body.slice(0, 6000),
        symbols: extractSymbols(`${title}\n${body}`),
        sentimentScore: this.asNumber(item.sentiment),
        engagementScore: this.asNumber(item.rank),
        author: this.asString(item.source),
        rawPayload: item as Prisma.JsonObject,
        occurredAt: this.asDate(item.publishedAt ?? item.time),
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

      return {
        source: SourceType.NEWS_API,
        externalId:
          this.asString(item.id) ||
          this.asString(item.url) ||
          `mock-news-${Date.now()}-${String(index + 1).padStart(2, '0')}`,
        sourceUrl: this.asString(item.url) || `https://example.test/mock-news/${index + 1}`,
        title: title.slice(0, 512),
        body: body.slice(0, 6000),
        symbols: extractSymbols(`${title}\n${body}`),
        sentimentScore: this.asNumber(item.sentiment),
        engagementScore: this.asNumber(item.rank),
        author: this.asString(item.source) || 'mock-news',
        rawPayload: {
          ...(item as Prisma.JsonObject),
          mockMode: true,
        },
        occurredAt: this.asDate(item.publishedAt ?? item.time ?? item.createdAt),
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

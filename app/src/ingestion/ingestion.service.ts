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
    const stocktwitsConfigured = Boolean(
      this.configService.get<string>('STOCKTWITS_SIGNAL_API_URL'),
    );
    const newsConfigured = Boolean(
      this.configService.get<string>('NEWS_SENTIMENT_API_URL'),
    );

    const [reddit, stocktwitsSignal, news] = await Promise.all([
      this.runConnector('reddit', redditConfigured, () => this.ingestReddit()),
      this.runConnector('stocktwitsSignal', stocktwitsConfigured, () =>
        this.ingestStocktwitsSignals(),
      ),
      this.runConnector('news', newsConfigured, () =>
        this.ingestNewsSentiment(),
      ),
    ]);

    const activeSources = Object.entries({
      reddit,
      stocktwitsSignal,
      news,
    })
      .filter(([, value]) => value.configured && value.healthy)
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
    this.telemetryService.increment(
      'pipeline.ingestion.records',
      news.ingested,
    );

    await this.auditService.record(
      'ingestion.completed',
      'system',
      'pipeline',
      summary as Prisma.InputJsonValue,
    );

    return summary;
  }

  private get requestTimeoutMs(): number {
    return this.configService.getOrThrow<number>('HTTP_REQUEST_TIMEOUT_MS');
  }

  private get maxRetries(): number {
    return this.configService.getOrThrow<number>('HTTP_MAX_RETRIES');
  }

  private async runConnector(
    name: ConnectorName,
    configured: boolean,
    fn: () => Promise<number>,
  ): Promise<ConnectorResult> {
    if (!configured) {
      return {
        configured: false,
        healthy: false,
        ingested: 0,
        error: 'connector_not_configured',
      };
    }

    try {
      const ingested = await fn();
      this.telemetryService.increment(`connector.${name}.success`);
      return {
        configured: true,
        healthy: true,
        ingested,
        error: null,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'connector_execution_failed';
      this.telemetryService.increment(`connector.${name}.failed`);
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
      };
    }
  }

  private isRedditConfigured(): boolean {
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

  private async ingestReddit(): Promise<number> {
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

      const rows = response.data.data.children.map((item) => {
        const payload = item.data;
        const title = this.asString(payload.title);
        const body = this.asString(payload.selftext);
        const combined = `${title}\n${body}`;

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
          rawPayload: payload as Prisma.JsonObject,
          occurredAt: this.asDate(payload.created_utc),
        };
      });

      const result = await this.prisma.sourceEvent.createMany({
        data: rows,
        skipDuplicates: true,
      });
      ingested += result.count;
    }

    return ingested;
  }

  private async ingestStocktwitsSignals(): Promise<number> {
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

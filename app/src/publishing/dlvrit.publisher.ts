import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { DlvritSessionService } from './dlvrit-session.service';

const DLVRIT_POST_URL = 'https://api.dlvrit.com/2.0/post/postplus';
const DLVRIT_SOCIALS_URL = 'https://api.dlvrit.com/2.0/social/list';

// StockTwits content type key in dlvr.it's v2 API payload
const DLVRIT_STOCKTWITS_CONTENT_KEY = '22';

export type DlvritPostResult = {
  externalPostId: string;
  evidenceUri: string;
};

export type DlvritRoute = {
  id: number;
  name: string;
  active: boolean;
  needsReconnect: boolean;
  platformId: number | null;
};

@Injectable()
export class DlvritPublisher {
  private readonly logger = new Logger(DlvritPublisher.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly sessionService: DlvritSessionService,
  ) {}

  // ── Session management ────────────────────────────────────────────────────

  private async getSession(workspaceId?: string): Promise<string> {
    const cookie = await this.sessionService.getSessionCookie(workspaceId);
    return `dlvrit=${cookie}`;
  }

  // ── Posting ───────────────────────────────────────────────────────────────

  async postToAccount(params: {
    dlvritAccountId: number;
    dlvritWorkspaceId?: string | null;
    message: string;
    jobId: string;
  }): Promise<DlvritPostResult> {
    const dryRun =
      this.configService.get<boolean>('STOCKTWITS_DRY_RUN') ?? false;
    if (dryRun) {
      this.logger.log(
        `[DRY RUN] dlvr.it postplus account=${params.dlvritAccountId} ` +
          `msg="${params.message.slice(0, 80)}..."`,
      );
      return { externalPostId: `dry-run-${params.jobId}`, evidenceUri: '' };
    }

    const session = await this.getSession(params.dlvritWorkspaceId ?? undefined);

    try {
      return await this.callPostPlus(session, params);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        this.logger.warn('dlvr.it session expired — refreshing automatically…');
        const fresh = await this.sessionService.refreshSession(
          params.dlvritWorkspaceId ?? undefined,
        );
        return this.callPostPlus(`dlvrit=${fresh}`, params);
      }
      throw err;
    }
  }

  private async callPostPlus(
    cookies: string,
    params: { dlvritAccountId: number; message: string; jobId: string },
  ): Promise<DlvritPostResult> {
    const timeoutMs =
      this.configService.get<number>('HTTP_REQUEST_TIMEOUT_MS') ?? 10_000;

    const payload = {
      ci_id: 0,
      content: {
        [DLVRIT_STOCKTWITS_CONTENT_KEY]: {
          message: params.message,
          mb_id: 0,
          form: 'status',
        },
      },
      params: { postFlag: 0, post_times: [] },
      accounts: [params.dlvritAccountId],
    };

    let data: unknown;
    try {
      const response = await axios.post(DLVRIT_POST_URL, payload, {
        headers: {
          'content-type': 'application/json',
          origin: 'https://app.dlvrit.com',
          referer: 'https://app.dlvrit.com/content/post',
          cookie: cookies,
        },
        timeout: timeoutMs,
      });
      data = response.data;
      this.logger.log(
        `dlvr.it postplus response: account=${params.dlvritAccountId} ` +
          `body=${JSON.stringify(data)}`,
      );
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const body = err.response?.data;
        // Re-throw 401 as-is so postToAccount can detect it and refresh the session
        if (status === 401) throw err;
        throw new Error(
          `dlvrit_http_error: HTTP ${status ?? 'network'} from dlvr.it. ` +
            `Body: ${JSON.stringify(body ?? err.message)}`,
        );
      }
      throw err;
    }

    // Success response is [] (empty array) or an object with post details
    if (Array.isArray(data) && data.length === 0) {
      const externalPostId = `dlvrit-${params.dlvritAccountId}-${Date.now()}`;
      this.logger.log(
        `dlvr.it post confirmed: account=${params.dlvritAccountId} id=${externalPostId}`,
      );
      return { externalPostId, evidenceUri: '' };
    }

    // Check for error in response
    if (data && typeof data === 'object') {
      const obj = data as Record<string, unknown>;
      if (obj['status'] === 'fail' || obj['error']) {
        const msg =
          (obj['0'] as Record<string, unknown> | undefined)?.['msg'] ??
          (obj['error'] as Record<string, unknown> | undefined)?.['msg'] ??
          JSON.stringify(data);
        throw new Error(
          `dlvrit_api_error: "${msg}" — account ${params.dlvritAccountId}.`,
        );
      }
    }

    const externalPostId = `dlvrit-${params.dlvritAccountId}-${Date.now()}`;
    this.logger.log(
      `dlvr.it post confirmed: account=${params.dlvritAccountId} id=${externalPostId}`,
    );
    return { externalPostId, evidenceUri: '' };
  }

  // ── Route listing (for UI "Fetch from dlvr.it") ───────────────────────────

  async listConnectedAccounts(workspaceId?: string): Promise<DlvritRoute[]> {
    const data = await this.fetchConnectedSocials(workspaceId);
    return data.map((r) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      active: Number(r.activeFlag) === 1,
      needsReconnect: Number(r.sysActionFlag) !== 0,
      platformId: r.psID == null ? null : Number(r.psID),
    }));
  }

  async listConnectedAccountsRaw(workspaceId?: string): Promise<unknown> {
    return this.fetchConnectedSocials(workspaceId);
  }

  private async fetchConnectedSocials(workspaceId?: string): Promise<
    Array<{ id?: unknown; name?: unknown; [key: string]: unknown }>
  > {
    const timeoutMs = this.configService.get<number>('HTTP_REQUEST_TIMEOUT_MS') ?? 10_000;
    const request = async (cookie: string) =>
      axios.get<Array<{ id?: unknown; name?: unknown; [key: string]: unknown }>>(
        DLVRIT_SOCIALS_URL,
        {
          headers: {
            cookie: `dlvrit=${cookie}`,
            origin: 'https://app.dlvrit.com',
            referer: 'https://app.dlvrit.com/content/post',
          },
          timeout: timeoutMs,
        },
      );

    try {
      const cookie = await this.sessionService.getSessionCookie(workspaceId);
      return (await request(cookie)).data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        const fresh = await this.sessionService.refreshSession(workspaceId);
        return (await request(fresh)).data;
      }
      if (axios.isAxiosError(err)) {
        throw new Error(
          `dlvrit_http_error: HTTP ${err.response?.status ?? 'network'} from dlvr.it. ` +
            `Body: ${JSON.stringify(err.response?.data ?? err.message)}`,
        );
      }
      throw err;
    }
  }
}

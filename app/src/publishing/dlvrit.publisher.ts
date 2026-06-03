import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const DLVRIT_POST_URL = 'https://api.dlvrit.com/1/postToAccount.json';

// dlvr.it error codes that are fatal — no point retrying same config
const FATAL_CODES = new Set([3, 4, 6, 102, 103]);

type DlvritApiResponse = {
  item?: { id?: string | number; [key: string]: unknown };
  error?: { code?: number; message?: string };
  // Flat-form used by some endpoint versions
  status?: number;
  message?: string;
};

export type DlvritPostResult = {
  externalPostId: string;
  evidenceUri: string;
};

@Injectable()
export class DlvritPublisher {
  private readonly logger = new Logger(DlvritPublisher.name);

  constructor(private readonly configService: ConfigService) {}

  async postToAccount(params: {
    dlvritAccountId: number;
    message: string;
    jobId: string;
  }): Promise<DlvritPostResult> {
    const apiKey = this.configService.get<string>('DLVRIT_API_KEY');
    if (!apiKey) {
      throw new Error(
        'dlvrit_api_key_missing: DLVRIT_API_KEY is not configured. ' +
          'Get your key from dlvrit.com → Settings → Account.',
      );
    }

    const dryRun =
      this.configService.get<boolean>('STOCKTWITS_DRY_RUN') ?? false;
    if (dryRun) {
      this.logger.log(
        `[DRY RUN] dlvr.it postToAccount id=${params.dlvritAccountId} ` +
          `msg="${params.message.slice(0, 80)}..."`,
      );
      return { externalPostId: `dry-run-${params.jobId}`, evidenceUri: '' };
    }

    const timeoutMs =
      this.configService.get<number>('HTTP_REQUEST_TIMEOUT_MS') ?? 10_000;

    let data: DlvritApiResponse;
    try {
      const response = await axios.post<DlvritApiResponse>(
        DLVRIT_POST_URL,
        new URLSearchParams({
          key: apiKey,
          id: String(params.dlvritAccountId),
          msg: params.message,
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: timeoutMs,
        },
      );
      data = response.data;
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const body = err.response?.data;
        throw new Error(
          `dlvrit_http_error: HTTP ${status ?? 'network'} from dlvr.it. ` +
            `Body: ${JSON.stringify(body ?? err.message)}`,
        );
      }
      throw err;
    }

    if (data.error) {
      const code = data.error.code ?? 0;
      const msg = data.error.message ?? 'unknown';

      if (code === 5) {
        throw new Error(
          `dlvrit_rate_limit: transaction limit reached for dlvr.it account ` +
            `${params.dlvritAccountId}. Upgrade plan or reduce posting frequency.`,
        );
      }

      const tag = FATAL_CODES.has(code) ? 'dlvrit_fatal_error' : 'dlvrit_error';
      throw new Error(
        `${tag} (code ${code}): "${msg}" — account ${params.dlvritAccountId}.`,
      );
    }

    // Flat-form error codes (status >= 2 are errors in dlvr.it API)
    if (typeof data.status === 'number' && data.status >= 2) {
      throw new Error(
        `dlvrit_api_error (status ${data.status}): ` +
          `"${data.message ?? 'no message'}" — account ${params.dlvritAccountId}.`,
      );
    }

    const externalPostId =
      data.item?.id != null
        ? String(data.item.id)
        : `dlvrit-${params.dlvritAccountId}-${Date.now()}`;

    this.logger.log(
      `dlvr.it post confirmed: account=${params.dlvritAccountId} id=${externalPostId}`,
    );

    return { externalPostId, evidenceUri: '' };
  }
}

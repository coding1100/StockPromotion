import { AxiosError } from 'axios';

type RetryOptions = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

type RetryAfterPayload = {
  parameters?: {
    retry_after?: unknown;
  };
};

export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= options.maxRetries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxRetries || !isRetryableHttpError(error)) {
        throw error;
      }

      const retryAfterDelayMs = getRetryAfterDelayMs(error);
      const exponentialDelay = options.baseDelayMs * 2 ** attempt;
      const jitter = Math.floor(Math.random() * 100);
      const computedDelay = Math.min(
        options.maxDelayMs,
        exponentialDelay + jitter,
      );
      const delayMs = Math.max(computedDelay, retryAfterDelayMs ?? 0);
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw lastError;
}

function isRetryableHttpError(error: unknown): boolean {
  if (!(error instanceof AxiosError)) {
    return false;
  }

  if (!error.response) {
    return true;
  }

  const status = error.response.status;
  return status === 408 || status === 429 || status >= 500;
}

function getRetryAfterDelayMs(error: unknown): number | null {
  if (!(error instanceof AxiosError) || !error.response?.data) {
    return null;
  }

  const payload = error.response.data as RetryAfterPayload;
  const retryAfterRaw = payload.parameters?.retry_after;
  if (typeof retryAfterRaw !== 'number' || !Number.isFinite(retryAfterRaw)) {
    return null;
  }

  const seconds = Math.max(0, retryAfterRaw);
  return Math.floor(seconds * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

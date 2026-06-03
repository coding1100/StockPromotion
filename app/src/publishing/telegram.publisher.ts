import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';
import { executeWithRetry } from '../common/utils/http.util';

type TelegramResponseParameters = {
  retry_after?: number;
  migrate_to_chat_id?: number | string;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: TelegramResponseParameters;
};

type TelegramMessageResult = {
  message_id?: number | string;
};

type TelegramSendMessageBody = {
  chat_id: string;
  text: string;
  link_preview_options: {
    is_disabled: boolean;
  };
};

type TelegramChatAccessResult = {
  accessible: boolean;
  resolvedChatId: string;
};

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly parameters?: TelegramResponseParameters,
  ) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

@Injectable()
export class TelegramPublisher {
  constructor(private readonly configService: ConfigService) {}

  private get requestTimeoutMs(): number {
    return this.configService.getOrThrow<number>('HTTP_REQUEST_TIMEOUT_MS');
  }

  private get maxRetries(): number {
    return this.configService.getOrThrow<number>('HTTP_MAX_RETRIES');
  }

  async sendMessage(
    chatId: string,
    text: string,
    botToken?: string,
  ): Promise<{
    externalPostId: string;
    responsePayload: unknown;
    resolvedChatId?: string;
  }> {
    const token =
      botToken || this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const normalizedText = text.trim();
    if (normalizedText.length === 0) {
      throw new Error('telegram_message_text_empty');
    }
    if (normalizedText.length > 4096) {
      throw new Error('telegram_message_text_too_long');
    }

    const primaryResponse = await this.sendMessageToChat(
      token,
      chatId,
      normalizedText,
    ).catch(async (error: unknown) => {
      const migrateToChatId = this.extractMigrateToChatId(error);
      if (!migrateToChatId || migrateToChatId === chatId) {
        throw error;
      }

      const migratedResponse = await this.sendMessageToChat(
        token,
        migrateToChatId,
        normalizedText,
      );
      return {
        response: migratedResponse.response,
        result: migratedResponse.result,
        resolvedChatId: migrateToChatId,
      };
    });

    const messageId =
      primaryResponse.result.message_id !== undefined
        ? String(primaryResponse.result.message_id)
        : '';
    if (!messageId) {
      throw new Error('telegram_message_id_missing');
    }

    return {
      externalPostId: messageId,
      responsePayload: primaryResponse.response.data,
      resolvedChatId:
        primaryResponse.resolvedChatId &&
        primaryResponse.resolvedChatId !== chatId
          ? primaryResponse.resolvedChatId
          : undefined,
    };
  }

  async canAccessChat(chatId: string, botToken?: string): Promise<boolean> {
    const status = await this.inspectChatAccess(chatId, botToken);
    return status.accessible;
  }

  async inspectChatAccess(
    chatId: string,
    botToken?: string,
  ): Promise<TelegramChatAccessResult> {
    const token =
      botToken || this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    if (!token) {
      return { accessible: false, resolvedChatId: chatId };
    }

    try {
      await this.getChat(token, chatId);
      return { accessible: true, resolvedChatId: chatId };
    } catch (error) {
      const migratedToChatId = this.extractMigrateToChatId(error);
      if (!migratedToChatId || migratedToChatId === chatId) {
        return { accessible: false, resolvedChatId: chatId };
      }

      try {
        await this.getChat(token, migratedToChatId);
        return { accessible: true, resolvedChatId: migratedToChatId };
      } catch {
        return { accessible: false, resolvedChatId: migratedToChatId };
      }
    }
  }

  private async sendMessageToChat(
    token: string,
    chatId: string,
    text: string,
  ): Promise<{
    response: AxiosResponse<TelegramApiResponse<TelegramMessageResult>>;
    result: TelegramMessageResult;
    resolvedChatId: string;
  }> {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body: TelegramSendMessageBody = {
      chat_id: chatId,
      text,
      link_preview_options: {
        is_disabled: true,
      },
    };

    const response = await executeWithRetry(
      () =>
        axios.post<TelegramApiResponse<TelegramMessageResult>>(url, body, {
          timeout: this.requestTimeoutMs,
          validateStatus: () => true,
        }),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 5000,
      },
    );

    const result = this.expectTelegramOk(
      response,
      `sendMessage failed for chat ${chatId}`,
    );

    return {
      response,
      result,
      resolvedChatId: chatId,
    };
  }

  private async getChat(token: string, chatId: string): Promise<unknown> {
    const response = await executeWithRetry(
      () =>
        axios.get<TelegramApiResponse<unknown>>(
          `https://api.telegram.org/bot${token}/getChat`,
          {
            params: { chat_id: chatId },
            timeout: this.requestTimeoutMs,
            validateStatus: () => true,
          },
        ),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 5000,
      },
    );

    return this.expectTelegramOk(response, `getChat failed for chat ${chatId}`);
  }

  private expectTelegramOk<T>(
    response: AxiosResponse<TelegramApiResponse<T>>,
    fallbackMessage: string,
  ): T {
    const payload = response.data;
    if (payload?.ok && payload.result !== undefined) {
      return payload.result;
    }

    const description = payload?.description || fallbackMessage;
    throw new TelegramApiError(
      description,
      payload?.error_code,
      payload?.parameters,
    );
  }

  private extractMigrateToChatId(error: unknown): string | null {
    if (
      error instanceof TelegramApiError &&
      error.parameters?.migrate_to_chat_id !== undefined
    ) {
      return String(error.parameters.migrate_to_chat_id);
    }
    return null;
  }
}

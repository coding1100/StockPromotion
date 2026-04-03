import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { executeWithRetry } from '../common/utils/http.util';

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
  ): Promise<{ externalPostId: string; responsePayload: unknown }> {
    const token =
      botToken || this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN is not configured');
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await executeWithRetry(
      () =>
        axios.post(
          url,
          {
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          },
          {
            timeout: this.requestTimeoutMs,
          },
        ),
      {
        maxRetries: this.maxRetries,
        baseDelayMs: 200,
        maxDelayMs: 1500,
      },
    );

    const data = response.data as { result?: { message_id?: number | string } };
    const messageId =
      data.result && data.result.message_id !== undefined
        ? String(data.result.message_id)
        : '';
    return {
      externalPostId: messageId,
      responsePayload: response.data,
    };
  }

  async canAccessChat(chatId: string, botToken?: string): Promise<boolean> {
    const token =
      botToken || this.configService.get<string>('TELEGRAM_BOT_TOKEN') || '';
    if (!token) {
      return false;
    }

    try {
      await executeWithRetry(
        () =>
          axios.get(`https://api.telegram.org/bot${token}/getChat`, {
            params: { chat_id: chatId },
            timeout: this.requestTimeoutMs,
          }),
        {
          maxRetries: this.maxRetries,
          baseDelayMs: 200,
          maxDelayMs: 1500,
        },
      );
      return true;
    } catch {
      return false;
    }
  }
}

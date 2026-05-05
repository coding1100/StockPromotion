import axios from 'axios';
import { TelegramPublisher } from './telegram.publisher';

jest.mock('axios');

describe('TelegramPublisher', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends message and returns external post id', async () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;
    mockedAxios.post.mockResolvedValueOnce({
      data: {
        ok: true,
        result: {
          message_id: 1234,
        },
      },
    });

    const publisher = new TelegramPublisher({
      get: () => 'bot-token',
      getOrThrow: (key: string) => {
        if (key === 'HTTP_REQUEST_TIMEOUT_MS') {
          return 10000;
        }
        if (key === 'HTTP_MAX_RETRIES') {
          return 2;
        }
        throw new Error(`Missing key: ${key}`);
      },
    } as never);

    const result = await publisher.sendMessage('-100111', 'hello');
    expect(result.externalPostId).toBe('1234');
    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({
        chat_id: '-100111',
        text: 'hello',
        link_preview_options: { is_disabled: true },
      }),
      expect.any(Object),
    );
  });

  it('returns false when chat is not accessible', async () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;
    mockedAxios.get.mockRejectedValueOnce(new Error('forbidden'));

    const publisher = new TelegramPublisher({
      get: () => 'bot-token',
      getOrThrow: (key: string) => {
        if (key === 'HTTP_REQUEST_TIMEOUT_MS') {
          return 10000;
        }
        if (key === 'HTTP_MAX_RETRIES') {
          return 2;
        }
        throw new Error(`Missing key: ${key}`);
      },
    } as never);

    await expect(publisher.canAccessChat('@sample')).resolves.toBe(false);
  });

  it('detects migrated chat id when checking chat access', async () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;
    mockedAxios.get
      .mockResolvedValueOnce({
        data: {
          ok: false,
          error_code: 400,
          description: 'group migrated',
          parameters: {
            migrate_to_chat_id: -10012345,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          result: {
            id: -10012345,
          },
        },
      });

    const publisher = new TelegramPublisher({
      get: () => 'bot-token',
      getOrThrow: (key: string) => {
        if (key === 'HTTP_REQUEST_TIMEOUT_MS') {
          return 10000;
        }
        if (key === 'HTTP_MAX_RETRIES') {
          return 2;
        }
        throw new Error(`Missing key: ${key}`);
      },
    } as never);

    const status = await publisher.inspectChatAccess('@sample');
    expect(status.accessible).toBe(true);
    expect(status.resolvedChatId).toBe('-10012345');
  });

  it('resolves migrated chat id when Telegram reports migration', async () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;
    mockedAxios.post
      .mockResolvedValueOnce({
        data: {
          ok: false,
          error_code: 400,
          description: 'group migrated',
          parameters: {
            migrate_to_chat_id: -100999,
          },
        },
      })
      .mockResolvedValueOnce({
        data: {
          ok: true,
          result: {
            message_id: 555,
          },
        },
      });

    const publisher = new TelegramPublisher({
      get: () => 'bot-token',
      getOrThrow: (key: string) => {
        if (key === 'HTTP_REQUEST_TIMEOUT_MS') {
          return 10000;
        }
        if (key === 'HTTP_MAX_RETRIES') {
          return 2;
        }
        throw new Error(`Missing key: ${key}`);
      },
    } as never);

    const result = await publisher.sendMessage('-100111', 'hello');
    expect(result.externalPostId).toBe('555');
    expect(result.resolvedChatId).toBe('-100999');
    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});

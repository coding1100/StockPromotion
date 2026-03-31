import axios from 'axios';
import { TelegramPublisher } from './telegram.publisher';

jest.mock('axios');

describe('TelegramPublisher', () => {
  it('sends message and returns external post id', async () => {
    const mockedAxios = axios as jest.Mocked<typeof axios>;
    mockedAxios.post.mockResolvedValueOnce({
      data: {
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
});

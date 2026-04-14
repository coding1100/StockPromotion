import { Locator, Page } from 'playwright';
import {
  StocktwitsPublisher,
  parseTrendingSymbolsFromHtml,
} from './stocktwits.publisher';

describe('StocktwitsPublisher', () => {
  const configServiceMock = {
    get: jest.fn(),
    getOrThrow: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('parses ranked top symbols from representative trending HTML rows', () => {
    const html = `
      <table>
        <tbody>
          <tr>
            <td>2</td>
            <td><a href="/symbol/IREN">IREN</a><div>IREN Limited</div></td>
          </tr>
          <tr>
            <td>1</td>
            <td><a href="/symbol/ORCL">ORCL</a><div>Oracle Corp.</div></td>
          </tr>
          <tr>
            <td>3</td>
            <td><a href="/symbol/INTC">INTC</a><div>Intel Corp.</div></td>
          </tr>
        </tbody>
      </table>
    `;

    expect(parseTrendingSymbolsFromHtml(html, 10)).toEqual([
      'ORCL',
      'IREN',
      'INTC',
    ]);
  });

  it('posts on symbol feed when inline composer flow succeeds', async () => {
    const publisher = new StocktwitsPublisher(configServiceMock as never);
    const publisherAny = publisher as any;
    const page = {} as Page;
    const composerScope = {} as Locator;

    jest.spyOn(publisherAny, 'navigateToSymbolFeed').mockResolvedValue(undefined);
    const strictFlowSpy = jest
      .spyOn(publisherAny, 'executeStrictSymbolComposerFlow')
      .mockResolvedValue(composerScope);
    jest
      .spyOn(publisherAny, 'submitInlineSymbolPost')
      .mockResolvedValue(undefined);
    const modalSpy = jest
      .spyOn(publisherAny, 'handlePostConfirmationModal')
      .mockResolvedValue(undefined);
    jest.spyOn(publisherAny, 'finalizeDialogPost').mockResolvedValue(undefined);
    jest
      .spyOn(publisherAny, 'waitForPublishConfirmation')
      .mockResolvedValue('12345');

    const messageId = await publisherAny.postOnSymbolFeed(
      page,
      'https://stocktwits.com',
      'ORCL',
      '$ORCL\n\nMomentum is building.',
    );

    expect(messageId).toBe('12345');
    expect(publisherAny.navigateToSymbolFeed).toHaveBeenCalledWith(
      page,
      'https://stocktwits.com',
      'ORCL',
    );
    expect(strictFlowSpy).toHaveBeenCalledWith(
      page,
      'ORCL',
      'Momentum is building.',
    );
    expect(modalSpy).toHaveBeenCalledTimes(1);
  });

  it('handles cashtag confirmation modal in symbol composer flow', async () => {
    const publisher = new StocktwitsPublisher(configServiceMock as never);
    const publisherAny = publisher as any;
    const page = {} as Page;
    const composerScope = {} as Locator;

    jest.spyOn(publisherAny, 'navigateToSymbolFeed').mockResolvedValue(undefined);
    jest
      .spyOn(publisherAny, 'executeStrictSymbolComposerFlow')
      .mockResolvedValue(composerScope);
    jest
      .spyOn(publisherAny, 'submitInlineSymbolPost')
      .mockResolvedValue(undefined);
    const modalSpy = jest
      .spyOn(publisherAny, 'handlePostConfirmationModal')
      .mockResolvedValue(undefined);
    jest.spyOn(publisherAny, 'finalizeDialogPost').mockResolvedValue(undefined);
    jest
      .spyOn(publisherAny, 'waitForPublishConfirmation')
      .mockResolvedValue('99887');

    const messageId = await publisherAny.postOnSymbolFeed(
      page,
      'https://stocktwits.com',
      'INTC',
      '$INTC\n\nSignal check.',
    );

    expect(messageId).toBe('99887');
    expect(modalSpy).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when inline symbol composer cannot be found', async () => {
    const publisher = new StocktwitsPublisher(configServiceMock as never);
    const publisherAny = publisher as any;
    const page = {} as Page;

    jest.spyOn(publisherAny, 'navigateToSymbolFeed').mockResolvedValue(undefined);
    jest
      .spyOn(publisherAny, 'executeStrictSymbolComposerFlow')
      .mockRejectedValue(
        new Error('stocktwits_symbol_composer_not_found:ORCL'),
      );

    await expect(
      publisherAny.postOnSymbolFeed(
        page,
        'https://stocktwits.com',
        'ORCL',
        '$ORCL\n\nTest body',
      ),
    ).rejects.toThrow(/stocktwits_symbol_composer_not_found/i);
  });

  it('removes a leading matching cashtag line when preparing symbol feed message', () => {
    const publisher = new StocktwitsPublisher(configServiceMock as never);
    const publisherAny = publisher as any;

    expect(
      publisherAny.prepareSymbolFeedMessage('QQQ', '$QQQ\n\nMomentum is accelerating.'),
    ).toBe('Momentum is accelerating.');
    expect(
      publisherAny.prepareSymbolFeedMessage('QQQ', 'Momentum is accelerating.'),
    ).toBe('Momentum is accelerating.');
  });

  it('prefers local composer post button before global fallbacks', async () => {
    const publisher = new StocktwitsPublisher(configServiceMock as never);
    const publisherAny = publisher as any;
    const page = {} as Page;
    const composer = {} as Locator;

    const localSpy = jest
      .spyOn(publisherAny, 'clickPostButtonWithinComposerContainer')
      .mockResolvedValue(true);

    await publisherAny.submitInlineSymbolPost(page, composer);

    expect(localSpy).toHaveBeenCalledWith(page, composer);
  });

  it('throws when no inline post button is found in symbol flow', async () => {
    const publisher = new StocktwitsPublisher(configServiceMock as never);
    const publisherAny = publisher as any;
    const page = {} as Page;
    const composer = {} as Locator;

    jest
      .spyOn(publisherAny, 'clickPostButtonWithinComposerContainer')
      .mockResolvedValue(false);

    await expect(
      publisherAny.submitInlineSymbolPost(page, composer),
    ).rejects.toThrow(/stocktwits_inline_post_button_not_found_or_disabled/i);
  });
});

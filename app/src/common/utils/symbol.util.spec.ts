import { extractSymbols } from './symbol.util';

describe('extractSymbols', () => {
  it('extracts dollar-prefixed and uppercase symbols', () => {
    const text = 'Watching $AAPL and TSLA while BTC breaks out';
    const symbols = extractSymbols(text);

    expect(symbols).toEqual(expect.arrayContaining(['AAPL', 'TSLA', 'BTC']));
  });

  it('filters obvious stop words', () => {
    const text = 'THIS WILL HOLD FOR LONG';
    const symbols = extractSymbols(text);

    expect(symbols).toEqual([]);
  });

  it('uses allowlist to suppress uppercase noise', () => {
    const text = 'MARKET TODAY AAPL CEOS TALK ABOUT GDP';
    const symbols = extractSymbols(text, {
      allowedSymbols: new Set(['AAPL']),
    });

    expect(symbols).toEqual(['AAPL']);
  });
});

const STOP_WORDS = new Set([
  'THE',
  'AND',
  'FOR',
  'ARE',
  'THIS',
  'THAT',
  'WITH',
  'WILL',
  'FROM',
  'JUST',
  'YOUR',
  'HOLD',
  'LONG',
  'USA',
  'US',
  'CEO',
  'CEOS',
  'ETF',
  'GDP',
  'CPI',
  'PPI',
  'FOMC',
  'FED',
  'SEC',
]);

type ExtractSymbolOptions = {
  allowedSymbols?: Set<string>;
};

const HIGH_CONFIDENCE_SYMBOLS = new Set([
  'AAPL',
  'TSLA',
  'NVDA',
  'MSFT',
  'AMZN',
  'META',
  'GOOG',
  'SPY',
  'QQQ',
  'BTC',
  'ETH',
  'SOL',
  'XRP',
  'ADA',
  'DOGE',
]);

export function extractSymbols(
  text: string,
  options?: ExtractSymbolOptions,
): string[] {
  const found = new Set<string>();
  const allowedSymbols = options?.allowedSymbols;

  const dollarMatches = text.match(/\$[A-Z]{2,6}/g) ?? [];
  for (const match of dollarMatches) {
    found.add(match.slice(1));
  }

  const tokenMatches = text.match(/\b[A-Z]{2,6}\b/g) ?? [];
  for (const token of tokenMatches) {
    if (STOP_WORDS.has(token)) {
      continue;
    }

    if (allowedSymbols?.has(token) || HIGH_CONFIDENCE_SYMBOLS.has(token)) {
      found.add(token);
    }
  }

  return Array.from(found);
}

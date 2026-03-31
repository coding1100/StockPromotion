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
]);

export function extractSymbols(text: string): string[] {
  const found = new Set<string>();

  const dollarMatches = text.match(/\$[A-Z]{2,6}/g) ?? [];
  for (const match of dollarMatches) {
    found.add(match.slice(1));
  }

  const tokenMatches = text.match(/\b[A-Z]{2,6}\b/g) ?? [];
  for (const token of tokenMatches) {
    if (!STOP_WORDS.has(token)) {
      found.add(token);
    }
  }

  return Array.from(found);
}

export function normalizeContentForComparison(input: string): string {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9$\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function calculateContentSimilarity(
  left: string,
  right: string,
): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(input: string): string[] {
  const normalized = normalizeContentForComparison(input);
  if (!normalized) {
    return [];
  }

  return normalized
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

export type SupportedTrendWindowHours = 1 | 6 | 24;

const DEFAULT_WINDOWS: SupportedTrendWindowHours[] = [1, 6, 24];

export function parseTrendWindowHours(
  raw: string | undefined | null,
): SupportedTrendWindowHours[] {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_WINDOWS;
  }

  const parsed = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value): value is SupportedTrendWindowHours => {
      return value === 1 || value === 6 || value === 24;
    });

  if (parsed.length === 0) {
    return DEFAULT_WINDOWS;
  }

  return Array.from(new Set(parsed)).sort((a, b) => a - b);
}

export function toRedditTimeRange(maxWindowHours: number): string {
  if (maxWindowHours <= 1) {
    return 'hour';
  }
  if (maxWindowHours <= 24) {
    return 'day';
  }
  if (maxWindowHours <= 24 * 7) {
    return 'week';
  }
  if (maxWindowHours <= 24 * 31) {
    return 'month';
  }
  if (maxWindowHours <= 24 * 365) {
    return 'year';
  }
  return 'all';
}

export const MANDATORY_DISCLAIMER =
  'For informational purposes only. Not financial advice.';

export const HIGH_RISK_PATTERNS: RegExp[] = [
  /\bguaranteed?\b/i,
  /\b100%\b/i,
  /\bdouble your money\b/i,
  /\brisk[- ]?free\b/i,
  /\bno risk\b/i,
];

export const MEDIUM_RISK_PATTERNS: RegExp[] = [
  /\bbuy now\b/i,
  /\bstrong buy\b/i,
  /\bmoon\b/i,
  /\bto the moon\b/i,
  /\bwill explode\b/i,
];

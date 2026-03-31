export type GenerateDraftInput = {
  symbol: string;
  assetClass: 'EQUITY' | 'CRYPTO' | 'UNKNOWN';
  score: number;
  mentionCount: number;
  evidenceSummary: string[];
};

export type GeneratedDraft = {
  title: string;
  body: string;
  provider: 'openai' | 'anthropic' | 'fallback';
  model: string;
};

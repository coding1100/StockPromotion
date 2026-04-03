import {
  calculateContentSimilarity,
  normalizeContentForComparison,
} from './content-similarity.util';

describe('content-similarity util', () => {
  it('normalizes punctuation and URLs before comparison', () => {
    expect(
      normalizeContentForComparison(
        'AAPL jumps! Read more: https://example.com/abc',
      ),
    ).toBe('aapl jumps read more');
  });

  it('identifies near-duplicate content', () => {
    const similarity = calculateContentSimilarity(
      'AAPL trend watch: volume is rising and sentiment is improving.',
      'AAPL trend watch volume rising while sentiment improves today.',
    );

    expect(similarity).toBeGreaterThan(0.5);
  });
});

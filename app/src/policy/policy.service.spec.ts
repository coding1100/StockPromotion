import { PolicyService } from './policy.service';

describe('PolicyService', () => {
  it('adds disclaimer and flags risky language', () => {
    const service = new PolicyService();
    const result = service.evaluateDraft(
      'Buy now. Guaranteed upside with no risk.',
    );

    expect(result.body).toContain('For informational purposes only');
    expect(result.autoApproved).toBe(false);
    expect(result.flags.length).toBeGreaterThan(0);
  });
});

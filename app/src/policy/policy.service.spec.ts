import { PolicyService } from './policy.service';

describe('PolicyService', () => {
  it('does not append disclaimer and still flags risky language', () => {
    const service = new PolicyService();
    const result = service.evaluateDraft(
      'Buy now. Guaranteed upside with no risk.',
    );

    expect(result.body).toBe('Buy now. Guaranteed upside with no risk.');
    expect(result.autoApproved).toBe(false);
    expect(result.flags.length).toBeGreaterThan(0);
  });
});

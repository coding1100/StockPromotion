import { ManualUiLoginLimiter } from './manual-ui-login.limiter';

describe('ManualUiLoginLimiter', () => {
  const T0 = 1_700_000_000_000;

  it('is not locked out initially', () => {
    expect(new ManualUiLoginLimiter().isLockedOut(T0)).toBe(false);
  });

  it('locks out after 20 failures within the window', () => {
    const limiter = new ManualUiLoginLimiter();
    for (let i = 0; i < 19; i++) {
      limiter.registerFailure(T0 + i * 1000);
    }
    expect(limiter.isLockedOut(T0 + 19_000)).toBe(false);
    limiter.registerFailure(T0 + 19_000);
    expect(limiter.isLockedOut(T0 + 19_000)).toBe(true);
  });

  it('does not lock when failures are spread beyond the window', () => {
    const limiter = new ManualUiLoginLimiter();
    // 19 failures, then the window slides past them before the 20th.
    for (let i = 0; i < 19; i++) {
      limiter.registerFailure(T0 + i * 1000);
    }
    const later = T0 + 11 * 60 * 1000;
    limiter.registerFailure(later);
    expect(limiter.isLockedOut(later)).toBe(false);
  });

  it('lockout expires after the lockout period', () => {
    const limiter = new ManualUiLoginLimiter();
    for (let i = 0; i < 20; i++) {
      limiter.registerFailure(T0);
    }
    expect(limiter.isLockedOut(T0)).toBe(true);
    expect(limiter.isLockedOut(T0 + 15 * 60 * 1000 - 1)).toBe(true);
    expect(limiter.isLockedOut(T0 + 15 * 60 * 1000)).toBe(false);
  });

  it('successful login resets failures and lockout', () => {
    const limiter = new ManualUiLoginLimiter();
    for (let i = 0; i < 20; i++) {
      limiter.registerFailure(T0);
    }
    expect(limiter.isLockedOut(T0)).toBe(true);
    limiter.registerSuccess();
    expect(limiter.isLockedOut(T0)).toBe(false);
    expect(limiter.lockoutRemainingMs(T0)).toBe(0);
  });

  it('reports remaining lockout time', () => {
    const limiter = new ManualUiLoginLimiter();
    for (let i = 0; i < 20; i++) {
      limiter.registerFailure(T0);
    }
    expect(limiter.lockoutRemainingMs(T0)).toBe(15 * 60 * 1000);
    expect(limiter.lockoutRemainingMs(T0 + 60_000)).toBe(14 * 60 * 1000);
  });
});

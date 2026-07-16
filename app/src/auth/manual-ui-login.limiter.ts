import { Injectable } from '@nestjs/common';

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 20;
const LOCKOUT_MS = 15 * 60 * 1000;

// IP-independent failed-login lockout for the manual UI login.
// Per-IP throttling alone is bypassable via rotating source IPs (CGNAT, botnets).
@Injectable()
export class ManualUiLoginLimiter {
  private failures: number[] = [];
  private lockedUntil = 0;

  isLockedOut(now: number = Date.now()): boolean {
    return now < this.lockedUntil;
  }

  registerFailure(now: number = Date.now()): void {
    this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length >= MAX_FAILURES) {
      this.lockedUntil = now + LOCKOUT_MS;
      this.failures = [];
    }
  }

  registerSuccess(): void {
    this.failures = [];
    this.lockedUntil = 0;
  }

  lockoutRemainingMs(now: number = Date.now()): number {
    return Math.max(0, this.lockedUntil - now);
  }
}

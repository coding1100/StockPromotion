import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

export const MANUAL_UI_SESSION_COOKIE = 'manual_ui_session';

// Issues and verifies HMAC-signed session tokens for the manual UI login gate.
@Injectable()
export class ManualUiSessionService {
  private readonly secret: string;

  constructor(private readonly configService: ConfigService) {
    const configured =
      this.configService.get<string>('MANUAL_UI_SESSION_SECRET')?.trim() ?? '';
    // Fallback: per-boot random secret (sessions reset on restart).
    this.secret = configured || randomBytes(32).toString('hex');
  }

  isConfigured(): boolean {
    return this.username().length > 0 && this.password().length > 0;
  }

  validateCredentials(username: string, password: string): boolean {
    if (!this.isConfigured()) {
      return false;
    }
    const userOk = this.constantTimeCompare(username, this.username());
    const passOk = this.constantTimeCompare(password, this.password());
    return userOk && passOk;
  }

  issueToken(): string {
    const ttlHours = Number(
      this.configService.get<number>('MANUAL_UI_SESSION_TTL_HOURS') ?? 168,
    );
    const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;
    return `${expiresAt}.${this.sign(String(expiresAt))}`;
  }

  verifyToken(token: string | undefined): boolean {
    if (!token) {
      return false;
    }
    const separator = token.indexOf('.');
    if (separator <= 0) {
      return false;
    }
    const expiresAtRaw = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expiresAt = Number(expiresAtRaw);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      return false;
    }
    return this.constantTimeCompare(signature, this.sign(expiresAtRaw));
  }

  sessionMaxAgeSeconds(): number {
    const ttlHours = Number(
      this.configService.get<number>('MANUAL_UI_SESSION_TTL_HOURS') ?? 168,
    );
    return Math.floor(ttlHours * 60 * 60);
  }

  private username(): string {
    return this.configService.get<string>('MANUAL_UI_USERNAME')?.trim() ?? '';
  }

  private password(): string {
    return this.configService.get<string>('MANUAL_UI_PASSWORD') ?? '';
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret)
      .update(`manual-ui-session:${payload}`)
      .digest('hex');
  }

  private constantTimeCompare(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }
}

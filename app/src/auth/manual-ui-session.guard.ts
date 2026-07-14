import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import {
  MANUAL_UI_SESSION_COOKIE,
  ManualUiSessionService,
} from './manual-ui-session.service';

// Gates manual UI routes behind the session cookie issued by the login page.
@Injectable()
export class ManualUiSessionGuard implements CanActivate {
  constructor(
    private readonly sessionService: ManualUiSessionService,
    private readonly configService: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const nodeEnv = this.configService.get<string>('NODE_ENV') ?? 'development';

    if (!this.sessionService.isConfigured()) {
      if (nodeEnv === 'production') {
        throw new ServiceUnavailableException(
          'MANUAL_UI_USERNAME and MANUAL_UI_PASSWORD are required in production',
        );
      }
      return true;
    }

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const token = parseCookie(request.headers.cookie)[MANUAL_UI_SESSION_COOKIE];

    if (this.sessionService.verifyToken(token)) {
      return true;
    }

    // Browser page loads get the login page; API calls get a 401.
    const acceptsHtml = String(request.headers.accept ?? '').includes(
      'text/html',
    );
    if (request.method === 'GET' && acceptsHtml) {
      const response = http.getResponse<Response>();
      response.redirect(302, '/api/manual-ui/login');
      return false;
    }

    throw new UnauthorizedException('Manual UI session required');
  }
}

// Minimal cookie header parser (no cookie-parser dependency).
export function parseCookie(
  header: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) {
      continue;
    }
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
  }
  return cookies;
}

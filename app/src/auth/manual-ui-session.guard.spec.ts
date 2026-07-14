import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManualUiSessionGuard } from './manual-ui-session.guard';
import {
  MANUAL_UI_SESSION_COOKIE,
  ManualUiSessionService,
} from './manual-ui-session.service';

function buildGuard(env: Record<string, unknown>): {
  guard: ManualUiSessionGuard;
  service: ManualUiSessionService;
} {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  const service = new ManualUiSessionService(config);
  return { guard: new ManualUiSessionGuard(service, config), service };
}

function buildContext(request: {
  method: string;
  headers: Record<string, string | undefined>;
}): { context: ExecutionContext; redirect: jest.Mock } {
  const redirect = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ redirect }),
    }),
  } as unknown as ExecutionContext;
  return { context, redirect };
}

describe('ManualUiSessionGuard', () => {
  const baseEnv = {
    NODE_ENV: 'production',
    MANUAL_UI_USERNAME: 'admin',
    MANUAL_UI_PASSWORD: 'secret-pass',
    MANUAL_UI_SESSION_SECRET: 'test-secret',
    MANUAL_UI_SESSION_TTL_HOURS: 1,
  };

  it('allows requests with a valid session cookie', () => {
    const { guard, service } = buildGuard(baseEnv);
    const { context } = buildContext({
      method: 'GET',
      headers: {
        cookie: `${MANUAL_UI_SESSION_COOKIE}=${service.issueToken()}`,
        accept: 'text/html',
      },
    });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('redirects unauthenticated browser page loads to the login page', () => {
    const { guard } = buildGuard(baseEnv);
    const { context, redirect } = buildContext({
      method: 'GET',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(guard.canActivate(context)).toBe(false);
    expect(redirect).toHaveBeenCalledWith(302, '/api/manual-ui/login');
  });

  it('throws 401 for unauthenticated API calls', () => {
    const { guard } = buildGuard(baseEnv);
    const { context } = buildContext({
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects invalid cookies', () => {
    const { guard } = buildGuard(baseEnv);
    const { context } = buildContext({
      method: 'POST',
      headers: { cookie: `${MANUAL_UI_SESSION_COOKIE}=123.deadbeef` },
    });
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('fails closed in production when credentials are missing', () => {
    const { guard } = buildGuard({
      ...baseEnv,
      MANUAL_UI_USERNAME: '',
      MANUAL_UI_PASSWORD: '',
    });
    const { context } = buildContext({ method: 'GET', headers: {} });
    expect(() => guard.canActivate(context)).toThrow(
      'MANUAL_UI_USERNAME and MANUAL_UI_PASSWORD are required in production',
    );
  });

  it('allows access in development when credentials are missing', () => {
    const { guard } = buildGuard({
      ...baseEnv,
      NODE_ENV: 'development',
      MANUAL_UI_USERNAME: '',
      MANUAL_UI_PASSWORD: '',
    });
    const { context } = buildContext({ method: 'GET', headers: {} });
    expect(guard.canActivate(context)).toBe(true);
  });
});

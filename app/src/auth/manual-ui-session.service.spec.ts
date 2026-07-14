import { ConfigService } from '@nestjs/config';
import { ManualUiSessionService } from './manual-ui-session.service';
import { parseCookie } from './manual-ui-session.guard';

function buildService(env: Record<string, unknown>): ManualUiSessionService {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new ManualUiSessionService(config);
}

describe('ManualUiSessionService', () => {
  const baseEnv = {
    MANUAL_UI_USERNAME: 'admin',
    MANUAL_UI_PASSWORD: 'secret-pass',
    MANUAL_UI_SESSION_SECRET: 'test-secret',
    MANUAL_UI_SESSION_TTL_HOURS: 1,
  };

  it('reports configured only when both credentials are set', () => {
    expect(buildService(baseEnv).isConfigured()).toBe(true);
    expect(
      buildService({ ...baseEnv, MANUAL_UI_PASSWORD: '' }).isConfigured(),
    ).toBe(false);
    expect(
      buildService({
        ...baseEnv,
        MANUAL_UI_USERNAME: undefined,
      }).isConfigured(),
    ).toBe(false);
  });

  it('validates correct credentials and rejects wrong ones', () => {
    const service = buildService(baseEnv);
    expect(service.validateCredentials('admin', 'secret-pass')).toBe(true);
    expect(service.validateCredentials('admin', 'wrong')).toBe(false);
    expect(service.validateCredentials('other', 'secret-pass')).toBe(false);
    expect(service.validateCredentials('', '')).toBe(false);
  });

  it('rejects all credentials when not configured', () => {
    const service = buildService({
      ...baseEnv,
      MANUAL_UI_USERNAME: '',
      MANUAL_UI_PASSWORD: '',
    });
    expect(service.validateCredentials('', '')).toBe(false);
  });

  it('round-trips issued tokens', () => {
    const service = buildService(baseEnv);
    expect(service.verifyToken(service.issueToken())).toBe(true);
  });

  it('rejects tampered, malformed, and missing tokens', () => {
    const service = buildService(baseEnv);
    const token = service.issueToken();
    expect(service.verifyToken(`${token}x`)).toBe(false);
    expect(service.verifyToken(`9999999999999.${token.split('.')[1]}`)).toBe(
      false,
    );
    expect(service.verifyToken('garbage')).toBe(false);
    expect(service.verifyToken('')).toBe(false);
    expect(service.verifyToken(undefined)).toBe(false);
  });

  it('rejects expired tokens', () => {
    const service = buildService(baseEnv);
    const token = service.issueToken();
    const expiresAt = Number(token.split('.')[0]);
    jest.useFakeTimers().setSystemTime(expiresAt + 1000);
    expect(service.verifyToken(token)).toBe(false);
    jest.useRealTimers();
  });

  it('rejects tokens signed with a different secret', () => {
    const issuer = buildService(baseEnv);
    const verifier = buildService({
      ...baseEnv,
      MANUAL_UI_SESSION_SECRET: 'other-secret',
    });
    expect(verifier.verifyToken(issuer.issueToken())).toBe(false);
  });
});

describe('parseCookie', () => {
  it('parses multiple cookies', () => {
    expect(parseCookie('a=1; b=2;c=3')).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('handles missing header and malformed pairs', () => {
    expect(parseCookie(undefined)).toEqual({});
    expect(parseCookie('')).toEqual({});
    expect(parseCookie('noequals; =empty')).toEqual({});
  });

  it('decodes encoded values and keeps raw value on bad encoding', () => {
    expect(parseCookie('a=hello%20world')).toEqual({ a: 'hello world' });
    expect(parseCookie('a=%E0%A4%A')).toEqual({ a: '%E0%A4%A' });
  });
});

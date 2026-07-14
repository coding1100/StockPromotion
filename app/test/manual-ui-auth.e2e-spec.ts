import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ManualUiSessionGuard } from '../src/auth/manual-ui-session.guard';
import { ManualUiSessionService } from '../src/auth/manual-ui-session.service';
import { ManualUiAuthController } from '../src/manual-ui/manual-ui-auth.controller';
import { ManualUiController } from '../src/manual-ui/manual-ui.controller';
import { PublishingService } from '../src/publishing/publishing.service';

describe('Manual UI auth gate (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              NODE_ENV: 'production',
              MANUAL_UI_USERNAME: 'admin',
              MANUAL_UI_PASSWORD: 'test-pass',
              MANUAL_UI_SESSION_SECRET: 'e2e-secret',
              MANUAL_UI_SESSION_TTL_HOURS: 1,
            }),
          ],
        }),
      ],
      controllers: [ManualUiController, ManualUiAuthController],
      providers: [
        ManualUiSessionService,
        ManualUiSessionGuard,
        { provide: PublishingService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('redirects unauthenticated browser access to the login page', async () => {
    await request(app.getHttpServer())
      .get('/api/manual-ui')
      .set('Accept', 'text/html')
      .expect(302)
      .expect('Location', '/api/manual-ui/login');
  });

  it('returns 401 for unauthenticated API calls', async () => {
    await request(app.getHttpServer()).get('/api/manual-ui/accounts').expect(401);
  });

  it('serves the login page without a session', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/manual-ui/login')
      .expect(200);
    expect(res.text).toContain('Sign in');
  });

  it('rejects invalid credentials with an error redirect and no cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/manual-ui/login')
      .type('form')
      .send({ username: 'admin', password: 'wrong' })
      .expect(303)
      .expect('Location', '/api/manual-ui/login?error=1');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('logs in with valid credentials and grants UI access via cookie', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/manual-ui/login')
      .type('form')
      .send({ username: 'admin', password: 'test-pass' })
      .expect(303)
      .expect('Location', '/api/manual-ui');

    const setCookie = login.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookie = String(setCookie[0]);
    expect(cookie).toContain('manual_ui_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');

    const page = await request(app.getHttpServer())
      .get('/api/manual-ui')
      .set('Cookie', cookie.split(';')[0])
      .expect(200);
    expect(page.text).toContain('Manual Publisher');
  });

  it('redirects an authenticated user away from the login page', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/manual-ui/login')
      .type('form')
      .send({ username: 'admin', password: 'test-pass' });
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0];

    await request(app.getHttpServer())
      .get('/api/manual-ui/login')
      .set('Cookie', cookie)
      .expect(302)
      .expect('Location', '/api/manual-ui');
  });

  it('logout clears the session cookie', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/manual-ui/logout')
      .expect(303)
      .expect('Location', '/api/manual-ui/login');
    expect(String(res.headers['set-cookie'][0])).toContain(
      'manual_ui_session=;',
    );
  });
});

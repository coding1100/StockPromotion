import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { parseCookie } from '../auth/manual-ui-session.guard';
import {
  MANUAL_UI_SESSION_COOKIE,
  ManualUiSessionService,
} from '../auth/manual-ui-session.service';

type LoginBody = {
  username?: string;
  password?: string;
};

@Controller('manual-ui')
@Public()
export class ManualUiAuthController {
  constructor(private readonly sessionService: ManualUiSessionService) {}

  @Get('login')
  loginPage(
    @Req() req: Request,
    @Res() res: Response,
    @Query('error') error?: string,
  ): void {
    const token = parseCookie(req.headers.cookie)[MANUAL_UI_SESSION_COOKIE];
    if (this.sessionService.verifyToken(token)) {
      res.redirect(302, '/api/manual-ui');
      return;
    }
    res
      .status(200)
      .type('text/html; charset=utf-8')
      .send(this.renderLoginPage(error === '1'));
  }

  @Post('login')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  login(@Body() body: LoginBody, @Res() res: Response): void {
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');

    if (!this.sessionService.validateCredentials(username, password)) {
      res.redirect(303, '/api/manual-ui/login?error=1');
      return;
    }

    res.cookie(MANUAL_UI_SESSION_COOKIE, this.sessionService.issueToken(), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: this.sessionService.sessionMaxAgeSeconds() * 1000,
    });
    res.redirect(303, '/api/manual-ui');
  }

  @Post('logout')
  logout(@Res() res: Response): void {
    res.clearCookie(MANUAL_UI_SESSION_COOKIE, { path: '/' });
    res.redirect(303, '/api/manual-ui/login');
  }

  private renderLoginPage(showError: boolean): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Sign in — Stock Promotion</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#f1f5f9;--surf:#fff;--bdr:#e2e8f0;--tx:#0f172a;--tx2:#475569;
      --tx3:#94a3b8;--ac:#6366f1;--ac-dk:#4f46e5;--err:#dc2626;
      --r:12px;--sh:0 1px 3px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.05)}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:var(--bg);color:var(--tx);font-size:14px;line-height:1.5;
      min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:var(--surf);border:1px solid var(--bdr);border-radius:var(--r);
      box-shadow:var(--sh);width:100%;max-width:380px;padding:32px}
    .logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;
      margin-bottom:6px}
    .logo-badge{width:34px;height:34px;border-radius:9px;background:#eef2ff;
      color:var(--ac);display:flex;align-items:center;justify-content:center;
      font-size:16px;flex-shrink:0}
    .sub{font-size:13px;color:var(--tx3);margin-bottom:24px}
    label{display:block;margin-bottom:6px;font-size:11px;font-weight:700;
      color:var(--tx2);text-transform:uppercase;letter-spacing:.05em}
    .field{margin-bottom:16px}
    input{width:100%;border:1.5px solid var(--bdr);border-radius:8px;
      padding:10px 12px;font-size:14px;font-family:inherit;color:var(--tx);
      background:var(--surf);transition:border-color .15s,box-shadow .15s;outline:none}
    input:focus{border-color:var(--ac);box-shadow:0 0 0 3px rgba(99,102,241,.12)}
    button{width:100%;border:none;border-radius:8px;padding:11px 0;margin-top:6px;
      background:var(--ac);color:#fff;font-size:14px;font-weight:700;font-family:inherit;
      cursor:pointer;transition:background .15s}
    button:hover{background:var(--ac-dk)}
    .error{background:#fef2f2;border:1px solid #fecaca;color:var(--err);
      border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:16px}
  </style>
</head>
<body>
  <main class="card">
    <div class="logo"><span class="logo-badge">&#128640;</span> Stock Promotion</div>
    <p class="sub">Sign in to access the manual publisher.</p>
    ${showError ? '<div class="error">Invalid username or password.</div>' : ''}
    <form method="post" action="/api/manual-ui/login" autocomplete="off">
      <div class="field">
        <label for="username">Username</label>
        <input id="username" name="username" type="text" required autofocus autocomplete="username"/>
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password"/>
      </div>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`;
  }
}

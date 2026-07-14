import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { ManualUiSessionGuard } from '../auth/manual-ui-session.guard';
import { PublishingService } from '../publishing/publishing.service';
import { AccountStatus } from '@prisma/client';

type ManualUiPublishBody = {
  body?: string;
  platforms?: string[];
  discordServerUrl?: string;
  discordServerUrls?: string[];
  discordEmail?: string;
  discordPassword?: string;
  stocktwitsSymbol?: string;
  stocktwitsAccountHandle?: string;
  stocktwitsUsername?: string;
  stocktwitsPassword?: string;
  stocktwitsProxy?: string;
  stocktwitsItems?: Array<{
    symbol?: string;
    body?: string;
  }>;
};

type ManualUiProxyTestBody = {
  stocktwitsProxy?: string;
};

type UpsertDlvritAccountBody = {
  accountHandle: string;
  dlvritAccountId: number;
};

@Controller('manual-ui')
@Public()
@UseGuards(ManualUiSessionGuard)
export class ManualUiController {
  private lastStocktwitsPostAt: Date | null = null;
  private readonly STOCKTWITS_COOLDOWN_MS = 90_000;

  constructor(
    private readonly publishingService: PublishingService,
  ) {}

  @Get('st-cooldown')
  getStCooldown(): Record<string, unknown> {
    if (!this.lastStocktwitsPostAt) return { remainingMs: 0 };
    const elapsed = Date.now() - this.lastStocktwitsPostAt.getTime();
    const remaining = Math.max(0, this.STOCKTWITS_COOLDOWN_MS - elapsed);
    return { remainingMs: remaining };
  }

  // ── dlvr.it Account Management API ─────────────────────────────────────────

  @Get('accounts')
  async listAccounts(): Promise<Record<string, unknown>> {
    const accounts = await this.publishingService.listDlvritAccounts();
    return { accounts };
  }

  @Post('accounts')
  async upsertAccount(
    @Body() body: UpsertDlvritAccountBody,
  ): Promise<Record<string, unknown>> {
    if (!body.accountHandle || !body.dlvritAccountId) {
      return { success: false, error: 'accountHandle and dlvritAccountId are required.' };
    }
    const account = await this.publishingService.upsertDlvritAccount(
      body.accountHandle.trim(),
      Number(body.dlvritAccountId),
    );
    return { success: true, account };
  }

  @Put('accounts/:id/disable')
  async disableAccount(
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    await this.publishingService.setDlvritAccountStatus(id, AccountStatus.DISABLED);
    return { success: true };
  }

  @Put('accounts/:id/enable')
  async enableAccount(
    @Param('id') id: string,
  ): Promise<Record<string, unknown>> {
    await this.publishingService.setDlvritAccountStatus(id, AccountStatus.ACTIVE);
    return { success: true };
  }

  @Delete('accounts')
  async deleteAccounts(
    @Body() body: { ids: string[] },
  ): Promise<Record<string, unknown>> {
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return { success: false, error: 'ids array is required.' };
    }
    const deleted = await this.publishingService.deleteDlvritAccounts(body.ids);
    return { success: true, deleted };
  }

  @Post('dlvrit-session/refresh')
  async refreshDlvritSession(): Promise<Record<string, unknown>> {
    try {
      await this.publishingService.refreshDlvritSession();
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  @Get('dlvrit-connected-accounts')
  async listDlvritConnectedAccounts(): Promise<Record<string, unknown>> {
    try {
      const accounts = await this.publishingService.listDlvritConnectedAccounts();
      return { success: true, accounts };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  @Get('dlvrit-connected-accounts/raw')
  async listDlvritConnectedAccountsRaw(): Promise<unknown> {
    return this.publishingService.listDlvritConnectedAccountsRaw();
  }

  // ── UI ───────────────────────────────────────────────────────────────────────

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  render(): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Publisher — Stock Promotion</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --st:#10b981;--st-dk:#059669;
      --dc:#5865F2;--dc-dk:#4752c4;
      --bg:#f1f5f9;--surf:#fff;--bdr:#e2e8f0;
      --tx:#0f172a;--tx2:#475569;--tx3:#94a3b8;
      --r:12px;--sh:0 1px 3px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.05);
    }
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      background:var(--bg);color:var(--tx);font-size:14px;line-height:1.5;min-height:100vh}

    /* ── Header ── */
    .app-bar{background:var(--surf);border-bottom:1px solid var(--bdr);
      display:flex;align-items:center;height:58px;padding:0 28px;gap:12px;
      position:sticky;top:0;z-index:60}
    .app-logo{display:flex;align-items:center;gap:10px;font-weight:700;font-size:15px;
      color:var(--tx);text-decoration:none}
    .app-bar-right{margin-left:auto;font-size:12px;color:var(--tx3)}

    /* ── Tabs ── */
    .tab-nav{background:var(--surf);border-bottom:1px solid var(--bdr);
      display:flex;padding:0 28px;gap:2px}
    .tab-btn{display:inline-flex;align-items:center;gap:8px;
      padding:13px 20px;border:none;background:none;cursor:pointer;
      font-size:13px;font-weight:600;color:var(--tx2);font-family:inherit;
      border-bottom:3px solid transparent;margin-bottom:-1px;
      transition:color .15s,border-color .15s;white-space:nowrap}
    .tab-btn:hover{color:var(--tx)}
    .tab-btn.active[data-tab="stocktwits"]{color:var(--st);border-bottom-color:var(--st)}
    .tab-btn.active[data-tab="discord"]{color:var(--dc);border-bottom-color:var(--dc)}

    /* ── Page ── */
    .page{max-width:900px;margin:0 auto;padding:28px 20px 80px}
    .tab-pane{display:none}.tab-pane.on{display:block}
    .stack>*+*{margin-top:20px}

    /* ── Card ── */
    .card{background:var(--surf);border:1px solid var(--bdr);border-radius:var(--r);
      box-shadow:var(--sh);overflow:hidden}
    .card-head{display:flex;align-items:center;justify-content:space-between;
      padding:18px 24px;border-bottom:1px solid var(--bdr)}
    .card-title{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700}
    .card-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;
      justify-content:center;flex-shrink:0}
    .ic-st{background:#ecfdf5;color:#059669}.ic-dc{background:#eef2ff;color:#5865F2}
    .card-sub{font-size:12px;color:var(--tx3);margin-top:2px;font-weight:400}
    .card-body{padding:24px}

    /* ── Fields ── */
    .field{margin-top:18px}.field:first-child{margin-top:0}
    .row2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px}
    .row2:first-child{margin-top:0}
    label{display:block;margin-bottom:6px;font-size:11px;font-weight:700;
      color:var(--tx2);text-transform:uppercase;letter-spacing:.05em}
    .lbl-opt{font-size:11px;font-weight:400;color:var(--tx3);
      text-transform:none;letter-spacing:0;margin-left:6px}
    .pfx-wrap{position:relative}
    .pfx{position:absolute;left:11px;top:50%;transform:translateY(-50%);
      color:var(--tx3);font-weight:700;pointer-events:none}
    input[type=text],input[type=email],input[type=password],
    input[type=number],select,textarea{
      width:100%;border:1.5px solid var(--bdr);border-radius:8px;
      padding:10px 12px;font-size:14px;font-family:inherit;color:var(--tx);
      background:var(--surf);transition:border-color .15s,box-shadow .15s;outline:none}
    .has-pfx{padding-left:26px}
    input:focus,select:focus,textarea:focus{
      border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.12)}
    textarea{min-height:120px;resize:vertical;line-height:1.6}
    textarea.tall{min-height:160px}
    .hint{margin-top:6px;font-size:12px;color:var(--tx3);line-height:1.6}
    .char-ct{float:right;font-size:11px;color:var(--tx3);margin-top:4px}

    /* ── Sep ── */
    .sep{display:flex;align-items:center;gap:10px;margin:22px 0;
      font-size:11px;font-weight:700;color:var(--tx3);text-transform:uppercase;letter-spacing:.06em}
    .sep::before,.sep::after{content:'';flex:1;height:1px;background:var(--bdr)}

    /* ── Creds strip ── */
    .creds{background:#fafafa;border:1.5px solid var(--bdr);border-radius:10px;
      padding:18px;margin-top:18px}
    .creds-hd{font-size:11px;font-weight:700;color:var(--tx2);
      text-transform:uppercase;letter-spacing:.05em;margin-bottom:14px;
      display:flex;align-items:center;gap:8px}
    .creds-hd em{font-size:11px;font-weight:400;color:var(--tx3);
      text-transform:none;letter-spacing:0;font-style:normal}

    /* ── Buttons ── */
    .btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:8px;
      font-size:13px;font-weight:600;font-family:inherit;padding:9px 16px;
      cursor:pointer;transition:opacity .15s,transform .1s;white-space:nowrap}
    .btn:active{transform:scale(.97)}.btn:disabled{opacity:.5;cursor:not-allowed}
    .btn:hover:not(:disabled){opacity:.87}
    .btn-st{background:var(--st);color:#fff}
    .btn-dc{background:var(--dc);color:#fff}
    .btn-ok{background:#16a34a;color:#fff}
    .btn-del{background:#ef4444;color:#fff}
    .btn-blue{background:#2563eb;color:#fff}
    .btn-ghost{background:var(--surf);color:var(--tx2);border:1.5px solid var(--bdr)}
    .btn-ghost:hover:not(:disabled){background:#f8fafc;opacity:1}
    .btn-vnc.live{border-color:var(--dc);color:var(--dc);
      animation:vncpulse 1.6s ease-in-out infinite}
    @keyframes vncpulse{
      0%,100%{box-shadow:0 0 0 0 rgba(88,101,242,.35)}
      50%{box-shadow:0 0 0 6px rgba(88,101,242,0)}
    }
    .btn-sm{padding:6px 12px;font-size:12px;border-radius:6px}
    .btn-lg{padding:11px 22px;font-size:14px}
    .spin{width:14px;height:14px;border-radius:50%;
      border:2px solid rgba(255,255,255,.3);border-top-color:#fff;
      animation:spin .6s linear infinite;flex-shrink:0}
    @keyframes spin{to{transform:rotate(360deg)}}

    /* ── Publish footer ── */
    .pub-foot{display:flex;align-items:center;gap:14px;
      padding:18px 24px;border-top:1px solid var(--bdr);background:#fafafa}
    .pub-status{font-size:13px;color:var(--tx3);flex:1}

    /* ── Result ── */
    .res-wrap{border-top:1px solid var(--bdr)}
    .res-head{display:flex;align-items:center;justify-content:space-between;
      padding:10px 20px;background:#0f172a;cursor:pointer;user-select:none}
    .res-head span{font-size:12px;font-weight:600;color:#64748b}
    .res-head .res-close{font-size:12px;color:#475569;
      background:none;border:none;cursor:pointer;padding:2px 8px;
      border-radius:4px;color:#64748b;font-family:inherit}
    .res-head .res-close:hover{background:#1e293b;color:#94a3b8}
    pre.res-body{background:#0f172a;color:#e2e8f0;padding:12px 20px 18px;
      font-size:12px;line-height:1.7;font-family:'Menlo','Consolas',monospace;
      white-space:pre-wrap;word-break:break-word;max-height:360px;overflow-y:auto}

    /* ── Bulk bar ── */
    .bulk-bar{display:none;align-items:center;gap:12px;
      padding:10px 24px;font-size:13px;color:#1d4ed8;
      background:#eff6ff;border-bottom:1px solid #bfdbfe}
    .bulk-bar.on{display:flex}
    .bulk-lbl{flex:1;font-weight:600}

    /* ── Table ── */
    .acc-table{width:100%;border-collapse:collapse;font-size:13px}
    .acc-table th{text-align:left;padding:10px 16px;
      background:#f8fafc;border-bottom:1px solid var(--bdr);
      font-size:11px;font-weight:700;color:var(--tx3);
      text-transform:uppercase;letter-spacing:.05em}
    .acc-table th:first-child{width:40px}
    .acc-table td{padding:13px 16px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
    .acc-table tr:last-child td{border-bottom:none}
    .acc-table tr.sel td{background:#eff6ff}
    .acc-table tr:hover:not(.sel) td{background:#f8fafc}
    .acc-table input[type=checkbox]{width:15px;height:15px;cursor:pointer;accent-color:#6366f1}
    .act-row{display:flex;gap:6px}

    /* ── Badges ── */
    .badge{display:inline-flex;align-items:center;gap:5px;
      padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.03em}
    .badge::before{content:'';width:6px;height:6px;border-radius:50%;
      background:currentColor;opacity:.75}
    .b-ok{background:#dcfce7;color:#15803d}
    .b-off{background:#fee2e2;color:#b91c1c}
    .b-warn{background:#fef9c3;color:#854d0e}

    /* ── Empty ── */
    .empty{text-align:center;padding:48px 16px;color:var(--tx3)}
    .empty-ico{font-size:30px;margin-bottom:10px;opacity:.45}
    .empty p{font-size:13px;line-height:1.7}

    /* ── Modal ── */
    .overlay{display:none;position:fixed;inset:0;
      background:rgba(15,23,42,.5);z-index:200;
      align-items:center;justify-content:center;padding:20px}
    .overlay.on{display:flex}
    .modal{background:var(--surf);border-radius:14px;width:100%;max-width:460px;
      box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;
      animation:mIn .18s ease}
    @keyframes mIn{from{transform:translateY(-12px) scale(.98);opacity:0}
      to{transform:none;opacity:1}}
    .modal-hd{display:flex;align-items:center;justify-content:space-between;
      padding:18px 22px;border-bottom:1px solid var(--bdr)}
    .modal-hd h2{font-size:15px;font-weight:700}
    .modal-x{width:28px;height:28px;border-radius:6px;border:none;background:none;
      cursor:pointer;color:var(--tx3);font-size:18px;display:flex;
      align-items:center;justify-content:center;transition:background .15s}
    .modal-x:hover{background:#f1f5f9}
    .modal-bd{padding:22px}
    .modal-ft{display:flex;gap:10px;justify-content:flex-end;
      padding:14px 22px;border-top:1px solid var(--bdr);background:#f8fafc}
    .modal-err{margin-top:12px;padding:10px 12px;
      background:#fef2f2;border:1px solid #fecaca;
      border-radius:8px;color:#b91c1c;font-size:13px;display:none}

    /* ── Toast ── */
    #toasts{position:fixed;bottom:22px;right:22px;z-index:999;
      display:flex;flex-direction:column;gap:10px;pointer-events:none}
    .toast{display:flex;align-items:center;gap:10px;padding:11px 16px;
      border-radius:10px;font-size:13px;font-weight:500;max-width:340px;
      box-shadow:0 4px 20px rgba(0,0,0,.15);pointer-events:all;
      transform:translateX(120%);transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
    .toast.show{transform:none}
    .t-ok{background:#052e16;color:#dcfce7}
    .t-err{background:#450a0a;color:#fee2e2}
    .t-info{background:#0f172a;color:#e2e8f0}

    /* ── Cooldown bar ── */
    .cooldown-wrap{padding:14px 24px;border-top:1px solid var(--bdr);
      background:#f0fdf4;display:none}
    .cooldown-wrap.on{display:block}
    .cooldown-hd{display:flex;justify-content:space-between;align-items:center;
      margin-bottom:8px;font-size:12px;font-weight:600;color:#166534}
    .cooldown-hd-icon{display:flex;align-items:center;gap:6px}
    .cooldown-track{height:7px;background:#dcfce7;border-radius:4px;overflow:hidden}
    .cooldown-fill{height:100%;background:linear-gradient(90deg,#10b981,#34d399);
      border-radius:4px;transition:width .3s linear}

    @media(max-width:640px){
      .app-bar,.tab-nav{padding:0 14px}
      .page{padding:16px 10px 60px}
      .card-head,.card-body,.pub-foot{padding:14px}
      .row2{grid-template-columns:1fr}
      .acc-table th:nth-child(3),.acc-table td:nth-child(3){display:none}
    }
  </style>
</head>
<body>

<!-- ── Header ───────────────────────────────────────────────── -->
<header class="app-bar">
  <a class="app-logo" href="#">
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect width="28" height="28" rx="7" fill="#0f172a"/>
      <path d="M7 20L13 9l6 11" stroke="#e2e8f0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9.5 16h7" stroke="#10b981" stroke-width="2.2" stroke-linecap="round"/>
    </svg>
    Stock Promotion
  </a>
  <span class="app-bar-right">Manual Publisher</span>
  <form method="post" action="/api/manual-ui/logout" style="margin:0">
    <button type="submit" style="border:1px solid var(--bdr);background:none;border-radius:8px;
      padding:6px 14px;font-size:12px;font-weight:600;color:var(--tx2);cursor:pointer;font-family:inherit">
      Sign out
    </button>
  </form>
</header>

<!-- ── Tab nav ───────────────────────────────────────────────── -->
<nav class="tab-nav">
  <button class="tab-btn active" data-tab="stocktwits" onclick="switchTab('stocktwits')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
    </svg>
    StockTwits
  </button>
  <button class="tab-btn" data-tab="discord" onclick="switchTab('discord')">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.1.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
    </svg>
    Discord
  </button>
</nav>

<main class="page">

  <!-- ══════════════════════════ STOCKTWITS TAB ══════════════════════════ -->
  <div id="tab-stocktwits" class="tab-pane on">
    <div class="stack">

      <!-- Compose card -->
      <div class="card">
        <div class="card-head">
          <div class="card-title">
            <div class="card-icon ic-st">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>
              </svg>
            </div>
            <div>
              Compose Post
              <div class="card-sub">Publish to StockTwits symbol streams via dlvr.it</div>
            </div>
          </div>
        </div>

        <div class="card-body">
          <div class="field">
            <label for="st-body">Post Body <span class="lbl-opt">optional in batch mode</span></label>
            <textarea id="st-body" placeholder="Write your market insight here…" oninput="charCount('st-body','st-cc',280)"></textarea>
            <div><span id="st-cc" class="char-ct">0 / 280</span></div>
          </div>

          <div class="row2">
            <div>
              <label for="st-symbol">Symbol</label>
              <div class="pfx-wrap">
                <span class="pfx">$</span>
                <input id="st-symbol" type="text" class="has-pfx" placeholder="AAPL"/>
              </div>
            </div>
            <div>
              <label for="st-account">Account</label>
              <select id="st-account">
                <option value="">— Auto-select eligible account —</option>
              </select>
              <div class="hint">Auto-rotates through active accounts.</div>
            </div>
          </div>

          <div class="sep">Batch Mode</div>

          <div class="field" style="margin-top:0">
            <label for="st-batch">Multi-Symbol Batch <span class="lbl-opt">overrides symbol field above</span></label>
            <textarea id="st-batch" class="tall" placeholder="AAPL | Apple looking strong today&#10;TSLA | Tesla breaking out&#10;NVDA | GPU demand remains high"></textarea>
            <div class="hint">One post per line &nbsp;·&nbsp; Format: <code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:11px;">SYMBOL | post text</code></div>
          </div>
        </div>

        <div class="pub-foot">
          <button id="st-btn" class="btn btn-st btn-lg" onclick="pubST()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
            Publish to StockTwits
          </button>
          <span id="st-status" class="pub-status"></span>
        </div>

        <div id="st-cooldown" class="cooldown-wrap">
          <div class="cooldown-hd">
            <span class="cooldown-hd-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#166534" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              StockTwits rate limit — cooldown active
            </span>
            <span id="st-cooldown-lbl">90s remaining</span>
          </div>
          <div class="cooldown-track">
            <div id="st-cooldown-fill" class="cooldown-fill" style="width:100%"></div>
          </div>
        </div>

        <div id="st-res-wrap" class="res-wrap" style="display:none">
          <div class="res-head" onclick="toggleRes('st')">
            <span>&#9660; Result</span>
            <button class="res-close" onclick="event.stopPropagation();hideRes('st')">&#x2715; Close</button>
          </div>
          <pre id="st-res" class="res-body"></pre>
        </div>
      </div>

      <!-- Account management card -->
      <div class="card">
        <div class="card-head">
          <div class="card-title">
            <div class="card-icon ic-st">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
            </div>
            <div>
              dlvr.it Accounts
              <div class="card-sub">Stocktwits accounts linked to dlvr.it routes</div>
            </div>
          </div>
          <div style="display:flex;gap:8px">
            <button id="refresh-btn" class="btn btn-ghost btn-sm" onclick="refreshSession()">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              Refresh Session
            </button>
            <button class="btn btn-st btn-sm" onclick="openModal()">+ Add Account</button>
          </div>
        </div>

        <div class="bulk-bar" id="bulk-bar">
          <span class="bulk-lbl" id="bulk-lbl">0 selected</span>
          <button class="btn btn-del btn-sm" onclick="deleteSel()">Delete Selected</button>
          <button class="btn btn-ghost btn-sm" onclick="clearSel()">Clear</button>
        </div>

        <table class="acc-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="sel-all" title="Select all" onchange="toggleAll(this)"/></th>
              <th>Handle</th>
              <th>dlvr.it Route ID</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="acc-body">
            <tr><td colspan="5"><div class="empty"><div class="empty-ico">⏳</div><p>Loading…</p></div></td></tr>
          </tbody>
        </table>

        <div style="padding:12px 24px;border-top:1px solid var(--bdr);background:#fafafa">
          <p style="font-size:12px;color:var(--tx3);margin:0">
            Create a Route in <strong>dlvrit.com</strong> pointing to StockTwits, then click
            <strong>+ Add Account</strong> and use <strong>Fetch from dlvr.it</strong> to pick the Route ID.
          </p>
        </div>
      </div>

    </div>
  </div><!-- /tab-stocktwits -->

  <!-- ══════════════════════════ DISCORD TAB ════════════════════════════ -->
  <div id="tab-discord" class="tab-pane">
    <div class="stack">

      <div class="card">
        <div class="card-head">
          <div class="card-title">
            <div class="card-icon ic-dc">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.1.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.645-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/>
              </svg>
            </div>
            <div>
              Compose Post
              <div class="card-sub">Broadcast to all writable channels across your Discord servers</div>
            </div>
          </div>
        </div>

        <div class="card-body">
          <div class="field">
            <label for="dc-body">Post Body</label>
            <textarea id="dc-body" class="tall" placeholder="Write your message here…" oninput="charCount('dc-body','dc-cc',2000)"></textarea>
            <div><span id="dc-cc" class="char-ct">0 / 2000</span></div>
          </div>

          <div class="field">
            <label for="dc-urls">Channel or Server URLs <span class="lbl-opt">one per line</span></label>
            <textarea id="dc-urls" placeholder="https://discord.com/channels/1234567890123456789/9876543210987654321&#10;https://discord.com/channels/1111111111111111111/2222222222222222222"></textarea>
            <div class="hint">
              Right-click a channel in Discord → <strong>Copy Link</strong> to get a direct channel URL
              (<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:11px;">/channels/SERVER_ID/CHANNEL_ID</code>).
              The automation goes straight to that channel and posts — no server scanning needed.
              You can also paste a server-only URL to broadcast to all writable channels automatically.
            </div>
          </div>

          <div class="creds">
            <div class="creds-hd">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
              Credentials
              <em>— leave blank to reuse saved session</em>
            </div>
            <div class="row2" style="margin-top:0">
              <div>
                <label for="dc-email">Discord Email</label>
                <input id="dc-email" type="email" placeholder="your@email.com" autocomplete="off"/>
              </div>
              <div>
                <label for="dc-password">Discord Password</label>
                <input id="dc-password" type="password" placeholder="••••••••" autocomplete="new-password"/>
              </div>
            </div>
            <div class="hint" style="margin-top:10px">
              Session is cached locally after the first login — you only need to enter credentials when the session expires or on first use.
              CapSolver automatically handles hCaptcha challenges.
            </div>
          </div>
        </div>

        <div class="pub-foot">
          <button id="dc-btn" class="btn btn-dc btn-lg" onclick="pubDC()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
            Publish to Discord
          </button>
          <button id="dc-vnc-btn" class="btn btn-ghost btn-lg btn-vnc" onclick="openVnc()"
            title="Opens the live browser view (noVNC) in a new tab">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            Watch Live (VNC)
          </button>
          <span id="dc-status" class="pub-status"></span>
        </div>

        <div id="dc-res-wrap" class="res-wrap" style="display:none">
          <div class="res-head" onclick="toggleRes('dc')">
            <span>&#9660; Result</span>
            <button class="res-close" onclick="event.stopPropagation();hideRes('dc')">&#x2715; Close</button>
          </div>
          <pre id="dc-res" class="res-body"></pre>
        </div>
      </div>

    </div>
  </div><!-- /tab-discord -->

</main>

<!-- ── Add / Edit Account Modal ──────────────────────────────────────── -->
<div class="overlay" id="modal-overlay" onclick="if(event.target===this)closeModal()">
  <div class="modal">
    <div class="modal-hd">
      <h2 id="modal-title">Add Account</h2>
      <button class="modal-x" onclick="closeModal()" title="Close">&#x2715;</button>
    </div>
    <div class="modal-bd">
      <div class="field">
        <label for="m-handle">Stocktwits Handle</label>
        <input id="m-handle" type="text" placeholder="e.g. myaccount" autocomplete="off"/>
      </div>
      <div class="field">
        <label for="m-id">dlvr.it Route ID</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input id="m-id" type="number" placeholder="e.g. 2676570" autocomplete="off" style="flex:1"/>
          <button type="button" class="btn btn-ghost" id="fetch-btn" onclick="fetchDlvrit()">Fetch from dlvr.it</button>
        </div>
        <div class="hint">Click <strong>Fetch from dlvr.it</strong> to load your routes, or enter the ID manually from dlvrit.com.</div>
        <div id="dlvrit-picker" style="display:none;margin-top:10px">
          <label style="font-size:12px;color:var(--tx3);margin-bottom:4px;display:block">Pick a route:</label>
          <select id="dlvrit-select" style="width:100%" onchange="onRouteSelect(this)">
            <option value="">— select —</option>
          </select>
        </div>
        <div id="dlvrit-err" style="display:none;margin-top:6px;font-size:12px;color:#ef4444"></div>
      </div>
      <div class="modal-err" id="modal-err"></div>
    </div>
    <div class="modal-ft">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-ok" id="modal-save" onclick="saveAccount()">Save Account</button>
    </div>
  </div>
</div>

<!-- ── Toasts ─────────────────────────────────────────────────────────── -->
<div id="toasts"></div>

<script>
  const base = window.location.pathname.replace(/\\/$/, '');
  const ST_COOLDOWN_MS = 90000;
  const ST_BTN_HTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Publish to StockTwits';
  let _stCooldownTimer = null;

  function startSTCooldown(remainingMs) {
    if (_stCooldownTimer) { clearTimeout(_stCooldownTimer); _stCooldownTimer = null; }
    const endTime = Date.now() + remainingMs;
    const wrap = document.getElementById('st-cooldown');
    const fill = document.getElementById('st-cooldown-fill');
    const lbl  = document.getElementById('st-cooldown-lbl');
    const btn  = document.getElementById('st-btn');
    btn.disabled = true;
    btn.innerHTML = ST_BTN_HTML;
    wrap.classList.add('on');
    function tick() {
      const left = Math.max(0, endTime - Date.now());
      fill.style.width = (left / ST_COOLDOWN_MS * 100) + '%';
      lbl.textContent = Math.ceil(left / 1000) + 's remaining';
      if (left <= 0) {
        wrap.classList.remove('on');
        btn.disabled = false;
        _stCooldownTimer = null;
        return;
      }
      _stCooldownTimer = setTimeout(tick, 250);
    }
    tick();
  }

  async function checkSTCooldown() {
    try {
      const res = await fetch(base + '/st-cooldown');
      const json = await res.json();
      if (json.remainingMs > 0) startSTCooldown(json.remainingMs);
    } catch {}
  }

  // ── Tabs ──────────────────────────────────────────────────────────────
  function switchTab(name) {
    document.querySelectorAll('.tab-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-pane').forEach(p =>
      p.classList.toggle('on', p.id === 'tab-' + name));
  }

  // ── Toast ─────────────────────────────────────────────────────────────
  function toast(msg, type) {
    type = type || 'info';
    const icons = { ok: '✓', err: '✕', info: 'ℹ' };
    const root = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast t-' + type;
    el.innerHTML = '<span style="flex-shrink:0">' + (icons[type] || 'ℹ') + '</span><span>' + msg + '</span>';
    root.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 350); }, 4500);
  }

  // ── Char counter ──────────────────────────────────────────────────────
  function charCount(tid, cid, max) {
    const n = document.getElementById(tid).value.length;
    const el = document.getElementById(cid);
    el.textContent = n + ' / ' + max;
    el.style.color = n > max * .9 ? (n > max ? '#ef4444' : '#f59e0b') : 'var(--tx3)';
  }

  // ── Result panel ──────────────────────────────────────────────────────
  function showRes(prefix, text) {
    document.getElementById(prefix + '-res').textContent = text;
    document.getElementById(prefix + '-res-wrap').style.display = 'block';
    document.getElementById(prefix + '-res').style.display = 'block';
  }
  function hideRes(prefix) {
    document.getElementById(prefix + '-res-wrap').style.display = 'none';
  }
  function toggleRes(prefix) {
    const el = document.getElementById(prefix + '-res');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  }

  // ── StockTwits publish ────────────────────────────────────────────────
  async function pubST() {
    const bodyVal = document.getElementById('st-body').value.trim();
    const batchRaw = document.getElementById('st-batch').value;
    const btn = document.getElementById('st-btn');
    const status = document.getElementById('st-status');

    const batchLines = batchRaw.split('\\n').map(l => l.trim()).filter(Boolean);
    const items = [];
    try {
      for (const line of batchLines) {
        const d = line.indexOf('|');
        if (d <= 0) throw new Error('Invalid batch row — use: SYMBOL | post text');
        const symRaw = line.slice(0, d).trim();
        const sym = symRaw.startsWith('$') ? symRaw : '$' + symRaw;
        const txt = line.slice(d + 1).trim();
        if (sym === '$') throw new Error('Batch row has empty symbol');
        if (!txt) throw new Error('Batch row for ' + sym + ' has no text');
        items.push({ symbol: sym, body: txt });
      }
    } catch (e) { toast(e.message, 'err'); return; }

    if (!items.length && !bodyVal) {
      toast('Post body is required when not using batch mode.', 'err');
      document.getElementById('st-body').focus(); return;
    }

    const payload = {
      body: bodyVal, platforms: ['stocktwits'],
      stocktwitsSymbol: (s => s ? (s.startsWith('$') ? s : '$' + s) : undefined)(document.getElementById('st-symbol').value.trim()),
      stocktwitsAccountHandle: document.getElementById('st-account').value || undefined,
      stocktwitsItems: items.length ? items : undefined,
    };

    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Publishing…';
    status.textContent = 'Sending to StockTwits…';
    hideRes('st');

    let _apiCalled = false;
    try {
      const res = await fetch(base + '/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      _apiCalled = true;
      const json = await res.json();
      showRes('st', JSON.stringify(json, null, 2));
      toast(json.success === false ? 'Post failed — see result.' : 'Posted to StockTwits!',
            json.success === false ? 'err' : 'ok');
    } catch (e) {
      showRes('st', '⚠ ' + e.message);
      toast(e.message, 'err');
    } finally {
      status.textContent = '';
      if (_apiCalled) {
        startSTCooldown(ST_COOLDOWN_MS);
      } else {
        btn.disabled = false;
        btn.innerHTML = ST_BTN_HTML;
      }
    }
  }

  // ── Discord publish ───────────────────────────────────────────────────
  function openVnc() {
    window.open('http://' + location.hostname + ':6080/vnc.html?autoconnect=1&resize=scale', '_blank');
  }

  async function pubDC() {
    const bodyVal = document.getElementById('dc-body').value.trim();
    const urls = document.getElementById('dc-urls').value.split('\\n').map(u => u.trim()).filter(Boolean);
    const email = document.getElementById('dc-email').value.trim();
    const pw = document.getElementById('dc-password').value.trim();
    const btn = document.getElementById('dc-btn');
    const status = document.getElementById('dc-status');

    if (!bodyVal) { toast('Post body is required.', 'err'); document.getElementById('dc-body').focus(); return; }
    if (!urls.length) { toast('At least one Discord Server URL is required.', 'err'); document.getElementById('dc-urls').focus(); return; }

    const payload = {
      body: bodyVal, platforms: ['discord'],
      discordServerUrls: urls,
      discordEmail: email || undefined,
      discordPassword: pw || undefined,
    };

    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Publishing…';
    status.textContent = 'Posting to Discord channels — click "Watch Live (VNC)" to see the browser.';
    document.getElementById('dc-vnc-btn').classList.add('live');
    hideRes('dc');

    try {
      const res = await fetch(base + '/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      showRes('dc', JSON.stringify(json, null, 2));
      const posted = json.discord?.postedCount ?? json.postedCount;
      const ok = json.success !== false;
      toast(posted !== undefined ? 'Posted to ' + posted + ' channel(s)!' : (ok ? 'Discord post complete!' : 'Post failed — see result.'),
            ok ? 'ok' : 'err');
    } catch (e) {
      showRes('dc', '⚠ ' + e.message);
      toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Publish to Discord';
      status.textContent = '';
      document.getElementById('dc-vnc-btn').classList.remove('live');
    }
  }

  // ── dlvr.it session refresh ───────────────────────────────────────────
  async function refreshSession() {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spin" style="border-top-color:#374151;border-color:rgba(0,0,0,.15)"></span> Refreshing…';
    try {
      const res = await fetch(base + '/dlvrit-session/refresh', { method: 'POST' });
      const json = await res.json();
      if (!json.success) { toast('Session refresh failed: ' + (json.error || 'unknown'), 'err'); return; }
      toast('dlvr.it session refreshed!', 'ok');
    } catch (e) { toast('Network error: ' + e.message, 'err'); }
    finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Refresh Session';
    }
  }

  // ── Modal ─────────────────────────────────────────────────────────────
  const overlay   = document.getElementById('modal-overlay');
  const mTitle    = document.getElementById('modal-title');
  const mHandle   = document.getElementById('m-handle');
  const mId       = document.getElementById('m-id');
  const mErr      = document.getElementById('modal-err');
  const mSaveBtn  = document.getElementById('modal-save');

  function openModal(handle, rid) {
    mHandle.value = handle || ''; mId.value = rid || '';
    mTitle.textContent = handle ? 'Edit Account' : 'Add Account';
    mErr.style.display = 'none';
    overlay.classList.add('on');
    setTimeout(() => mHandle.focus(), 80);
  }
  function closeModal() {
    overlay.classList.remove('on');
    document.getElementById('dlvrit-picker').style.display = 'none';
    document.getElementById('dlvrit-err').style.display = 'none';
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  async function fetchDlvrit() {
    const btn = document.getElementById('fetch-btn');
    const picker = document.getElementById('dlvrit-picker');
    const sel = document.getElementById('dlvrit-select');
    const err = document.getElementById('dlvrit-err');
    btn.disabled = true; btn.textContent = 'Loading…';
    err.style.display = 'none'; picker.style.display = 'none';
    try {
      const res = await fetch(base + '/dlvrit-connected-accounts');
      const json = await res.json();
      if (!json.success) { err.textContent = json.error || 'Failed to fetch'; err.style.display = 'block'; return; }
      const accs = json.accounts || [];
      if (!accs.length) { err.textContent = 'No routes found in dlvr.it. Create a route first.'; err.style.display = 'block'; return; }
      sel.innerHTML = '<option value="">— select —</option>';
      accs.forEach(a => {
        const o = document.createElement('option');
        o.value = a.id; o.dataset.name = a.name;
        o.textContent = '[' + a.id + '] ' + a.name;
        sel.appendChild(o);
      });
      picker.style.display = 'block';
    } catch (e) { err.textContent = 'Network error: ' + e.message; err.style.display = 'block'; }
    finally { btn.disabled = false; btn.textContent = 'Fetch from dlvr.it'; }
  }

  function onRouteSelect(sel) {
    if (!sel.value) return;
    mId.value = sel.value;
    if (!mHandle.value.trim()) mHandle.value = sel.options[sel.selectedIndex].dataset.name || '';
  }

  async function saveAccount() {
    const handle = mHandle.value.trim();
    const rid = parseInt(mId.value.trim(), 10);
    if (!handle)         { showMErr('Stocktwits handle is required.'); mHandle.focus(); return; }
    if (!rid || rid <= 0){ showMErr('A valid dlvr.it Route ID is required.'); mId.focus(); return; }
    mSaveBtn.disabled = true; mSaveBtn.textContent = 'Saving…'; mErr.style.display = 'none';
    try {
      const res = await fetch(base + '/accounts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountHandle: handle, dlvritAccountId: rid }),
      });
      const json = await res.json();
      if (!json.success) { showMErr(json.error || 'Failed to save account.'); return; }
      closeModal(); await loadAccounts(); toast('Account saved!', 'ok');
    } catch (e) { showMErr('Network error: ' + e.message); }
    finally { mSaveBtn.disabled = false; mSaveBtn.textContent = 'Save Account'; }
  }
  function showMErr(msg) { mErr.textContent = msg; mErr.style.display = 'block'; }

  // ── Accounts table ────────────────────────────────────────────────────
  const accBody   = document.getElementById('acc-body');
  const stAccSel  = document.getElementById('st-account');
  const bulkBar   = document.getElementById('bulk-bar');
  const bulkLbl   = document.getElementById('bulk-lbl');
  const selAll    = document.getElementById('sel-all');

  function checkedIds() {
    return Array.from(accBody.querySelectorAll('input[type=checkbox]:checked')).map(c => c.dataset.id);
  }
  function syncBulk() {
    const ids = checkedIds();
    bulkLbl.textContent = ids.length + ' account' + (ids.length !== 1 ? 's' : '') + ' selected';
    bulkBar.classList.toggle('on', ids.length > 0);
    const all = accBody.querySelectorAll('input[type=checkbox]');
    selAll.indeterminate = ids.length > 0 && ids.length < all.length;
    selAll.checked = all.length > 0 && ids.length === all.length;
  }
  function toggleAll(cb) {
    accBody.querySelectorAll('input[type=checkbox]').forEach(c => {
      c.checked = cb.checked; c.closest('tr').classList.toggle('sel', cb.checked);
    }); syncBulk();
  }
  function clearSel() {
    accBody.querySelectorAll('input[type=checkbox]').forEach(c => {
      c.checked = false; c.closest('tr').classList.remove('sel');
    }); selAll.checked = false; selAll.indeterminate = false; syncBulk();
  }
  function onRowCheck(cb) { cb.closest('tr').classList.toggle('sel', cb.checked); syncBulk(); }

  async function deleteSel() {
    const ids = checkedIds();
    if (!ids.length) return;
    const lbl = ids.length === 1 ? '1 account' : ids.length + ' accounts';
    if (!confirm('Permanently delete ' + lbl + '? This cannot be undone.')) return;
    try {
      const res = await fetch(base + '/accounts', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const json = await res.json();
      if (!json.success) { toast('Delete failed: ' + (json.error || 'unknown'), 'err'); return; }
      await loadAccounts(); toast(lbl + ' deleted.', 'ok');
    } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
  }

  async function deleteSingle(id, handle) {
    if (!confirm('Permanently delete "' + handle + '"? This cannot be undone.')) return;
    try {
      const res = await fetch(base + '/accounts', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      const json = await res.json();
      if (!json.success) { toast('Delete failed: ' + (json.error || 'unknown'), 'err'); return; }
      await loadAccounts(); toast('"' + handle + '" deleted.', 'ok');
    } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
  }

  async function toggleAcc(id, action) {
    await fetch(base + '/accounts/' + id + '/' + action, { method: 'PUT' });
    await loadAccounts(); toast('Account ' + action + 'd.', 'ok');
  }

  async function loadAccounts() {
    try {
      const res = await fetch(base + '/accounts');
      const json = await res.json();
      const accs = json.accounts || [];

      const prev = stAccSel.value;
      stAccSel.innerHTML = '<option value="">— Auto-select eligible account —</option>';
      accs.filter(a => a.status === 'ACTIVE' && a.dlvritAccountId).forEach(a => {
        const o = document.createElement('option');
        o.value = a.accountHandle;
        o.textContent = a.accountHandle + '  (Route: ' + a.dlvritAccountId + ')';
        stAccSel.appendChild(o);
      });
      if (prev) stAccSel.value = prev;

      selAll.checked = false; selAll.indeterminate = false; bulkBar.classList.remove('on');

      if (!accs.length) {
        accBody.innerHTML = \`<tr><td colspan="5">
          <div class="empty">
            <div class="empty-ico">👤</div>
            <p>No accounts yet.<br>Click <strong>+ Add Account</strong> to get started.</p>
          </div>
        </td></tr>\`;
        return;
      }

      accBody.innerHTML = accs.map(a => {
        const bc = a.dlvritAccountId ? (a.status === 'ACTIVE' ? 'b-ok' : 'b-off') : 'b-warn';
        const bl = a.dlvritAccountId ? (a.status === 'ACTIVE' ? 'Active' : 'Disabled') : 'Not configured';
        const rid = a.dlvritAccountId
          ? \`<code style="background:#f1f5f9;padding:2px 8px;border-radius:5px;font-size:12px;font-family:monospace">\${a.dlvritAccountId}</code>\`
          : \`<span style="color:var(--tx3);font-style:italic">—</span>\`;
        const tog = a.status === 'ACTIVE'
          ? \`<button class="btn btn-sm btn-del" onclick="toggleAcc('\${a.id}','disable')">Disable</button>\`
          : \`<button class="btn btn-sm btn-ok" onclick="toggleAcc('\${a.id}','enable')">Enable</button>\`;
        return \`<tr>
          <td><input type="checkbox" data-id="\${a.id}" onchange="onRowCheck(this)"/></td>
          <td><strong>\${a.accountHandle}</strong></td>
          <td>\${rid}</td>
          <td><span class="badge \${bc}">\${bl}</span></td>
          <td><div class="act-row">
            <button class="btn btn-sm btn-blue" onclick="openModal('\${a.accountHandle}',\${a.dlvritAccountId||''})">Edit</button>
            \${tog}
            <button class="btn btn-sm btn-del" onclick="deleteSingle('\${a.id}','\${a.accountHandle}')">Delete</button>
          </div></td>
        </tr>\`;
      }).join('');
    } catch {
      accBody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:#ef4444;font-size:13px">Failed to load accounts.</td></tr>';
    }
  }

  loadAccounts();
  checkSTCooldown();
</script>
</body>
</html>`;
  }

  @Post('test-stocktwits-proxy')
  async testStocktwitsProxy(
    @Body() body: ManualUiProxyTestBody,
  ): Promise<Record<string, unknown>> {
    return this.publishingService.openStocktwitsProxyTestWindow(
      body.stocktwitsProxy,
    );
  }

  @Post('publish')
  async publish(
    @Body() body: ManualUiPublishBody,
  ): Promise<Record<string, unknown>> {
    const platforms = Array.isArray(body.platforms) ? body.platforms : [];

    const result = await this.publishingService.publishManualPost({
      body: body.body ?? '',
      stocktwitsSymbol: body.stocktwitsSymbol,
      stocktwitsAccountHandle: body.stocktwitsAccountHandle,
      stocktwitsUsername: body.stocktwitsUsername,
      stocktwitsPassword: body.stocktwitsPassword,
      stocktwitsProxy: body.stocktwitsProxy,
      stocktwitsItems: body.stocktwitsItems,
      publishToStocktwits: platforms.includes('stocktwits'),
      publishToDiscord: platforms.includes('discord'),
      discordServerUrl: body.discordServerUrl,
      discordServerUrls: body.discordServerUrls,
      discordEmail: body.discordEmail,
      discordPassword: body.discordPassword,
    });

    if (platforms.includes('stocktwits')) {
      this.lastStocktwitsPostAt = new Date();
    }

    return result;
  }
}

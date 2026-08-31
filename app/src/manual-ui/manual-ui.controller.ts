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
  stocktwitsAccountId?: string;
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
  dlvritWorkspaceId?: string;
};

type StocktwitsCampaignBody = {
  symbols?: string[];
  templates?: string[];
  postCount?: number;
  dlvritWorkspaceIds?: string[];
};

type LoginDlvritWorkspaceBody = { label?: string; email?: string; password?: string };

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
      body.dlvritWorkspaceId || null,
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

  @Get('dlvrit-workspaces')
  async listDlvritWorkspaces(): Promise<Record<string, unknown>> {
    return { workspaces: await this.publishingService.listDlvritWorkspaces() };
  }

  @Post('dlvrit-workspaces/login')
  async loginDlvritWorkspace(
    @Body() body: LoginDlvritWorkspaceBody,
  ): Promise<Record<string, unknown>> {
    try {
      const workspace = await this.publishingService.loginDlvritWorkspace({
        label: body.label,
        email: body.email ?? '',
        password: body.password ?? '',
      });
      return { success: true, workspace };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  @Post('dlvrit-workspaces/:id/refresh')
  async refreshDlvritWorkspace(@Param('id') id: string): Promise<Record<string, unknown>> {
    try {
      const workspace = await this.publishingService.refreshDlvritWorkspace(id);
      return { success: true, workspace };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  @Get('dlvrit-workspaces/:id/accounts')
  async listDlvritWorkspaceAccounts(@Param('id') id: string): Promise<Record<string, unknown>> {
    try {
      const accounts = await this.publishingService.listDlvritConnectedAccounts(id);
      return { success: true, accounts };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  @Get('dlvrit-connected-accounts')
  async listDlvritConnectedAccounts(): Promise<Record<string, unknown>> {
    try {
      const accounts = await this.publishingService.listAllDlvritConnectedAccounts();
      return { success: true, accounts };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  }

  @Get('dlvrit-connected-accounts/raw')
  async listDlvritConnectedAccountsRaw(): Promise<unknown> {
    return this.publishingService.listDlvritConnectedAccountsRaw();
  }

  @Post('stocktwits-campaigns')
  async createStocktwitsCampaign(
    @Body() body: StocktwitsCampaignBody,
  ): Promise<Record<string, unknown>> {
    return this.publishingService.scheduleStocktwitsCsvCampaign({
      symbols: Array.isArray(body.symbols) ? body.symbols : [],
      templates: Array.isArray(body.templates) ? body.templates : [],
      postCount:
        Number.isInteger(body.postCount) && Number(body.postCount) > 0
          ? Number(body.postCount)
          : undefined,
      dlvritWorkspaceIds: Array.isArray(body.dlvritWorkspaceIds)
        ? body.dlvritWorkspaceIds.filter(Boolean)
        : undefined,
    });
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
  <script>
    (() => {
      const saved = localStorage.getItem('publisher-theme');
      const dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    })();
  </script>
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

    /* ── Operations workspace theme ── */
    :root{
      --st:#176b4d;--st-dk:#10533b;--dc:#334155;--dc-dk:#1e293b;
      --bg:#f3f5f1;--surf:#fff;--bdr:#dfe4dd;
      --tx:#18221d;--tx2:#58645e;--tx3:#849089;
      --r:14px;--sh:0 1px 2px rgba(20,35,27,.04),0 10px 30px rgba(20,35,27,.035)
    }
    body{font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      background:var(--bg);letter-spacing:-.005em}
    .app-bar{height:68px;padding:0 max(28px,calc((100vw - 1180px)/2));gap:18px;
      background:#17211c;border:0;color:#fff;position:sticky}
    .app-logo{font-size:15px;color:#fff;letter-spacing:-.01em}
    .brand-copy{display:flex;flex-direction:column;line-height:1.15}
    .brand-copy small{margin-top:4px;color:#91a198;font-size:10px;font-weight:600;
      letter-spacing:.14em;text-transform:uppercase}
    .app-bar-right{color:#91a198;font-size:11px;text-transform:uppercase;letter-spacing:.1em}
    .signout-btn{border:1px solid #3a4740;background:transparent;border-radius:8px;
      padding:7px 13px;font-size:12px;font-weight:650;color:#d9e1dc;cursor:pointer;font-family:inherit}
    .signout-btn:hover{border-color:#617069;color:#fff}
    .tab-nav{padding:0 max(28px,calc((100vw - 1180px)/2));gap:6px;background:#fff}
    .tab-btn{padding:15px 16px 13px;border-bottom-width:2px;color:#66736c}
    .tab-btn.active[data-tab="stocktwits"],.tab-btn.active[data-tab="discord"]{
      color:var(--st);border-bottom-color:var(--st)}
    .page{max-width:1180px;padding:40px 28px 90px}
    .page-intro{display:flex;justify-content:space-between;align-items:flex-end;gap:32px;margin-bottom:26px}
    .eyebrow{font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--st)}
    .page-intro h1{font-size:30px;line-height:1.12;letter-spacing:-.035em;margin:7px 0 9px;font-weight:720}
    .page-intro p{max-width:650px;color:var(--tx2);font-size:14px}
    .status-cluster{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
    .status-pill{display:inline-flex;align-items:center;gap:7px;background:#fff;border:1px solid var(--bdr);
      border-radius:999px;padding:7px 11px;font-size:11px;font-weight:700;color:var(--tx2)}
    .status-pill::before{content:'';width:7px;height:7px;border-radius:50%;background:#2b8a63;
      box-shadow:0 0 0 3px #e5f3ec}
    .workflow{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--bdr);
      background:#fff;border-radius:12px;margin-bottom:20px;overflow:hidden}
    .workflow-step{padding:15px 18px;display:flex;align-items:center;gap:12px;border-right:1px solid var(--bdr)}
    .workflow-step:last-child{border-right:0}
    .step-no{width:25px;height:25px;display:grid;place-items:center;border-radius:7px;background:#edf4ef;
      color:var(--st);font-size:11px;font-weight:800}
    .step-copy strong{display:block;font-size:12px}.step-copy span{font-size:11px;color:var(--tx3)}
    .stack{display:flex;flex-direction:column;gap:20px}.stack>*+*{margin-top:0}
    .campaign-card{order:1;border-top:3px solid var(--st)}
    .workspace-card{order:0}.compose-card{order:2}.accounts-card{order:3}
    .workspace-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
    .workspace-item{border:1px solid var(--bdr);border-radius:10px;padding:14px;background:rgba(255,255,255,.3)}
    .workspace-item-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .workspace-item strong{font-size:13px}.workspace-item p{font-size:11px;color:var(--tx3);margin:4px 0 10px}
    .workspace-actions{display:flex;gap:7px;align-items:center}
    .workspace-choice{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .workspace-choice label{display:inline-flex;align-items:center;gap:6px;padding:7px 10px;border:1px solid var(--bdr);
      border-radius:8px;text-transform:none;letter-spacing:0;background:rgba(255,255,255,.25);cursor:pointer}
    .card{box-shadow:var(--sh);border-color:var(--bdr)}
    .card-head{padding:20px 24px;background:#fcfdfb}
    .card-title{font-size:15px}.card-sub{font-size:12px;color:#748079;margin-top:3px}
    .card-icon{background:#e8f2ec;color:var(--st);font-size:10px;font-weight:800;letter-spacing:.04em}
    .ic-dc{background:#eef1f3;color:#334155}
    .card-body{padding:26px 24px}
    label{color:#526059;letter-spacing:.075em}
    input[type=text],input[type=email],input[type=password],input[type=number],select,textarea{
      border:1px solid #d7ddd8;border-radius:9px;padding:11px 12px;background:#fdfefd}
    input:focus,select:focus,textarea:focus{border-color:var(--st);box-shadow:0 0 0 3px rgba(23,107,77,.1);background:#fff}
    input[type=file]{width:100%;border:1px dashed #c9d2cc;border-radius:9px;padding:9px;background:#f8faf7;color:var(--tx2)}
    input[type=file]::file-selector-button{border:0;border-radius:6px;background:#e7efe9;color:#315846;
      padding:7px 10px;margin-right:10px;font-weight:700;cursor:pointer}
    .creds{background:#f7f9f6;border-color:#dce2dd}
    .sep::before,.sep::after{background:#e5e9e5}
    .btn{border-radius:8px;font-weight:680}.btn:hover:not(:disabled){opacity:1;filter:brightness(.95)}
    .btn-st,.btn-ok{background:var(--st)}.btn-dc,.btn-blue{background:#26342d}
    .btn-ghost{background:#fff;border:1px solid #d5dcd7;color:#48554e}
    .pub-foot{background:#f8faf7;padding:17px 24px}.pub-status{color:#758179}
    .bulk-bar{background:#eef6f1;color:var(--st);border-color:#d5e8dc}
    .table-scroll{overflow-x:auto}
    .acc-table{min-width:800px}.acc-table th{background:#f7f9f6;color:#758078}
    .acc-table tr.sel td{background:#edf6f0}.acc-table tr:hover:not(.sel) td{background:#fafcf9}
    .acc-table input[type=checkbox]{accent-color:var(--st)}
    .account-note{padding:13px 24px;border-top:1px solid var(--bdr);background:#f8faf7}
    .account-note p{font-size:12px;color:var(--tx3);margin:0}
    .res-head,pre.res-body{background:#17211c}
    .cooldown-fill{background:var(--st)}

    /* ── Glass surface and theme modes ── */
    body{
      background:
        radial-gradient(circle at 8% 4%,rgba(53,131,96,.11),transparent 28rem),
        radial-gradient(circle at 92% 14%,rgba(182,155,94,.08),transparent 25rem),
        var(--bg);
      background-attachment:fixed
    }
    .app-bar{background:rgba(23,33,28,.91);backdrop-filter:blur(18px) saturate(130%);
      -webkit-backdrop-filter:blur(18px) saturate(130%);box-shadow:0 1px 0 rgba(255,255,255,.05)}
    .tab-nav{position:sticky;top:68px;z-index:50;background:rgba(255,255,255,.78);
      backdrop-filter:blur(16px) saturate(135%);-webkit-backdrop-filter:blur(16px) saturate(135%)}
    .card,.workflow,.status-pill{background:rgba(255,255,255,.77);
      backdrop-filter:blur(18px) saturate(125%);-webkit-backdrop-filter:blur(18px) saturate(125%);
      box-shadow:0 1px 1px rgba(20,35,27,.03),0 14px 38px rgba(20,35,27,.06),inset 0 1px rgba(255,255,255,.55)}
    .card-head{background:rgba(250,252,249,.58)}
    .theme-toggle{width:36px;height:36px;display:grid;place-items:center;border-radius:9px;
      border:1px solid #3a4740;background:rgba(255,255,255,.03);color:#dbe4df;cursor:pointer;
      transition:background .18s,border-color .18s,transform .18s}
    .theme-toggle:hover{background:rgba(255,255,255,.09);border-color:#66756d;transform:translateY(-1px)}
    .theme-toggle svg{width:16px;height:16px}.theme-toggle .moon{display:none}
    html[data-theme="dark"]{
      color-scheme:dark;
      --bg:#101612;--surf:#18201c;--bdr:#344039;
      --tx:#ecf2ee;--tx2:#b3c0b9;--tx3:#8f9d95;
      --st:#55b98b;--st-dk:#78cba5;--sh:0 14px 42px rgba(0,0,0,.24)
    }
    html[data-theme="dark"] body{
      background:radial-gradient(circle at 8% 4%,rgba(46,126,90,.18),transparent 30rem),
        radial-gradient(circle at 94% 12%,rgba(153,125,66,.09),transparent 26rem),var(--bg)}
    html[data-theme="dark"] .app-bar{background:rgba(11,17,14,.86)}
    html[data-theme="dark"] .tab-nav{background:rgba(19,27,23,.8)}
    html[data-theme="dark"] .card,html[data-theme="dark"] .workflow,
    html[data-theme="dark"] .status-pill{background:rgba(25,34,29,.76);border-color:rgba(117,139,127,.27);
      box-shadow:0 16px 42px rgba(0,0,0,.22),inset 0 1px rgba(255,255,255,.035)}
    html[data-theme="dark"] .card-head,html[data-theme="dark"] .pub-foot,
    html[data-theme="dark"] .account-note,html[data-theme="dark"] .acc-table th,
    html[data-theme="dark"] .modal-ft{background:rgba(14,21,17,.42)}
    html[data-theme="dark"] input[type=text],html[data-theme="dark"] input[type=email],
    html[data-theme="dark"] input[type=password],html[data-theme="dark"] input[type=number],
    html[data-theme="dark"] select,html[data-theme="dark"] textarea{
      background:rgba(9,15,12,.52);border-color:#3c4942;color:var(--tx)}
    html[data-theme="dark"] input[type=file],html[data-theme="dark"] .creds{
      background:rgba(9,15,12,.4);border-color:#405048;color:var(--tx2)}
    html[data-theme="dark"] input[type=file]::file-selector-button{background:#263a30;color:#cce4d7}
    html[data-theme="dark"] input:focus,html[data-theme="dark"] select:focus,
    html[data-theme="dark"] textarea:focus{background:#131c17;border-color:var(--st)}
    html[data-theme="dark"] .btn-ghost{background:rgba(255,255,255,.025);border-color:#435048;color:#c2cec7}
    html[data-theme="dark"] .ic-st,html[data-theme="dark"] .card-icon,
    html[data-theme="dark"] .step-no{background:#203a2e;color:#70c69d}
    html[data-theme="dark"] .ic-dc{background:#29332e;color:#b7c3bc}
    html[data-theme="dark"] .acc-table tr:hover:not(.sel) td{background:rgba(86,121,101,.09)}
    html[data-theme="dark"] .acc-table tr.sel td{background:rgba(42,128,86,.13)}
    html[data-theme="dark"] .acc-table td{border-bottom-color:rgba(110,132,120,.18)}
    html[data-theme="dark"] .tab-btn{color:#8e9d95}
    html[data-theme="dark"] code{background:#25302a!important;color:#d6e2db}
    html[data-theme="dark"] .modal{background:#19221d;border:1px solid #3a463f}
    html[data-theme="dark"] .workspace-item,html[data-theme="dark"] .workspace-choice label{background:rgba(6,12,9,.25)}
    html[data-theme="dark"] .theme-toggle .sun{display:none}
    html[data-theme="dark"] .theme-toggle .moon{display:block}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation-duration:.01ms!important;transition-duration:.01ms!important}}

    @media(max-width:640px){
      .app-bar,.tab-nav{padding:0 14px}
      .app-bar-right{display:none}.brand-copy small{display:none}
      .page{padding:24px 12px 60px}
      .page-intro{display:block}.page-intro h1{font-size:25px}.status-cluster{justify-content:flex-start;margin-top:18px}
      .workflow{grid-template-columns:1fr}.workflow-step{border-right:0;border-bottom:1px solid var(--bdr)}
      .workflow-step:last-child{border-bottom:0}
      .card-head,.card-body,.pub-foot{padding:14px}
      .card-head{align-items:flex-start;gap:12px;flex-direction:column}
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
    <span class="brand-copy">Stock Promotion<small>Publishing Operations</small></span>
  </a>
  <span class="app-bar-right">Operator workspace</span>
  <button id="theme-toggle" class="theme-toggle" type="button" onclick="toggleTheme()" aria-label="Switch to dark mode" title="Switch color theme">
    <svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>
    <svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>
  </button>
  <form method="post" action="/api/manual-ui/logout" style="margin:0">
    <button type="submit" class="signout-btn">
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

  <section class="page-intro">
    <div>
      <div class="eyebrow">Campaign workspace</div>
      <h1>Publishing control center</h1>
      <p>Prepare symbol campaigns, coordinate connected accounts, and control every outbound post from one focused workspace.</p>
    </div>
    <div class="status-cluster" aria-label="Publishing status">
      <span class="status-pill">dlvr.it connected</span>
      <span class="status-pill">90 sec cadence</span>
    </div>
  </section>

  <!-- ══════════════════════════ STOCKTWITS TAB ══════════════════════════ -->
  <div id="tab-stocktwits" class="tab-pane on">
    <div class="workflow" aria-label="Campaign workflow">
      <div class="workflow-step"><span class="step-no">01</span><span class="step-copy"><strong>Import symbols</strong><span>Upload and validate ticker CSV</span></span></div>
      <div class="workflow-step"><span class="step-no">02</span><span class="step-copy"><strong>Build posts</strong><span>Mix templates with unique tickers</span></span></div>
      <div class="workflow-step"><span class="step-no">03</span><span class="step-copy"><strong>Queue campaign</strong><span>Rotate accounts automatically</span></span></div>
    </div>
    <div class="stack">

      <div class="card workspace-card">
        <div class="card-head">
          <div class="card-title">
            <div class="card-icon ic-st">DL</div>
            <div>dlvr.it Workspaces<div class="card-sub">Keep independent sessions and their StockTwits routes separated</div></div>
          </div>
          <button class="btn btn-st btn-sm" onclick="openWorkspaceModal()">+ Connect dlvr.it</button>
        </div>
        <div class="card-body">
          <div id="workspace-grid" class="workspace-grid"><div class="hint">Loading connected workspaces…</div></div>
        </div>
      </div>

      <!-- Compose card -->
      <div class="card compose-card">
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

      <!-- CSV campaign card -->
      <div class="card campaign-card">
        <div class="card-head">
          <div class="card-title">
            <div class="card-icon ic-st">CSV</div>
            <div>
              One-click Symbol Campaign
              <div class="card-sub">Upload symbols, mix 2–3 per post, rotate accounts, and publish every 90 seconds</div>
            </div>
          </div>
        </div>
        <div class="card-body">
          <div class="row2">
            <div class="field" style="margin-top:0">
              <label for="campaign-csv">Ticker CSV</label>
              <input id="campaign-csv" type="file" accept=".csv,text/csv" onchange="readCampaignCsv(this.files[0])"/>
              <div id="campaign-csv-info" class="hint">First column or a column named symbol/ticker is used. Duplicates are removed.</div>
            </div>
            <div class="field" style="margin-top:0">
              <label for="campaign-count">Total posts <span class="lbl-opt">optional</span></label>
              <input id="campaign-count" type="number" min="1" placeholder="Auto-calculate"/>
              <div class="hint">Must allow 2–3 unique tickers in every post.</div>
            </div>
          </div>
          <div class="field">
            <label for="campaign-templates">Post templates <span class="lbl-opt">separate templates with a blank line</span></label>
            <textarea id="campaign-templates" class="tall" placeholder="Watching {{symbols}} for momentum and volume confirmation.\n\nFresh market setup across {{tickers}} — keeping these names on radar."></textarea>
            <div class="hint">Use <code>{{symbols}}</code> or <code>{{tickers}}</code> where cashtags should appear. Templates rotate automatically.</div>
          </div>
          <div class="field">
            <label>Publishing workspaces <span class="lbl-opt">all active workspaces by default</span></label>
            <div id="campaign-workspaces" class="workspace-choice"><span class="hint">Loading workspaces…</span></div>
          </div>
          <div id="campaign-preview" class="hint"></div>
        </div>
        <div class="pub-foot">
          <button id="campaign-btn" class="btn btn-st btn-lg" onclick="scheduleCampaign()">Schedule Entire Campaign</button>
          <span id="campaign-status" class="pub-status"></span>
        </div>
        <div id="campaign-res-wrap" class="res-wrap" style="display:none">
          <div class="res-head" onclick="toggleRes('campaign')"><span>&#9660; Campaign schedule</span></div>
          <pre id="campaign-res" class="res-body"></pre>
        </div>
      </div>

      <!-- Account management card -->
      <div class="card accounts-card">
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
              <div class="card-sub">All social accounts currently linked to your dlvr.it account</div>
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

        <div class="table-scroll"><table class="acc-table">
          <thead>
            <tr>
              <th><input type="checkbox" id="sel-all" title="Select all" onchange="toggleAll(this)"/></th>
              <th>Handle</th>
              <th>dlvr.it Login</th>
              <th>dlvr.it Account ID</th>
              <th>dlvr.it Status</th>
              <th>App Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="acc-body">
            <tr><td colspan="7"><div class="empty"><div class="empty-ico">⏳</div><p>Loading…</p></div></td></tr>
          </tbody>
        </table></div>

        <div class="account-note">
          <p>
            Accounts linked in <strong>dlvr.it</strong> appear here automatically. Use
            <strong>Add to App</strong> to enable an account for publishing from this dashboard.
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

<!-- ── Connect dlvr.it workspace modal ─────────────────────────────── -->
<div class="overlay" id="workspace-overlay" onclick="if(event.target===this)closeWorkspaceModal()">
  <div class="modal">
    <div class="modal-hd"><h2>Connect dlvr.it account</h2><button class="modal-x" onclick="closeWorkspaceModal()" title="Close">&#x2715;</button></div>
    <div class="modal-bd">
      <div class="field"><label for="ws-label">Workspace label <span class="lbl-opt">optional</span></label><input id="ws-label" type="text" placeholder="e.g. Main portfolio"/></div>
      <div class="field"><label for="ws-email">dlvr.it email</label><input id="ws-email" type="email" autocomplete="username" placeholder="name@example.com"/></div>
      <div class="field"><label for="ws-password">dlvr.it password</label><input id="ws-password" type="password" autocomplete="current-password"/></div>
      <div class="hint">The password is used only during this login and is not stored. Each account gets its own isolated browser profile and session cookie.</div>
      <div class="modal-err" id="workspace-err"></div>
    </div>
    <div class="modal-ft"><button class="btn btn-ghost" onclick="closeWorkspaceModal()">Cancel</button><button id="workspace-login-btn" class="btn btn-ok" onclick="loginWorkspace()">Connect & discover accounts</button></div>
  </div>
</div>

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
        <label for="m-workspace">dlvr.it Login</label>
        <select id="m-workspace"><option value="">Default / legacy session</option></select>
      </div>
      <div class="field">
        <label for="m-id">dlvr.it Account ID</label>
        <div style="display:flex;gap:8px;align-items:flex-start">
          <input id="m-id" type="number" placeholder="e.g. 2676570" autocomplete="off" style="flex:1"/>
          <button type="button" class="btn btn-ghost" id="fetch-btn" onclick="fetchDlvrit()">Fetch from dlvr.it</button>
        </div>
        <div class="hint">Click <strong>Fetch from dlvr.it</strong> to load linked accounts, or enter the account ID manually.</div>
        <div id="dlvrit-picker" style="display:none;margin-top:10px">
          <label style="font-size:12px;color:var(--tx3);margin-bottom:4px;display:block">Pick an account:</label>
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

  // ── One-click CSV campaign ───────────────────────────────────────────
  let campaignSymbols = [];

  function parseCsvLine(line) {
    const cells = []; let value = ''; let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && line[i + 1] === '"' && quoted) { value += '"'; i++; }
      else if (ch === '"') quoted = !quoted;
      else if (ch === ',' && !quoted) { cells.push(value.trim()); value = ''; }
      else value += ch;
    }
    cells.push(value.trim()); return cells;
  }

  async function readCampaignCsv(file) {
    if (!file) return;
    const lines = (await file.text()).split(/\\r?\\n/).filter(line => line.trim());
    if (!lines.length) { toast('CSV is empty.', 'err'); return; }
    const first = parseCsvLine(lines[0]);
    const headerIndex = first.findIndex(value => /^(symbol|ticker|tickers)$/i.test(value.trim()));
    const column = headerIndex >= 0 ? headerIndex : 0;
    const dataLines = headerIndex >= 0 ? lines.slice(1) : lines;
    campaignSymbols = Array.from(new Set(dataLines
      .map(line => (parseCsvLine(line)[column] || '').replace(/^\\$/, '').trim().toUpperCase())
      .filter(value => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value))));
    const min = Math.ceil(campaignSymbols.length / 3);
    const max = Math.floor(campaignSymbols.length / 2);
    document.getElementById('campaign-csv-info').textContent =
      campaignSymbols.length + ' unique symbols loaded.';
    document.getElementById('campaign-preview').textContent = campaignSymbols.length >= 2
      ? 'Campaign can contain ' + min + '–' + max + ' posts. Auto mode creates ' + min + '.'
      : 'At least two valid symbols are required.';
  }

  async function scheduleCampaign() {
    const templates = document.getElementById('campaign-templates').value
      .split(/\\n\\s*\\n/).map(value => value.trim()).filter(Boolean);
    const countRaw = document.getElementById('campaign-count').value.trim();
    if (campaignSymbols.length < 2) { toast('Upload a CSV with at least two symbols.', 'err'); return; }
    if (!templates.length) { toast('Add at least one post template.', 'err'); return; }
    const btn = document.getElementById('campaign-btn');
    const status = document.getElementById('campaign-status');
    btn.disabled = true; status.textContent = 'Creating posts and scheduling account rotation…';
    hideRes('campaign');
    try {
      const res = await fetch(base + '/stocktwits-campaigns', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: campaignSymbols,
          templates,
          postCount: countRaw ? Number(countRaw) : undefined,
          dlvritWorkspaceIds: Array.from(document.querySelectorAll('input[name="campaign-workspace"]:checked')).map(el => el.value),
        }),
      });
      const json = await res.json();
      if (!res.ok || json.statusCode >= 400) throw new Error(json.message || 'Campaign scheduling failed.');
      showRes('campaign', JSON.stringify(json, null, 2));
      toast(json.postCount + ' posts scheduled successfully.', 'ok');
    } catch (e) {
      showRes('campaign', '⚠ ' + e.message); toast(e.message, 'err');
    } finally { btn.disabled = false; status.textContent = ''; }
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
      stocktwitsAccountId: document.getElementById('st-account').value || undefined,
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
    status.textContent = 'Posting to Discord channels…';
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

  // ── Multiple dlvr.it workspaces ─────────────────────────────────────
  const workspaceOverlay = document.getElementById('workspace-overlay');
  let dlvritWorkspaces = [];

  function openWorkspaceModal() {
    document.getElementById('workspace-err').style.display = 'none';
    document.getElementById('ws-password').value = '';
    workspaceOverlay.classList.add('on');
    setTimeout(() => document.getElementById('ws-email').focus(), 80);
  }
  function closeWorkspaceModal() { workspaceOverlay.classList.remove('on'); }

  async function loginWorkspace() {
    const email = document.getElementById('ws-email').value.trim();
    const password = document.getElementById('ws-password').value;
    const label = document.getElementById('ws-label').value.trim();
    const btn = document.getElementById('workspace-login-btn');
    const err = document.getElementById('workspace-err');
    if (!email || !password) { err.textContent = 'Email and password are required.'; err.style.display = 'block'; return; }
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Connecting…'; err.style.display = 'none';
    try {
      const res = await fetch(base + '/dlvrit-workspaces/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, label: label || undefined }),
      });
      const json = await res.json();
      if (!json.success) { err.textContent = json.error || 'Login failed.'; err.style.display = 'block'; return; }
      closeWorkspaceModal();
      document.getElementById('ws-password').value = '';
      await loadWorkspaces(); await loadAccounts();
      toast('dlvr.it account connected and routes discovered.', 'ok');
    } catch (e) { err.textContent = 'Network error: ' + e.message; err.style.display = 'block'; }
    finally { btn.disabled = false; btn.textContent = 'Connect & discover accounts'; }
  }

  async function refreshWorkspace(id) {
    try {
      const res = await fetch(base + '/dlvrit-workspaces/' + encodeURIComponent(id) + '/refresh', { method: 'POST' });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Refresh failed');
      await loadWorkspaces(); await loadAccounts(); toast('Workspace refreshed.', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function loadWorkspaces() {
    const res = await fetch(base + '/dlvrit-workspaces');
    const json = await res.json();
    dlvritWorkspaces = json.workspaces || [];
    const grid = document.getElementById('workspace-grid');
    const choices = document.getElementById('campaign-workspaces');
    const modalSelect = document.getElementById('m-workspace');
    modalSelect.innerHTML = '<option value="">Default / legacy session</option>';
    dlvritWorkspaces.forEach(ws => {
      const option = document.createElement('option'); option.value = ws.id; option.textContent = ws.label + ' — ' + ws.email; modalSelect.appendChild(option);
    });
    if (!dlvritWorkspaces.length) {
      grid.innerHTML = '<div class="empty" style="grid-column:1/-1;padding:20px"><p>No additional dlvr.it logins connected yet.</p></div>';
      choices.innerHTML = '<span class="hint">The default dlvr.it session will be used.</span>';
      return;
    }
    grid.innerHTML = dlvritWorkspaces.map(ws => '<div class="workspace-item"><div class="workspace-item-head"><strong>' + ws.label + '</strong><span class="badge ' + (ws.status === 'ACTIVE' ? 'b-ok' : 'b-warn') + '">' + ws.status.replaceAll('_',' ') + '</span></div><p>' + ws.email + ' · ' + ws._count.accounts + ' StockTwits route(s)</p><div class="workspace-actions"><button class="btn btn-ghost btn-sm" data-workspace="' + ws.id + '" onclick="refreshWorkspace(this.dataset.workspace)">Refresh routes</button></div></div>').join('');
    choices.innerHTML = dlvritWorkspaces.filter(ws => ws.status === 'ACTIVE').map(ws => '<label><input type="checkbox" name="campaign-workspace" value="' + ws.id + '" checked/> ' + ws.label + '</label>').join('');
  }

  // ── Modal ─────────────────────────────────────────────────────────────
  const overlay   = document.getElementById('modal-overlay');
  const mTitle    = document.getElementById('modal-title');
  const mHandle   = document.getElementById('m-handle');
  const mId       = document.getElementById('m-id');
  const mWorkspace = document.getElementById('m-workspace');
  const mErr      = document.getElementById('modal-err');
  const mSaveBtn  = document.getElementById('modal-save');

  function openModal(handle, rid, workspaceId) {
    mHandle.value = handle || ''; mId.value = rid || '';
    mWorkspace.value = workspaceId || '';
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
      const workspaceId = mWorkspace.value;
      const res = await fetch(workspaceId
        ? base + '/dlvrit-workspaces/' + encodeURIComponent(workspaceId) + '/accounts'
        : base + '/dlvrit-connected-accounts');
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
        body: JSON.stringify({ accountHandle: handle, dlvritAccountId: rid, dlvritWorkspaceId: mWorkspace.value || undefined }),
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
      const [localRes, linkedRes] = await Promise.all([
        fetch(base + '/accounts'),
        fetch(base + '/dlvrit-connected-accounts'),
      ]);
      const localJson = await localRes.json();
      const linkedJson = await linkedRes.json();
      const accs = localJson.accounts || [];
      const linked = linkedJson.success ? (linkedJson.accounts || []) : [];
      const routeKey = (workspaceId, routeId) => (workspaceId || 'legacy') + ':' + Number(routeId);
      const localByDlvritId = new Map(
        accs.filter(a => a.dlvritAccountId).map(a => [routeKey(a.dlvritWorkspaceId, a.dlvritAccountId), a]),
      );
      const linkedIds = new Set(linked.map(a => routeKey(a.workspaceId, a.id)));

      const prev = stAccSel.value;
      stAccSel.innerHTML = '<option value="">— Auto-select eligible account —</option>';
      accs.filter(a => a.status === 'ACTIVE' && a.dlvritAccountId).forEach(a => {
        const o = document.createElement('option');
        o.value = a.id;
        o.textContent = a.accountHandle + ' — ' + (a.dlvritWorkspace?.label || 'Default dlvr.it') + ' (Route: ' + a.dlvritAccountId + ')';
        stAccSel.appendChild(o);
      });
      if (prev) stAccSel.value = prev;

      selAll.checked = false; selAll.indeterminate = false; bulkBar.classList.remove('on');

      if (!linked.length && !accs.length) {
        accBody.innerHTML = \`<tr><td colspan="7">
          <div class="empty">
            <div class="empty-ico">👤</div>
            <p>No linked dlvr.it accounts found.</p>
          </div>
        </td></tr>\`;
        return;
      }

      const rows = linked.map(remote => ({ remote, local: localByDlvritId.get(routeKey(remote.workspaceId, remote.id)) }))
        .concat(accs.filter(a => !a.dlvritAccountId || !linkedIds.has(routeKey(a.dlvritWorkspaceId, a.dlvritAccountId)))
          .map(local => ({ remote: null, local })));

      accBody.innerHTML = rows.map(row => {
        const a = row.local;
        const remote = row.remote;
        const handle = remote?.name || a?.accountHandle || 'Unknown';
        const dlvritId = remote?.id || a?.dlvritAccountId;
        const workspaceId = remote?.workspaceId || a?.dlvritWorkspaceId || '';
        const workspaceLabel = remote?.workspaceLabel || a?.dlvritWorkspace?.label || 'Default dlvr.it';
        const remoteClass = remote ? (remote.needsReconnect || !remote.active ? 'b-warn' : 'b-ok') : 'b-off';
        const remoteLabel = remote
          ? (remote.needsReconnect ? 'Reconnect required' : (remote.active ? 'Linked & active' : 'Linked & inactive'))
          : 'Not found in dlvr.it';
        const appClass = a ? (a.status === 'ACTIVE' ? 'b-ok' : 'b-off') : 'b-warn';
        const appLabel = a ? (a.status === 'ACTIVE' ? 'Ready' : 'Disabled') : 'Not added';
        const rid = dlvritId
          ? \`<code style="background:#f1f5f9;padding:2px 8px;border-radius:5px;font-size:12px;font-family:monospace">\${dlvritId}</code>\`
          : \`<span style="color:var(--tx3);font-style:italic">—</span>\`;
        if (!a) {
          return \`<tr>
            <td></td>
            <td><strong>\${handle}</strong></td>
            <td><strong>\${workspaceLabel}</strong></td>
            <td>\${rid}</td>
            <td><span class="badge \${remoteClass}">\${remoteLabel}</span></td>
            <td><span class="badge \${appClass}">\${appLabel}</span></td>
            <td><button class="btn btn-sm btn-blue" onclick="openModal('\${handle}',\${dlvritId},'\${workspaceId}')">Add to App</button></td>
          </tr>\`;
        }
        const tog = a.status === 'ACTIVE'
          ? \`<button class="btn btn-sm btn-del" onclick="toggleAcc('\${a.id}','disable')">Disable</button>\`
          : \`<button class="btn btn-sm btn-ok" onclick="toggleAcc('\${a.id}','enable')">Enable</button>\`;
        return \`<tr>
          <td><input type="checkbox" data-id="\${a.id}" onchange="onRowCheck(this)"/></td>
          <td><strong>\${handle}</strong></td>
          <td><strong>\${workspaceLabel}</strong></td>
          <td>\${rid}</td>
          <td><span class="badge \${remoteClass}">\${remoteLabel}</span></td>
          <td><span class="badge \${appClass}">\${appLabel}</span></td>
          <td><div class="act-row">
            <button class="btn btn-sm btn-blue" onclick="openModal('\${handle}',\${dlvritId||''},'\${workspaceId}')">Edit</button>
            \${tog}
            <button class="btn btn-sm btn-del" onclick="deleteSingle('\${a.id}','\${handle}')">Delete</button>
          </div></td>
        </tr>\`;
      }).join('');
    } catch {
      accBody.innerHTML = '<tr><td colspan="7" style="padding:16px;color:#ef4444;font-size:13px">Failed to load accounts.</td></tr>';
    }
  }

  function syncThemeToggle() {
    const dark = document.documentElement.dataset.theme === 'dark';
    const btn = document.getElementById('theme-toggle');
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('publisher-theme', next);
    syncThemeToggle();
  }

  syncThemeToggle();
  loadWorkspaces();
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
      stocktwitsAccountId: body.stocktwitsAccountId,
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

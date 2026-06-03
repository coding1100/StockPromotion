import { Body, Controller, Delete, Get, Header, Param, Post, Put } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PublishingService } from '../publishing/publishing.service';
import { AccountStatus } from '@prisma/client';

type ManualUiPublishBody = {
  body?: string;
  platforms?: string[];
  discordServerUrl?: string;
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
export class ManualUiController {
  constructor(
    private readonly publishingService: PublishingService,
  ) {}

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

  // ── UI ───────────────────────────────────────────────────────────────────────

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  render(): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Manual Publisher</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: #f5f7fb;
        color: #111827;
      }
      .wrap {
        max-width: 760px;
        margin: 32px auto;
        padding: 0 16px;
      }
      .card {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        padding: 16px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.04);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 20px;
      }
      label {
        display: block;
        margin-bottom: 6px;
        font-size: 14px;
        font-weight: 600;
      }
      textarea {
        width: 100%;
        min-height: 140px;
        resize: vertical;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 10px;
        font-size: 14px;
        box-sizing: border-box;
      }
      .row {
        display: flex;
        gap: 16px;
        margin-top: 12px;
        flex-wrap: wrap;
      }
      .check {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 14px;
        font-weight: 500;
      }
      .field {
        margin-top: 12px;
      }
      input[type="text"], input[type="password"] {
        width: 100%;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 10px;
        font-size: 14px;
        box-sizing: border-box;
      }
      button {
        border: none;
        border-radius: 8px;
        background: #111827;
        color: #fff;
        font-size: 14px;
        font-weight: 600;
        padding: 10px 14px;
        cursor: pointer;
      }
      button:disabled { opacity: 0.6; cursor: default; }
      pre {
        margin-top: 14px;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 10px;
        padding: 12px;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
      }
      .hint {
        margin-top: 10px;
        color: #6b7280;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>Manual Post Publisher</h1>
        <form id="publish-form">
          <label for="post-body">Post <span id="body-hint" style="font-weight:400;font-size:0.85em;color:#888;">(required for Discord; optional when using StockTwits batch below)</span></label>
          <textarea id="post-body" placeholder="Write your post..."></textarea>

          <div class="row">
            <label class="check">
              <input type="checkbox" name="platform" value="stocktwits" checked />
              StockTwits
            </label>
            <label class="check">
              <input type="checkbox" name="platform" value="discord" checked />
              Discord
            </label>
          </div>

          <div class="field">
            <label for="stocktwits-symbol">StockTwits Symbol (required when StockTwits is enabled)</label>
            <input id="stocktwits-symbol" type="text" placeholder="AAPL" />
          </div>

          <div class="field">
            <label for="stocktwits-account">StockTwits Account</label>
            <select id="stocktwits-account" style="width:100%;border:1px solid #d1d5db;border-radius:8px;padding:10px;font-size:14px;box-sizing:border-box;">
              <option value="">— Auto-select eligible account —</option>
            </select>
            <div class="hint">Accounts are configured in the <strong>Account Management</strong> section below. Auto-select picks the next eligible account based on health and cooldown.</div>
          </div>

          <div class="field">
            <label for="stocktwits-batch">StockTwits Multi-Symbol Posts (optional, one per line)</label>
            <textarea id="stocktwits-batch" placeholder="AAPL | Apple post text here\nTSLA | Tesla post text here"></textarea>
            <div class="hint">If provided, this batch takes precedence over the single symbol field. Format: SYMBOL | POST</div>
          </div>

          <div class="field">
            <label for="discord-server-url">Discord Server URL (optional)</label>
            <input id="discord-server-url" type="text" placeholder="https://discord.com/channels/<guild>/<channel>" />
          </div>

          <div class=”row” style=”margin-top:16px;align-items:center;”>
            <button type=”submit” id=”submit-btn”>Publish</button>
          </div>
          <pre id=”result”>No request yet.</pre>
        </form>
      </div>

      <div class=”card” style=”margin-top:24px;”>
        <h1>Account Management</h1>
        <p style=”font-size:13px;color:#6b7280;margin:0 0 16px;”>
          Add your Stocktwits accounts here. Get the <strong>dlvr.it Account ID</strong> from
          <strong>dlvrit.com → Profile → Connected Accounts</strong> after linking each Stocktwits account.
        </p>

        <table id=”accounts-table” style=”width:100%;border-collapse:collapse;font-size:13px;”>
          <thead>
            <tr style=”background:#f9fafb;”>
              <th style=”text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;”>Handle</th>
              <th style=”text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;”>dlvr.it ID</th>
              <th style=”text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;”>Status</th>
              <th style=”text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;”>Actions</th>
            </tr>
          </thead>
          <tbody id=”accounts-body”>
            <tr><td colspan=”4” style=”padding:12px;color:#9ca3af;”>Loading...</td></tr>
          </tbody>
        </table>

        <div style=”margin-top:16px;padding-top:16px;border-top:1px solid #e5e7eb;”>
          <h2 style=”font-size:15px;margin:0 0 12px;”>Add / Update Account</h2>
          <div style=”display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;”>
            <div style=”flex:1;min-width:140px;”>
              <label style=”display:block;font-size:13px;font-weight:600;margin-bottom:4px;”>Stocktwits Handle</label>
              <input id=”acc-handle” type=”text” placeholder=”e.g. myaccount” style=”width:100%;border:1px solid #d1d5db;border-radius:8px;padding:9px;font-size:13px;box-sizing:border-box;” />
            </div>
            <div style=”flex:1;min-width:140px;”>
              <label style=”display:block;font-size:13px;font-weight:600;margin-bottom:4px;”>dlvr.it Account ID</label>
              <input id=”acc-dlvrit-id” type=”number” placeholder=”e.g. 12345” style=”width:100%;border:1px solid #d1d5db;border-radius:8px;padding:9px;font-size:13px;box-sizing:border-box;” />
            </div>
            <button type=”button” id=”acc-save-btn” style=”padding:9px 18px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;”>Save</button>
          </div>
          <pre id=”acc-result” style=”margin-top:10px;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px;font-size:12px;white-space:pre-wrap;display:none;”></pre>
        </div>
      </div>
    </div>

    <script>
      const form = document.getElementById('publish-form');
      const bodyEl = document.getElementById('post-body');
      const stocktwitsSymbolEl = document.getElementById('stocktwits-symbol');
      const stocktwitsAccountEl = document.getElementById('stocktwits-account');
      const stocktwitsBatchEl = document.getElementById('stocktwits-batch');
      const discordServerUrlEl = document.getElementById('discord-server-url');
      const submitBtn = document.getElementById('submit-btn');
      const resultEl = document.getElementById('result');

      const accHandleEl = document.getElementById('acc-handle');
      const accDlvritIdEl = document.getElementById('acc-dlvrit-id');
      const accSaveBtn = document.getElementById('acc-save-btn');
      const accResultEl = document.getElementById('acc-result');
      const accountsBody = document.getElementById('accounts-body');

      const basePath = window.location.pathname.replace(/\\/$/, '');

      // ── Account management ──────────────────────────────────────────────────

      async function loadAccounts() {
        try {
          const res = await fetch(basePath + '/accounts');
          const json = await res.json();
          const accounts = json.accounts || [];

          // Populate dropdown
          const currentVal = stocktwitsAccountEl.value;
          stocktwitsAccountEl.innerHTML = '<option value="">— Auto-select eligible account —</option>';
          accounts.forEach((acc) => {
            if (acc.status === 'ACTIVE' && acc.dlvritAccountId) {
              const opt = document.createElement('option');
              opt.value = acc.accountHandle;
              opt.textContent = acc.accountHandle + ' (ID: ' + acc.dlvritAccountId + ')';
              stocktwitsAccountEl.appendChild(opt);
            }
          });
          if (currentVal) stocktwitsAccountEl.value = currentVal;

          // Populate table
          if (accounts.length === 0) {
            accountsBody.innerHTML = '<tr><td colspan="4" style="padding:12px;color:#9ca3af;">No accounts configured yet.</td></tr>';
            return;
          }
          accountsBody.innerHTML = accounts.map((acc) => \`
            <tr style="border-bottom:1px solid #f3f4f6;">
              <td style="padding:8px 10px;">\${acc.accountHandle}</td>
              <td style="padding:8px 10px;">\${acc.dlvritAccountId ?? '<span style="color:#ef4444">Not set</span>'}</td>
              <td style="padding:8px 10px;">
                <span style="padding:2px 8px;border-radius:12px;font-size:12px;background:\${acc.status === 'ACTIVE' ? '#dcfce7' : '#fee2e2'};color:\${acc.status === 'ACTIVE' ? '#16a34a' : '#dc2626'};">
                  \${acc.status}
                </span>
              </td>
              <td style="padding:8px 10px;display:flex;gap:6px;">
                <button onclick="editAccount('\${acc.accountHandle}', \${acc.dlvritAccountId})" style="padding:4px 10px;font-size:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">Edit</button>
                \${acc.status === 'ACTIVE'
                  ? \`<button onclick="toggleAccount('\${acc.id}', 'disable')" style="padding:4px 10px;font-size:12px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;">Disable</button>\`
                  : \`<button onclick="toggleAccount('\${acc.id}', 'enable')" style="padding:4px 10px;font-size:12px;background:#16a34a;color:#fff;border:none;border-radius:6px;cursor:pointer;">Enable</button>\`
                }
              </td>
            </tr>
          \`).join('');
        } catch (e) {
          accountsBody.innerHTML = '<tr><td colspan="4" style="padding:12px;color:#ef4444;">Failed to load accounts.</td></tr>';
        }
      }

      function editAccount(handle, dlvritId) {
        accHandleEl.value = handle;
        accDlvritIdEl.value = dlvritId || '';
        accHandleEl.focus();
      }

      async function toggleAccount(id, action) {
        await fetch(basePath + '/accounts/' + id + '/' + action, { method: 'PUT' });
        loadAccounts();
      }

      accSaveBtn.addEventListener('click', async () => {
        const handle = accHandleEl.value.trim();
        const dlvritId = parseInt(accDlvritIdEl.value.trim(), 10);
        if (!handle || !dlvritId) {
          accResultEl.style.display = 'block';
          accResultEl.textContent = 'Both Handle and dlvr.it ID are required.';
          return;
        }
        accSaveBtn.disabled = true;
        try {
          const res = await fetch(basePath + '/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountHandle: handle, dlvritAccountId: dlvritId }),
          });
          const json = await res.json();
          accResultEl.style.display = 'block';
          accResultEl.textContent = JSON.stringify(json, null, 2);
          if (json.success) {
            accHandleEl.value = '';
            accDlvritIdEl.value = '';
            loadAccounts();
          }
        } catch (e) {
          accResultEl.style.display = 'block';
          accResultEl.textContent = 'Error: ' + e.message;
        } finally {
          accSaveBtn.disabled = false;
        }
      });

      loadAccounts();

      // ── Publish form ────────────────────────────────────────────────────────

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        resultEl.textContent = '';

        try {
          const platforms = Array.from(document.querySelectorAll('input[name="platform"]:checked'))
            .map((input) => input.value);

          const batchLines = stocktwitsBatchEl.value
            .split('\\n')
            .map((line) => line.trim())
            .filter(Boolean);
          const stocktwitsItems = [];
          for (const line of batchLines) {
            const divider = line.indexOf('|');
            if (divider <= 0) {
              throw new Error('Invalid StockTwits batch row — use: SYMBOL | post text');
            }
            const symbol = line.slice(0, divider).trim().replace(/^\\$/, '');
            const rowBody = line.slice(divider + 1).trim();
            if (!symbol) throw new Error('Invalid StockTwits batch row — symbol is empty');
            if (!rowBody) throw new Error(\`StockTwits batch row for \${symbol} has no post text\`);
            stocktwitsItems.push({ symbol, body: rowBody });
          }

          const hasBatch = stocktwitsItems.length > 0;
          const publishesToDiscord = platforms.includes('discord');
          const publishesToStocktwits = platforms.includes('stocktwits');
          const bodyValue = bodyEl.value.trim();

          if (publishesToDiscord && !bodyValue) {
            bodyEl.focus();
            throw new Error('Post body is required when Discord is enabled.');
          }
          if (!hasBatch && publishesToStocktwits && !bodyValue) {
            bodyEl.focus();
            throw new Error('Post body is required when not using the StockTwits batch field.');
          }

          const payload = {
            body: bodyValue,
            platforms,
            stocktwitsSymbol: stocktwitsSymbolEl.value.trim() || undefined,
            stocktwitsAccountHandle: stocktwitsAccountEl.value || undefined,
            stocktwitsItems: hasBatch ? stocktwitsItems : undefined,
            discordServerUrl: discordServerUrlEl.value.trim() || undefined,
          };

          submitBtn.disabled = true;
          resultEl.textContent = 'Publishing…';

          const response = await fetch(basePath + '/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const json = await response.json();
          resultEl.textContent = JSON.stringify(json, null, 2);
        } catch (error) {
          resultEl.textContent = '⚠ ' + String(error instanceof Error ? error.message : error);
        } finally {
          submitBtn.disabled = false;
        }
      });
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

    return this.publishingService.publishManualPost({
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
    });
  }
}

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

  @Post('dlvrit-session')
  async setDlvritSession(
    @Body() body: { cookie: string },
  ): Promise<Record<string, unknown>> {
    if (!body.cookie || !body.cookie.trim()) {
      return { success: false, error: 'cookie value is required.' };
    }
    this.publishingService.setDlvritSessionCookie(body.cookie.trim());
    return { success: true };
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
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Manual Publisher</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
        background: #f5f7fb;
        color: #111827;
      }
      .wrap { max-width: 780px; margin: 36px auto; padding: 0 20px 60px; }

      /* Card */
      .card {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        padding: 28px;
        box-shadow: 0 2px 12px rgba(0,0,0,0.05);
      }
      .card + .card { margin-top: 24px; }
      .card-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 24px;
      }
      .card-header h1 { margin: 0; font-size: 18px; font-weight: 700; }
      .card-header p  { margin: 4px 0 0; font-size: 13px; color: #6b7280; }

      /* Form elements */
      .field { margin-top: 18px; }
      .field:first-child { margin-top: 0; }
      label {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
        font-weight: 600;
        color: #374151;
      }
      input[type="text"],
      input[type="number"],
      select,
      textarea {
        width: 100%;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 14px;
        font-family: inherit;
        color: #111827;
        background: #fff;
        transition: border-color .15s;
        outline: none;
      }
      input[type="text"]:focus,
      input[type="number"]:focus,
      select:focus,
      textarea:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
      textarea { min-height: 130px; resize: vertical; }
      .hint { margin-top: 6px; font-size: 12px; color: #9ca3af; line-height: 1.5; }

      /* Checkboxes row */
      .platforms { display: flex; gap: 20px; margin-top: 18px; flex-wrap: wrap; }
      .check {
        display: inline-flex; align-items: center; gap: 8px;
        font-size: 14px; font-weight: 500; cursor: pointer;
      }
      .check input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; }

      /* Buttons */
      .btn {
        display: inline-flex; align-items: center; gap: 6px;
        border: none; border-radius: 8px;
        font-size: 14px; font-weight: 600; font-family: inherit;
        padding: 10px 18px; cursor: pointer; transition: opacity .15s;
      }
      .btn:disabled { opacity: .55; cursor: default; }
      .btn-primary  { background: #111827; color: #fff; }
      .btn-success  { background: #16a34a; color: #fff; }
      .btn-blue     { background: #2563eb; color: #fff; }
      .btn-danger   { background: #dc2626; color: #fff; }
      .btn-ghost    {
        background: transparent; color: #374151;
        border: 1px solid #d1d5db;
      }
      .btn-sm { padding: 5px 12px; font-size: 12px; border-radius: 6px; }
      .btn:hover:not(:disabled) { opacity: .85; }

      /* Result pre */
      pre.result {
        margin-top: 18px;
        background: #0f172a; color: #e2e8f0;
        border-radius: 10px; padding: 14px;
        white-space: pre-wrap; word-break: break-word;
        font-size: 12px; line-height: 1.6;
      }

      /* Divider */
      .divider { border: none; border-top: 1px solid #f3f4f6; margin: 24px 0; }

      /* Accounts table */
      .acc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .acc-table th {
        text-align: left; padding: 10px 12px;
        background: #f9fafb; border-bottom: 1px solid #e5e7eb;
        font-size: 12px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: .04em;
      }
      .acc-table td { padding: 12px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
      .acc-table tr:last-child td { border-bottom: none; }
      .acc-table tr.selected td { background: #eff6ff; }
      .acc-table .actions { display: flex; gap: 8px; }
      .acc-table input[type="checkbox"] { width: 15px; height: 15px; cursor: pointer; accent-color: #6366f1; }

      /* Bulk toolbar */
      .bulk-toolbar {
        display: none; align-items: center; gap: 12px;
        padding: 10px 14px; margin-bottom: 14px;
        background: #eff6ff; border: 1px solid #bfdbfe;
        border-radius: 8px; font-size: 13px; color: #1d4ed8;
      }
      .bulk-toolbar.visible { display: flex; }
      .bulk-toolbar span { flex: 1; font-weight: 500; }
      .badge {
        display: inline-flex; align-items: center;
        padding: 3px 10px; border-radius: 20px;
        font-size: 11px; font-weight: 600; letter-spacing: .03em;
      }
      .badge-active   { background: #dcfce7; color: #15803d; }
      .badge-inactive { background: #fee2e2; color: #b91c1c; }
      .badge-warn     { background: #fef9c3; color: #854d0e; }

      /* Empty state */
      .empty-state {
        text-align: center; padding: 36px 16px; color: #9ca3af; font-size: 13px;
      }
      .empty-state svg { display: block; margin: 0 auto 12px; opacity: .4; }

      /* Modal */
      .modal-overlay {
        display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,.45); z-index: 100;
        align-items: center; justify-content: center;
      }
      .modal-overlay.open { display: flex; }
      .modal {
        background: #fff; border-radius: 14px;
        padding: 28px; width: 100%; max-width: 440px;
        box-shadow: 0 20px 60px rgba(0,0,0,.2);
        animation: modalIn .18s ease;
      }
      @keyframes modalIn {
        from { transform: translateY(-12px); opacity: 0; }
        to   { transform: translateY(0);     opacity: 1; }
      }
      .modal h2 { margin: 0 0 20px; font-size: 16px; font-weight: 700; }
      .modal .field { margin-top: 16px; }
      .modal .field:first-of-type { margin-top: 0; }
      .modal-footer {
        display: flex; gap: 10px; justify-content: flex-end;
        margin-top: 24px; padding-top: 20px; border-top: 1px solid #f3f4f6;
      }
      .modal-error {
        margin-top: 14px; padding: 10px 12px;
        background: #fef2f2; border: 1px solid #fecaca;
        border-radius: 8px; color: #b91c1c; font-size: 13px; display: none;
      }
    </style>
  </head>
  <body>
    <div class="wrap">

      <!-- ── Publish Card ─────────────────────────────────────────────────── -->
      <div class="card">
        <div class="card-header">
          <div>
            <h1>Manual Post Publisher</h1>
            <p>Publish directly to StockTwits symbol streams and Discord.</p>
          </div>
        </div>

        <form id="publish-form">
          <div class="field">
            <label for="post-body">Post Body <span style="font-weight:400;color:#9ca3af;">(required for Discord; optional when using batch below)</span></label>
            <textarea id="post-body" placeholder="Write your post..."></textarea>
          </div>

          <div class="platforms">
            <label class="check"><input type="checkbox" name="platform" value="stocktwits" checked /> StockTwits</label>
            <label class="check"><input type="checkbox" name="platform" value="discord" checked /> Discord</label>
          </div>

          <div class="field">
            <label for="stocktwits-symbol">StockTwits Symbol</label>
            <input id="stocktwits-symbol" type="text" placeholder="e.g. AAPL" />
          </div>

          <div class="field">
            <label for="stocktwits-account">StockTwits Account</label>
            <select id="stocktwits-account">
              <option value="">— Auto-select eligible account —</option>
            </select>
            <div class="hint">Leave on auto to rotate through healthy accounts. Manage accounts below.</div>
          </div>

          <div class="field">
            <label for="stocktwits-batch">Multi-Symbol Batch <span style="font-weight:400;color:#9ca3af;">(optional — overrides symbol field)</span></label>
            <textarea id="stocktwits-batch" style="min-height:90px;" placeholder="AAPL | Apple looking strong today&#10;TSLA | Tesla breaking out"></textarea>
            <div class="hint">One post per line. Format: <code style="background:#f3f4f6;padding:1px 5px;border-radius:4px;">SYMBOL | post text</code></div>
          </div>

          <div class="field">
            <label for="discord-server-url">Discord Server URL <span style="font-weight:400;color:#9ca3af;">(optional)</span></label>
            <input id="discord-server-url" type="text" placeholder="https://discord.com/channels/..." />
          </div>

          <hr class="divider" />

          <div style="display:flex;gap:10px;align-items:center;">
            <button type="submit" id="submit-btn" class="btn btn-primary">Publish</button>
            <span id="publish-status" style="font-size:13px;color:#6b7280;"></span>
          </div>
          <pre id="result" class="result" style="display:none;"></pre>
        </form>
      </div>

      <!-- ── Account Management Card ──────────────────────────────────────── -->
      <div class="card">
        <div class="card-header">
          <div>
            <h1>Account Management</h1>
            <p>Configure Stocktwits accounts linked to dlvr.it for posting.</p>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost" onclick="openCookieModal()" style="border:1px solid #d1d5db;">Set dlvr.it Cookie</button>
            <button class="btn btn-primary" onclick="openModal()">+ Add Account</button>
          </div>
        </div>

        <!-- Bulk action toolbar — shown when ≥1 row is checked -->
        <div class="bulk-toolbar" id="bulk-toolbar">
          <span id="bulk-label">0 selected</span>
          <button class="btn btn-sm btn-danger" onclick="deleteSelected()">Delete Selected</button>
          <button class="btn btn-sm btn-ghost" onclick="clearSelection()">Clear</button>
        </div>

        <table class="acc-table">
          <thead>
            <tr>
              <th style="width:36px;"><input type="checkbox" id="select-all" title="Select all" onchange="toggleSelectAll(this)" /></th>
              <th>Handle</th>
              <th>dlvr.it Route ID</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="accounts-body">
            <tr><td colspan="5"><div class="empty-state">Loading...</div></td></tr>
          </tbody>
        </table>

        <p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">
          Create a Route in <strong>dlvrit.com</strong> with StockTwits as the destination, then click <strong>+ Add Account</strong> and use <strong>Fetch from dlvr.it</strong> to pick the Route ID.
        </p>
      </div>
    </div>

    <!-- ── Modal ──────────────────────────────────────────────────────────── -->
    <div class="modal-overlay" id="modal-overlay" onclick="handleOverlayClick(event)">
      <div class="modal">
        <h2 id="modal-title">Add Account</h2>

        <div class="field">
          <label for="modal-handle">Stocktwits Handle</label>
          <input id="modal-handle" type="text" placeholder="e.g. myaccount" autocomplete="off" />
        </div>

        <div class="field">
          <label for="modal-dlvrit-id">dlvr.it Route ID</label>
          <div style="display:flex;gap:8px;align-items:flex-start;">
            <input id="modal-dlvrit-id" type="number" placeholder="e.g. 2676570" autocomplete="off" style="flex:1;" />
            <button type="button" class="btn btn-ghost" id="fetch-dlvrit-btn" onclick="fetchDlvritAccounts()" style="white-space:nowrap;border:1px solid #d1d5db;">Fetch from dlvr.it</button>
          </div>
          <div class="hint">Click <strong>Fetch from dlvr.it</strong> to load your routes, or enter the Route ID manually from dlvrit.com.</div>
          <div id="dlvrit-account-picker" style="display:none;margin-top:10px;">
            <label style="font-size:12px;color:#6b7280;margin-bottom:4px;display:block;">Pick a route:</label>
            <select id="dlvrit-account-select" style="width:100%;" onchange="onDlvritAccountSelected(this)">
              <option value="">— select —</option>
            </select>
          </div>
          <div id="dlvrit-fetch-error" style="display:none;margin-top:6px;font-size:12px;color:#ef4444;"></div>
        </div>

        <div class="modal-error" id="modal-error"></div>

        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
          <button class="btn btn-success" id="modal-save-btn" onclick="saveAccount()">Save Account</button>
        </div>
      </div>
    </div>

    <!-- ── Cookie Modal ───────────────────────────────────────────────────── -->
    <div class="modal-overlay" id="cookie-overlay" onclick="if(event.target===this)closeCookieModal()" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.45);z-index:1000;align-items:center;justify-content:center;">
      <div class="modal" style="max-width:500px;width:90%;padding:28px;">
        <h2>Set dlvr.it Session Cookie</h2>
        <p style="font-size:13px;color:#6b7280;margin:8px 0 16px;">
          In your browser, open <strong>app.dlvrit.com</strong>, press <strong>F12</strong> → Application → Cookies →
          <strong>dlvrit.com</strong>, find the cookie named <strong>dlvrit</strong>, and paste its value below.
        </p>
        <div class="field">
          <label for="cookie-input">dlvrit cookie value</label>
          <input id="cookie-input" type="text" placeholder="Paste cookie value here…" autocomplete="off" style="font-family:monospace;font-size:12px;" />
        </div>
        <div class="modal-error" id="cookie-error" style="display:none;"></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" onclick="closeCookieModal()">Cancel</button>
          <button class="btn btn-success" id="cookie-save-btn" onclick="saveCookie()">Save Cookie</button>
        </div>
      </div>
    </div>

    <script>
      const basePath = window.location.pathname.replace(/\\/$/, '');

      // ── Cookie Modal ────────────────────────────────────────────────────────
      function openCookieModal() {
        document.getElementById('cookie-input').value = '';
        document.getElementById('cookie-error').style.display = 'none';
        const co = document.getElementById('cookie-overlay');
        co.style.display = 'flex';
        setTimeout(() => document.getElementById('cookie-input').focus(), 80);
      }
      function closeCookieModal() {
        document.getElementById('cookie-overlay').style.display = 'none';
      }
      async function saveCookie() {
        const val = document.getElementById('cookie-input').value.trim();
        const errEl = document.getElementById('cookie-error');
        const btn = document.getElementById('cookie-save-btn');
        if (!val) { errEl.textContent = 'Cookie value is required.'; errEl.style.display = 'block'; return; }
        btn.disabled = true; btn.textContent = 'Saving…'; errEl.style.display = 'none';
        try {
          const res = await fetch(basePath + '/dlvrit-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookie: val }),
          });
          const json = await res.json();
          if (!json.success) { errEl.textContent = json.error || 'Failed to save cookie.'; errEl.style.display = 'block'; return; }
          closeCookieModal();
          alert('dlvr.it session cookie saved successfully. Next post will use it.');
        } catch (e) {
          errEl.textContent = 'Network error: ' + e.message; errEl.style.display = 'block';
        } finally {
          btn.disabled = false; btn.textContent = 'Save Cookie';
        }
      }

      // ── Account Modal ───────────────────────────────────────────────────────
      const overlay     = document.getElementById('modal-overlay');
      const modalTitle  = document.getElementById('modal-title');
      const modalHandle = document.getElementById('modal-handle');
      const modalId     = document.getElementById('modal-dlvrit-id');
      const modalError  = document.getElementById('modal-error');
      const modalSaveBtn = document.getElementById('modal-save-btn');

      function openModal(handle, dlvritId) {
        modalHandle.value  = handle  || '';
        modalId.value      = dlvritId || '';
        modalTitle.textContent = handle ? 'Edit Account' : 'Add Account';
        modalError.style.display = 'none';
        modalError.textContent   = '';
        overlay.classList.add('open');
        setTimeout(() => modalHandle.focus(), 80);
      }

      function closeModal() {
        overlay.classList.remove('open');
        document.getElementById('dlvrit-account-picker').style.display = 'none';
        document.getElementById('dlvrit-fetch-error').style.display = 'none';
      }

      async function fetchDlvritAccounts() {
        const btn = document.getElementById('fetch-dlvrit-btn');
        const picker = document.getElementById('dlvrit-account-picker');
        const select = document.getElementById('dlvrit-account-select');
        const errEl = document.getElementById('dlvrit-fetch-error');

        btn.disabled = true;
        btn.textContent = 'Loading…';
        errEl.style.display = 'none';
        picker.style.display = 'none';

        try {
          const res = await fetch(basePath + '/dlvrit-connected-accounts');
          const json = await res.json();
          if (!json.success) {
            errEl.textContent = json.error || 'Failed to fetch accounts from dlvr.it';
            errEl.style.display = 'block';
            return;
          }
          const accounts = json.accounts || [];
          if (!accounts.length) {
            errEl.textContent = 'No routes found in dlvr.it. Create a route with StockTwits as a destination at dlvrit.com first.';
            errEl.style.display = 'block';
            return;
          }
          select.innerHTML = '<option value="">— select —</option>';
          accounts.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.id;
            opt.dataset.name = a.name;
            opt.textContent = '[' + a.id + '] ' + a.name;
            select.appendChild(opt);
          });
          picker.style.display = 'block';
        } catch (e) {
          errEl.textContent = 'Network error: ' + e.message;
          errEl.style.display = 'block';
        } finally {
          btn.disabled = false;
          btn.textContent = 'Fetch from dlvr.it';
        }
      }

      function onDlvritAccountSelected(sel) {
        const val = sel.value;
        if (val) {
          document.getElementById('modal-dlvrit-id').value = val;
          // Pre-fill handle from account name if handle field is empty
          const handle = document.getElementById('modal-handle');
          if (!handle.value.trim()) {
            const selectedOpt = sel.options[sel.selectedIndex];
            handle.value = selectedOpt.dataset.name || '';
          }
        }
      }

      function handleOverlayClick(e) {
        if (e.target === overlay) closeModal();
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeModal(); closeCookieModal(); }
      });

      async function saveAccount() {
        const handle   = modalHandle.value.trim();
        const dlvritId = parseInt(modalId.value.trim(), 10);

        if (!handle) {
          showModalError('Stocktwits handle is required.');
          modalHandle.focus();
          return;
        }
        if (!dlvritId || dlvritId <= 0) {
          showModalError('A valid dlvr.it Account ID is required.');
          modalId.focus();
          return;
        }

        modalSaveBtn.disabled = true;
        modalSaveBtn.textContent = 'Saving…';
        modalError.style.display = 'none';

        try {
          const res = await fetch(basePath + '/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountHandle: handle, dlvritAccountId: dlvritId }),
          });
          const json = await res.json();
          if (!json.success) {
            showModalError(json.error || 'Failed to save account.');
            return;
          }
          closeModal();
          await loadAccounts();
        } catch (e) {
          showModalError('Network error: ' + e.message);
        } finally {
          modalSaveBtn.disabled = false;
          modalSaveBtn.textContent = 'Save Account';
        }
      }

      function showModalError(msg) {
        modalError.textContent = msg;
        modalError.style.display = 'block';
      }

      // ── Accounts table ──────────────────────────────────────────────────────
      const accountsBody      = document.getElementById('accounts-body');
      const stocktwitsAccount = document.getElementById('stocktwits-account');
      const bulkToolbar       = document.getElementById('bulk-toolbar');
      const bulkLabel         = document.getElementById('bulk-label');
      const selectAllCb       = document.getElementById('select-all');

      function getCheckedIds() {
        return Array.from(accountsBody.querySelectorAll('input[type="checkbox"]:checked'))
          .map(cb => cb.dataset.id);
      }

      function updateBulkToolbar() {
        const ids = getCheckedIds();
        if (ids.length > 0) {
          bulkLabel.textContent = ids.length + ' account' + (ids.length > 1 ? 's' : '') + ' selected';
          bulkToolbar.classList.add('visible');
        } else {
          bulkToolbar.classList.remove('visible');
        }
        // Sync select-all checkbox state
        const all = accountsBody.querySelectorAll('input[type="checkbox"]');
        selectAllCb.indeterminate = ids.length > 0 && ids.length < all.length;
        selectAllCb.checked = all.length > 0 && ids.length === all.length;
      }

      function toggleSelectAll(cb) {
        accountsBody.querySelectorAll('input[type="checkbox"]').forEach(c => {
          c.checked = cb.checked;
          c.closest('tr').classList.toggle('selected', cb.checked);
        });
        updateBulkToolbar();
      }

      function clearSelection() {
        accountsBody.querySelectorAll('input[type="checkbox"]').forEach(c => {
          c.checked = false;
          c.closest('tr').classList.remove('selected');
        });
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
        updateBulkToolbar();
      }

      async function deleteSelected() {
        const ids = getCheckedIds();
        if (!ids.length) return;
        const label = ids.length === 1 ? '1 account' : ids.length + ' accounts';
        if (!confirm('Permanently delete ' + label + '? This cannot be undone.')) return;
        try {
          const res = await fetch(basePath + '/accounts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
          });
          const json = await res.json();
          if (!json.success) { alert('Delete failed: ' + (json.error || 'unknown error')); return; }
          await loadAccounts();
        } catch (e) {
          alert('Delete failed: ' + e.message);
        }
      }

      async function deleteSingle(id, handle) {
        if (!confirm('Permanently delete "' + handle + '"? This cannot be undone.')) return;
        try {
          const res = await fetch(basePath + '/accounts', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids: [id] }),
          });
          const json = await res.json();
          if (!json.success) { alert('Delete failed: ' + (json.error || 'unknown error')); return; }
          await loadAccounts();
        } catch (e) {
          alert('Delete failed: ' + e.message);
        }
      }

      async function loadAccounts() {
        try {
          const res  = await fetch(basePath + '/accounts');
          const json = await res.json();
          const accounts = json.accounts || [];

          // Refresh dropdown
          const prev = stocktwitsAccount.value;
          stocktwitsAccount.innerHTML = '<option value="">— Auto-select eligible account —</option>';
          accounts.filter(a => a.status === 'ACTIVE' && a.dlvritAccountId).forEach(a => {
            const opt = document.createElement('option');
            opt.value       = a.accountHandle;
            opt.textContent = a.accountHandle + '  (ID: ' + a.dlvritAccountId + ')';
            stocktwitsAccount.appendChild(opt);
          });
          if (prev) stocktwitsAccount.value = prev;

          // Reset selection state
          selectAllCb.checked      = false;
          selectAllCb.indeterminate = false;
          bulkToolbar.classList.remove('visible');

          // Render table
          if (!accounts.length) {
            accountsBody.innerHTML = \`
              <tr><td colspan="5">
                <div class="empty-state">
                  <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/>
                  </svg>
                  No accounts yet. Click <strong>+ Add Account</strong> to get started.
                </div>
              </td></tr>\`;
            return;
          }

          accountsBody.innerHTML = accounts.map(a => {
            const badgeClass = a.dlvritAccountId
              ? (a.status === 'ACTIVE' ? 'badge-active' : 'badge-inactive')
              : 'badge-warn';
            const badgeLabel = a.dlvritAccountId
              ? (a.status === 'ACTIVE' ? 'Active' : 'Disabled')
              : 'Not configured';
            const idCell = a.dlvritAccountId
              ? \`<code style="background:#f3f4f6;padding:2px 7px;border-radius:5px;font-size:12px;">\${a.dlvritAccountId}</code>\`
              : \`<span style="color:#9ca3af;font-style:italic;">—</span>\`;
            const toggleBtn = a.status === 'ACTIVE'
              ? \`<button class="btn btn-sm btn-danger" onclick="toggleAccount('\${a.id}','disable')">Disable</button>\`
              : \`<button class="btn btn-sm btn-success" onclick="toggleAccount('\${a.id}','enable')">Enable</button>\`;
            return \`
              <tr>
                <td><input type="checkbox" data-id="\${a.id}" onchange="onRowCheck(this)" /></td>
                <td><strong style="font-size:13px;">\${a.accountHandle}</strong></td>
                <td>\${idCell}</td>
                <td><span class="badge \${badgeClass}">\${badgeLabel}</span></td>
                <td>
                  <div class="actions">
                    <button class="btn btn-sm btn-blue" onclick="openModal('\${a.accountHandle}', \${a.dlvritAccountId || ''})">Edit</button>
                    \${toggleBtn}
                    <button class="btn btn-sm btn-danger" onclick="deleteSingle('\${a.id}','\${a.accountHandle}')">Delete</button>
                  </div>
                </td>
              </tr>\`;
          }).join('');
        } catch {
          accountsBody.innerHTML = '<tr><td colspan="5" style="padding:16px;color:#ef4444;font-size:13px;">Failed to load accounts.</td></tr>';
        }
      }

      function onRowCheck(cb) {
        cb.closest('tr').classList.toggle('selected', cb.checked);
        updateBulkToolbar();
      }

      async function toggleAccount(id, action) {
        await fetch(basePath + '/accounts/' + id + '/' + action, { method: 'PUT' });
        loadAccounts();
      }

      loadAccounts();

      // ── Publish form ────────────────────────────────────────────────────────
      const form            = document.getElementById('publish-form');
      const bodyEl          = document.getElementById('post-body');
      const symbolEl        = document.getElementById('stocktwits-symbol');
      const batchEl         = document.getElementById('stocktwits-batch');
      const discordUrlEl    = document.getElementById('discord-server-url');
      const submitBtn       = document.getElementById('submit-btn');
      const publishStatus   = document.getElementById('publish-status');
      const resultEl        = document.getElementById('result');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        resultEl.style.display = 'none';
        publishStatus.textContent = '';

        try {
          const platforms = Array.from(document.querySelectorAll('input[name="platform"]:checked')).map(i => i.value);

          const batchLines = batchEl.value.split('\\n').map(l => l.trim()).filter(Boolean);
          const stocktwitsItems = [];
          for (const line of batchLines) {
            const div = line.indexOf('|');
            if (div <= 0) throw new Error('Invalid batch row — use: SYMBOL | post text');
            const symbol  = line.slice(0, div).trim().replace(/^\\$/, '');
            const rowBody = line.slice(div + 1).trim();
            if (!symbol)  throw new Error('Batch row has empty symbol');
            if (!rowBody) throw new Error(\`Batch row for \${symbol} has no text\`);
            stocktwitsItems.push({ symbol, body: rowBody });
          }

          const hasBatch = stocktwitsItems.length > 0;
          const bodyValue = bodyEl.value.trim();

          if (platforms.includes('discord') && !bodyValue) {
            bodyEl.focus(); throw new Error('Post body is required when Discord is enabled.');
          }
          if (!hasBatch && platforms.includes('stocktwits') && !bodyValue) {
            bodyEl.focus(); throw new Error('Post body is required when not using batch mode.');
          }

          const payload = {
            body: bodyValue,
            platforms,
            stocktwitsSymbol: symbolEl.value.trim() || undefined,
            stocktwitsAccountHandle: stocktwitsAccount.value || undefined,
            stocktwitsItems: hasBatch ? stocktwitsItems : undefined,
            discordServerUrl: discordUrlEl.value.trim() || undefined,
          };

          submitBtn.disabled = true;
          publishStatus.textContent = 'Publishing…';

          const res  = await fetch(basePath + '/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const json = await res.json();
          publishStatus.textContent = '';
          resultEl.style.display = 'block';
          resultEl.textContent = JSON.stringify(json, null, 2);
        } catch (err) {
          publishStatus.textContent = '';
          resultEl.style.display = 'block';
          resultEl.textContent = '⚠ ' + String(err instanceof Error ? err.message : err);
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

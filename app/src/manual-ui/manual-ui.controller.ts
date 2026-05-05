import { Body, Controller, Get, Header, Post } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { PublishingService } from '../publishing/publishing.service';

type ManualUiPublishBody = {
  body?: string;
  platforms?: string[];
  discordServerUrl?: string;
};

@Controller('manual-ui')
@Public()
export class ManualUiController {
  constructor(private readonly publishingService: PublishingService) {}

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
      input[type="text"] {
        width: 100%;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        padding: 10px;
        font-size: 14px;
        box-sizing: border-box;
      }
      button {
        margin-top: 16px;
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
          <label for="post-body">Post</label>
          <textarea id="post-body" required placeholder="Write your post..."></textarea>

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
            <label for="discord-server-url">Discord Server URL (optional)</label>
            <input id="discord-server-url" type="text" placeholder="https://discord.com/channels/<guild>/<channel>" />
          </div>

          <button type="submit" id="submit-btn">Publish</button>
          <div class="hint">Only basic publish controls are shown by design.</div>
          <pre id="result">No request yet.</pre>
        </form>
      </div>
    </div>

    <script>
      const form = document.getElementById('publish-form');
      const bodyEl = document.getElementById('post-body');
      const discordServerUrlEl = document.getElementById('discord-server-url');
      const submitBtn = document.getElementById('submit-btn');
      const resultEl = document.getElementById('result');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const platforms = Array.from(document.querySelectorAll('input[name="platform"]:checked'))
          .map((input) => input.value);

        const payload = {
          body: bodyEl.value,
          platforms,
          discordServerUrl: discordServerUrlEl.value.trim() || undefined
        };

        submitBtn.disabled = true;
        resultEl.textContent = 'Publishing...';

        const publishUrl = window.location.pathname.replace(/\\/$/, '') + '/publish';
        try {
          const response = await fetch(publishUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const json = await response.json();
          resultEl.textContent = JSON.stringify(json, null, 2);
        } catch (error) {
          resultEl.textContent = String(error);
        } finally {
          submitBtn.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
  }

  @Post('publish')
  async publish(@Body() body: ManualUiPublishBody): Promise<Record<string, unknown>> {
    const platforms = Array.isArray(body.platforms) ? body.platforms : [];

    return this.publishingService.publishManualPost({
      body: body.body ?? '',
      publishToStocktwits: platforms.includes('stocktwits'),
      publishToDiscord: platforms.includes('discord'),
      discordServerUrl: body.discordServerUrl,
    });
  }
}

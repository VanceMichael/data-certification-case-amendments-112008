import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { normalizeAmendment } from './amendment.mjs';
import { errorPayload, PortalError } from './errors.mjs';
import { Portal } from './portal.mjs';
import { CaseRunner } from './runner.mjs';

const UI = new URL('./ui.html', import.meta.url);
const JSON_LIMIT = 64 * 1024;

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > JSON_LIMIT) throw new PortalError('payload-too-large', '请求体过大');
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new PortalError('bad-json', '请求体不是合法 JSON');
  }
}

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export function createApp({ sourceUrl = 'http://127.0.0.1:4173', amendment } = {}) {
  let portal = null;
  let runner = null;
  let starting = null;

  const ensureRunner = async (raw) => {
    const normalized = normalizeAmendment(raw);
    if (!runner || JSON.stringify(runner.amendment) !== JSON.stringify(normalized)) {
      await portal?.close();
      portal = new Portal(sourceUrl);
      runner = new CaseRunner(portal, normalized);
      starting = portal.launch();
    }
    await starting;
    return runner;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/ui.js') {
        const js = await (await import('node:fs/promises')).readFile(fileURLToPath(new URL('./ui.js', import.meta.url)), 'utf8');
        return send(response, 200, js, 'text/javascript; charset=utf-8');
      }
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await (await import('node:fs/promises')).readFile(fileURLToPath(UI), 'utf8');
        return send(response, 200, html, 'text/html; charset=utf-8');
      }

      if (request.method === 'GET' && url.pathname === '/api/state') {
        return send(response, 200, {
          configured: Boolean(runner),
          state: runner?.report() ?? null,
          amendment: runner?.amendment ?? null,
          sourceUrl,
        });
      }

      if (request.method === 'POST' && url.pathname === '/api/session') {
        const body = await readJson(request);
        const current = await ensureRunner(body.amendment ?? amendment);
        return send(response, 200, { ok: true, state: current.report() });
      }

      if (request.method === 'POST' && url.pathname === '/api/reset') {
        await portal?.close();
        portal = null;
        runner = null;
        starting = null;
        return send(response, 200, { ok: true });
      }

      if (!runner) return send(response, 409, { error: { code: 'no-session', message: '请先提交变更资料建立办理会话' } });

      if (request.method === 'POST' && url.pathname === '/api/inspect') {
        const result = await runner.inspect();
        return send(response, 200, { result, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/review') {
        const result = await runner.openReview();
        return send(response, 200, { result, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/approve') {
        const body = await readJson(request);
        if (!body.approver?.trim()) throw new PortalError('approver-required', '请填写经办人');
        const approval = runner.approve(body.approver.trim());
        return send(response, 200, { approval, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/submit') {
        const result = await runner.submit();
        return send(response, 200, { result, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/receipt') {
        const result = await runner.refreshReceipt();
        return send(response, 200, { result, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/continuation') {
        const result = await runner.prepareContinuation();
        return send(response, 200, { result, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/continuation/approve') {
        const body = await readJson(request);
        if (!body.approver?.trim()) throw new PortalError('approver-required', '请填写继续办理的确认人');
        const approval = await runner.approveContinuation(body.approver.trim());
        return send(response, 200, { approval, state: runner.report() });
      }
      if (request.method === 'POST' && url.pathname === '/api/continuation/submit') {
        const result = await runner.submitContinuation();
        return send(response, 200, { result, state: runner.report() });
      }
      return send(response, 404, { error: { code: 'not-found', message: '本地代办没有这条路径' } });
    } catch (error) {
      const payload = errorPayload(error);
      const status = error instanceof PortalError && error.code === 'stale-approval' ? 409 : 400;
      return send(response, status, { error: payload, state: runner?.report() ?? null });
    }
  });

  server.on('close', () => {
    portal?.close().catch(() => {});
  });

  return server;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.APP_PORT ?? process.env.PORT ?? 4180);
  const sourceUrl = process.env.SOURCE_URL ?? 'http://127.0.0.1:4173';
  createApp({ sourceUrl }).listen(port, '127.0.0.1', function () {
    process.stdout.write(`代办控制台 http://127.0.0.1:${this.address().port}\n`);
  });
}

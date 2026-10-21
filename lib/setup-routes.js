/**
 * 界面的服务端：一个给面板读写的 JSON 接口，以及把它挂到 DSH 的 web 服务上。
 *
 * 只做两件事：
 *   GET  /dsh-mail/api/accounts   →  { saved, config, providers }   （侧栏页面读）
 *   POST /dsh-mail/api/accounts   →  { action: 'save' | 'delete', ... }
 * 另加 /dsh-mail/health 与 /dsh-mail/mounted 两条诊断路由。
 *
 * 安全边界（这是个只在回环上跑的本地接口，但它能覆盖邮箱凭据，所以不做裸奔）：
 *   1. Host 必须是回环权威 —— 挡 DNS 重绑定（把 127.0.0.1 解析到攻击者的域名）。
 *   2. `Sec-Fetch-Site: cross-site` 一律拒 —— 挡普通跨站表单/脚本直接 POST。
 *   3. 带 Origin 时必须同源（或来自桌面壳的 dsh-app://）。
 * 也就是说，别的网页既不能读你已存的授权码，也不能替你把它改掉。
 */
import { readAccountsFile, sanitizeAccountEntry, writeAccountsFile } from './accounts-file.js';

const MAX_BODY_BYTES = 64 * 1024;

/** loopback-ish host? (127.0.0.0/8, localhost, [::1]) */
export function isLoopbackHostname(hostname) {
  const h = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === '') return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  const m = h.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return Boolean(m) && m.slice(1).every((n) => Number(n) <= 255);
}

function hostnameOf(authority) {
  const a = String(authority ?? '').trim();
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end > 0 ? a.slice(1, end) : a;
  }
  return a.split(':')[0];
}

/** Should this request be refused? */
export function rejectReason(headers = {}) {
  const host = hostnameOf(headers.host ?? headers.Host);
  if (!isLoopbackHostname(host)) return 'host-not-loopback';

  if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return 'cross-site';

  const origin = headers.origin ?? headers.Origin;
  if (origin) {
    let parsed;
    try {
      parsed = new URL(String(origin));
    } catch {
      return 'bad-origin';
    }
    if (parsed.protocol === 'dsh-app:') return null; // 桌面壳自己的页面
    if (!isLoopbackHostname(parsed.hostname)) return 'origin-not-loopback';
  }
  return null;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{
 *   env?: Record<string,string|undefined>,
 *   listSaved?: () => Array<object>,
 *   listConfig?: () => Array<object>,
 *   providers?: Array<{id:string,label:string}>,
 * }} options
 */
export function createSetupApi(options = {}) {
  const env = options.env ?? process.env;
  const listConfig = options.listConfig ?? (() => []);
  const providers = options.providers ?? [];

  const listSaved = () => {
    if (options.listSaved) return options.listSaved();
    const { accounts } = readAccountsFile(env);
    return accounts.map((a) => ({
      id: String(a.id ?? ''),
      address: a.address ?? '',
      provider: a.provider ?? null,
      label: a.label ?? null,
      hasSecret: Boolean(a.password),
    }));
  };

  async function handle(req, res) {
    const reason = rejectReason(req.headers);
    if (reason) {
      sendJson(res, 403, { error: `拒绝访问（${reason}）` });
      return;
    }

    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { saved: listSaved(), config: listConfig(), providers });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '只支持 GET / POST' });
        return;
      }

      const text = await readBody(req);
      let payload;
      try {
        payload = JSON.parse(text || '{}');
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' });
        return;
      }

      const action = String(payload.action ?? '');
      const current = readAccountsFile(env).accounts;

      if (action === 'delete') {
        const id = String(payload.id ?? '').trim();
        if (!id) {
          sendJson(res, 400, { error: '缺少 id' });
          return;
        }
        const next = current.filter((a) => String(a.id) !== id);
        writeAccountsFile(next, env);
        sendJson(res, 200, { ok: true, id, removed: current.length - next.length });
        return;
      }

      if (action === 'save') {
        const entry = sanitizeAccountEntry(payload.account);
        if (!entry) {
          sendJson(res, 400, { error: '缺少邮箱地址' });
          return;
        }
        if (!entry.address || !entry.address.includes('@')) {
          sendJson(res, 400, { error: '邮箱地址看起来不完整（要包含 @）' });
          return;
        }
        const rest = current.filter((a) => String(a.id) !== entry.id);
        const previous = current.find((a) => String(a.id) === entry.id);
        // 编辑时密码框留空 = 保留原来的授权码
        if (!entry.password && previous?.password) entry.password = previous.password;
        const next = [...rest, entry];
        writeAccountsFile(next, env);
        sendJson(res, 200, { ok: true, id: entry.id, saved: next.length });
        return;
      }

      sendJson(res, 400, { error: `不认识的 action：${action || '(空)'}` });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  }

  return { handle, listSaved, rejectReason };
}

/**
 * Register the panel's routes on the host's web server.
 *
 *   /dsh-mail/api/accounts   JSON read/write
 *   /dsh-mail/ui.js          浏览器端界面脚本（桌面端与 web 端共用）
 *   /dsh-mail/setup          独立页面（注入失败时的兜底入口）
 *
 * @param {object} ctx host context (needs `webServer.register`)
 * @param {{env?: object, listConfig?: () => Array<object>, providers?: Array<object>}} options
 * @returns {() => void} disposer (no-op when the host has no web server)
 */
export function mountSetupApi(ctx, options = {}) {
  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') return () => {};

  const api = createSetupApi(options);



  const disposers = [];
  const add = (path, handler) => {
    const dispose = webServer.register({ kind: 'exact', path, handler });
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  add('/dsh-mail/api/accounts', api.handle);

  // 诊断用：一条 URL 就能看出「路由活了没有、界面脚本在不在、账号读到了几个」，
  // 不必打开开发者工具。不含任何授权码或地址。
  let uiMountedAt = null;

  add('/dsh-mail/health', (req, res) => {
    const reason = rejectReason(req.headers);
    if (reason) {
      sendJson(res, 403, { error: `拒绝访问（${reason}）` });
      return;
    }
    let saved = 0;
    let config = 0;
    try {
      saved = api.listSaved().length;
    } catch {
      /* 读不到就报 0，不要把健康检查本身弄成 500 */
    }
    try {
      config = (options.listConfig?.() ?? []).length;
    } catch {
      /* 同上 */
    }
    sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-mail',
      ui: { mountedAt: uiMountedAt, panel: '/dsh-mail/api/accounts' },
      accounts: { saved, config },
      routes: ['/dsh-mail/api/accounts', '/dsh-mail/health', '/dsh-mail/mounted'],
    });
  });

  // 界面挂载成功后回打这里一次。日志里出现这一行 = 面板真的跑起来了；
  // 「按钮在、面板空白」这种半挂状态靠它就能和「根本没挂」区分开。
  add('/dsh-mail/mounted', (req, res) => {
    const reason = rejectReason(req.headers);
    if (reason) {
      sendJson(res, 403, { error: `拒绝访问（${reason}）` });
      return;
    }
    if (uiMountedAt === null) {
      uiMountedAt = new Date().toISOString();
      console.log(`[dsh-mail] UI mounted at ${uiMountedAt}`);
    }
    sendJson(res, 200, { ok: true, mountedAt: uiMountedAt });
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 注销失败不影响退出 */
      }
    }
  };
}

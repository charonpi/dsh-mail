/**
 * Config normalization and account resolution.
 *
 * The plugin config is authored by hand in `cordis.patch.yml`, so this module
 * is deliberately forgiving: it accepts several spellings for the same thing,
 * never throws at activation time (so a half-configured plugin still loads and
 * can tell the model what is missing), and reports problems as data.
 */
import { readFileSync } from 'node:fs';
import { isVolatile } from '@deepseek-ai/cosmokit';
import { presetFor, providerForDomain, presetIds } from './providers.js';

/**
 * Deep-unwrap live config references into detached plain data.
 *
 * Fields the Config schema marks `.volatile()` reach the plugin as live
 * references rather than plain values. Unwrapping therefore has to happen on
 * every read rather than once at activation — that is precisely what makes a
 * Settings-form edit take effect on the next tool call, with no restart.
 * @param {unknown} value
 * @param {Set<object>} [ancestors] cycle guard, scoped to the current path
 * @returns {unknown}
 */
export function unwrapVolatile(value, ancestors = new Set()) {
  if (isVolatile(value)) return unwrapVolatile(value.get(), ancestors);
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  const plain = Array.isArray(value)
    ? value.map((entry) => unwrapVolatile(entry, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrapVolatile(entry, ancestors)]));
  ancestors.delete(value);
  return plain;
}

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const num = (v, fallback) => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};
/**
 * Coerce a boolean that YAML may have delivered as a quoted string.
 *
 * The Config schema accepts `secure: "true"` so a quoted scalar cannot fail
 * activation, which means the value arriving here may be a string; treating
 * only the literal `true` as truthy would silently turn TLS *off*.
 */
const bool = (v, fallback) => {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'y'].includes(s)) return true;
  if (['false', '0', 'no', 'off', 'n', ''].includes(s)) return false;
  return fallback;
};

/** Environment variable name for an account's secret when none is configured. */
function derivedEnvName(id) {
  return `DSH_MAIL_${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PASSWORD`;
}

/** Read a secret from the first source that has one. Never logged, never returned to the model. */
function resolveSecret(account, env) {
  const inline = str(account.password) ?? str(account.authCode) ?? str(account.token);
  if (inline !== undefined) return { value: inline, source: 'config' };

  for (const key of ['passwordEnv', 'authCodeEnv', 'tokenEnv']) {
    const name = str(account[key]);
    if (name === undefined) continue;
    const value = str(env[name]);
    if (value !== undefined) return { value, source: `env:${name}` };
    return { value: undefined, source: `env:${name}`, missingEnv: name };
  }

  const file = str(account.passwordFile);
  if (file !== undefined) {
    try {
      const value = readFileSync(file, 'utf8').trim();
      if (value !== '') return { value, source: `file:${file}` };
      return { value: undefined, source: `file:${file}`, missingEnv: file };
    } catch (error) {
      return { value: undefined, source: `file:${file}`, missingEnv: file, fileError: String(error?.message ?? error) };
    }
  }

  const derived = derivedEnvName(account.id);
  const value = str(env[derived]);
  if (value !== undefined) return { value, source: `env:${derived}` };

  return { value: undefined, source: null, missingEnv: derived };
}

function normalizeEndpoint(raw, fallback, defaults) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const host = str(base.host) ?? fallback?.host;
  const port = num(base.port, fallback?.port ?? defaults.port);
  const secure = bool(base.secure, fallback?.secure ?? defaults.secure);
  const requireTLS = base.requireTLS === undefined ? fallback?.requireTLS : bool(base.requireTLS, undefined);
  return {
    host,
    port,
    secure,
    ...(requireTLS === undefined ? {} : { requireTLS }),
  };
}

/**
 * Turn the raw plugin config into a stable, JSON-serializable shape.
 * @param {unknown} raw
 * @param {Record<string, string|undefined>} [env]
 */
export function normalizeConfig(raw, env = process.env) {
  // `.volatile()` fields arrive as live references; read them fresh every call.
  const unwrapped = unwrapVolatile(raw);
  const cfg = unwrapped && typeof unwrapped === 'object' ? unwrapped : {};
  const list = Array.isArray(cfg.accounts) ? cfg.accounts : [];

  const problems = [];
  if (list.length === 0) {
    problems.push(
      '未配置任何邮箱账号。请在 DSH 的「插件 / 设置」页打开 dsh-mail，在账号列表里添加一个账号：填 address（邮箱地址）和 password（邮箱服务商给的授权码）即可，provider 可以留空、会按域名自动判断。也可以直接编辑 profile 的 cordis.patch.yml 里 id 为 dsh-mail 这一行的 config.accounts。',
    );
  }

  const seen = new Set();
  const accounts = [];

  for (const [index, entry] of list.entries()) {
    const a = entry && typeof entry === 'object' ? entry : {};
    const address = str(a.address) ?? str(a.email) ?? str(a.user);
    const domain = address?.includes('@') ? address.split('@').pop() : undefined;
    const id = str(a.id) ?? (address !== undefined ? address.split('@')[0] : undefined) ?? `account${index + 1}`;

    if (seen.has(id)) {
      problems.push(`账号 id 重复：${id}（已跳过第二条）。`);
      continue;
    }
    seen.add(id);

    const providerKey = str(a.provider) ?? (domain !== undefined ? providerForDomain(domain) : null) ?? null;
    const preset = presetFor(providerKey);

    if (providerKey !== null && preset === null && !(a.imap && a.smtp)) {
      problems.push(
        `账号 ${id}：不认识 provider「${providerKey}」，且没有提供 imap/smtp 服务器地址。可用预设：${presetIds().join(', ')}；自定义服务商请直接写 imap 与 smtp。`,
      );
    }
    if (address === undefined) problems.push(`账号 ${id}：缺少 address（完整邮箱地址）。`);

    const secret = resolveSecret({ ...a, id }, env);
    if (secret.value === undefined) {
      problems.push(
        `账号 ${id}：找不到密码/授权码。可以写 passwordEnv（推荐，例如 passwordEnv: ${secret.missingEnv ?? derivedEnvName(id)}）并设置同名环境变量，或直接写 password。`,
      );
    }

    const imap = normalizeEndpoint(a.imap, preset?.imap, { port: 993, secure: true });
    const smtp = normalizeEndpoint(a.smtp, preset?.smtp, { port: 465, secure: true });
    if (!imap.host) problems.push(`账号 ${id}：缺少 IMAP 服务器地址。`);
    if (!smtp.host) problems.push(`账号 ${id}：缺少 SMTP 服务器地址。`);

    const account = {
      id,
      label: str(a.label) ?? preset?.label ?? address ?? id,
      address: address ?? '',
      userName: str(a.userName) ?? str(a.user) ?? address ?? '',
      provider: providerKey,
      providerLabel: preset?.label ?? null,
      providerHint: preset?.hint ?? null,
      providerCaveat: preset?.caveat ?? null,
      authKind: preset?.auth ?? 'password',
      imap,
      smtp,
      senderName: str(a.senderName) ?? str(a.name) ?? null,
      replyTo: str(a.replyTo) ?? null,
      signature: str(a.signature) ?? null,
      sentFolder: str(a.sentFolder) ?? null,
      draftsFolder: str(a.draftsFolder) ?? null,
      trashFolder: str(a.trashFolder) ?? null,
      appendToSent: bool(a.appendToSent, true),
      _ready: Boolean(address && secret.value && imap.host && smtp.host),
    };
    // The credential and its provenance are deliberately NON-ENUMERABLE: no
    // spread, `JSON.stringify`, `console.log`, or object dump can leak the
    // authorization code into a tool result, an error message, or the log.
    Object.defineProperty(account, '_secret', { value: secret.value, enumerable: false });
    Object.defineProperty(account, '_secretSource', { value: secret.source, enumerable: false });
    accounts.push(account);
  }

  const defaultAccount =
    str(cfg.defaultAccount) ?? str(cfg.default) ?? (accounts.length === 1 ? accounts[0].id : null);

  if (defaultAccount !== null && accounts.length > 0 && !accounts.some((a) => a.id === defaultAccount)) {
    problems.push(`defaultAccount「${defaultAccount}」不在 accounts 里；多账号时每次调用都必须显式传 account。`);
  }
  if (defaultAccount === null && accounts.length > 1) {
    problems.push('配置了多个账号但没有 defaultAccount；每次调用工具都需要显式传 account。');
  }

  return {
    defaultAccount,
    attachmentDir: str(cfg.attachmentDir) ?? 'mail-attachments',
    maxBodyChars: num(cfg.maxBodyChars, 20000),
    timeoutMs: num(cfg.timeoutMs, 30000),
    maxMessages: num(cfg.maxMessages, 50),
    accounts,
    problems,
  };
}

/** Strip internal fields before anything crosses into a tool result. */
export function publicAccount(account) {
  // `_secret` / `_secretSource` are non-enumerable, so the spread cannot carry
  // them; the two public facts are added back explicitly.
  return {
    ...account,
    hasSecret: Boolean(account._secret),
    secretSource: account._secretSource ?? null,
  };
}

/**
 * Pick the account for a call.
 * @returns {{account: object} | {error: string}}
 */
export function selectAccount(config, wanted) {
  const wantedId = str(wanted) ?? config.defaultAccount;
  if (config.accounts.length === 0) {
    return { error: `没有可用账号。${config.problems.join(' ') || '请先在 dsh-mail 的 config.accounts 里配置账号。'}` };
  }
  if (wantedId === null || wantedId === undefined) {
    return {
      error: `有多个账号（${config.accounts.map((a) => a.id).join(', ')}），请用 account 参数指定一个。`,
    };
  }
  const found =
    config.accounts.find((a) => a.id === wantedId) ??
    config.accounts.find((a) => a.address.toLowerCase() === wantedId.toLowerCase());
  if (!found) {
    return { error: `没有 id 或地址为「${wantedId}」的账号。可用：${config.accounts.map((a) => a.id).join(', ')}。` };
  }
  if (!found._ready) {
    const why = found._secret === undefined ? '缺少密码/授权码' : '账号信息不完整';
    return { error: `账号 ${found.id} 不可用：${why}。${found.providerHint ?? ''}` };
  }
  return { account: found };
}
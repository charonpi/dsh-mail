/**
 * Provider presets for dsh-mail.
 *
 * A preset only fills in server endpoints and known caveats. Anything the user
 * writes in the plugin config wins over the preset, so a preset is a
 * convenience, never a constraint: unknown providers are configured by writing
 * `imap` / `smtp` explicitly.
 *
 * Field notes
 * - `secure: true`  => implicit TLS from the first byte (IMAPS / SMTPS).
 * - `secure: false` => plaintext connect; SMTP then upgrades with STARTTLS when
 *                      `requireTLS` is set.
 * - `auth` documents what the *password* field must actually contain. Most
 *   Chinese providers require a client authorization code ("授权码") generated
 *   in the web settings, not the account login password.
 */

/** @typedef {{host: string, port: number, secure: boolean, requireTLS?: boolean}} Endpoint */

const e = (host, port, secure, requireTLS) =>
  requireTLS === undefined ? { host, port, secure } : { host, port, secure, requireTLS };

export const PROVIDERS = {
  qq: {
    label: 'QQ 邮箱',
    imap: e('imap.qq.com', 993, true),
    smtp: e('smtp.qq.com', 465, true),
    auth: 'authorization-code',
    hint: '设置 → 账户 → 开启 IMAP/SMTP 服务，用手机短信验证后得到 16 位授权码，填在 password/authCode 里。',
  },
  exmail: {
    label: '腾讯企业邮',
    imap: e('imap.exmail.qq.com', 993, true),
    smtp: e('smtp.exmail.qq.com', 465, true),
    auth: 'authorization-code',
    hint: '企业邮管理后台 → 客户端设置里开启 IMAP/SMTP，密码处可填登录密码或专用密码。',
  },
  '163': {
    label: '网易 163',
    imap: e('imap.163.com', 993, true),
    smtp: e('smtp.163.com', 465, true),
    auth: 'authorization-code',
    hint: '设置 → POP3/SMTP/IMAP 开启后得到授权码（不是登录密码）。',
  },
  '126': {
    label: '网易 126',
    imap: e('imap.126.com', 993, true),
    smtp: e('smtp.126.com', 465, true),
    auth: 'authorization-code',
    hint: '同 163：开启 IMAP/SMTP 后用授权码。',
  },
  yeah: {
    label: '网易 yeah.net',
    imap: e('imap.yeah.net', 993, true),
    smtp: e('smtp.yeah.net', 465, true),
    auth: 'authorization-code',
    hint: '同 163：开启 IMAP/SMTP 后用授权码。',
  },
  sina: {
    label: '新浪邮箱',
    imap: e('imap.sina.com', 993, true),
    smtp: e('smtp.sina.com', 465, true),
    auth: 'authorization-code',
    hint: '设置里开启 IMAP/SMTP 服务；部分账号需使用客户端授权码。',
  },
  sohu: {
    label: '搜狐邮箱',
    imap: e('imap.sohu.com', 993, true),
    smtp: e('smtp.sohu.com', 465, true),
    auth: 'password',
    hint: '设置里开启 IMAP/SMTP 服务；部分账号需使用独立密码。',
  },
  '139': {
    label: '中国移动 139',
    imap: e('imap.139.com', 993, true),
    smtp: e('smtp.139.com', 465, true),
    auth: 'password',
    hint: '需在网页端开启 IMAP/SMTP；密码一般为登录密码。',
  },
  '189': {
    label: '中国电信 189',
    imap: e('imap.189.cn', 993, true),
    smtp: e('smtp.189.cn', 465, true),
    auth: 'password',
    hint: '需在网页端开启 IMAP/SMTP；密码一般为登录密码。',
  },
  aliyun: {
    label: '阿里云企业邮',
    imap: e('imap.qiye.aliyun.com', 993, true),
    smtp: e('smtp.qiye.aliyun.com', 465, true),
    auth: 'password',
    hint: '用完整邮箱地址作为用户名，密码为邮箱密码。',
  },
  gmail: {
    label: 'Gmail',
    imap: e('imap.gmail.com', 993, true),
    smtp: e('smtp.gmail.com', 465, true),
    auth: 'app-password',
    hint: '必须先在 Google 账号里开启两步验证，再生成「应用专用密码」；登录密码与普通 OAuth 令牌都不适用于 IMAP/SMTP。',
    caveat: '大陆网络环境通常需要代理才能连通 imap.gmail.com。',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    imap: e('outlook.office365.com', 993, true),
    smtp: e('smtp.office365.com', 587, false, true),
    auth: 'app-password',
    hint: '微软已大面积停用 IMAP/SMTP 的基础认证（Basic Auth），多数账号现在需要 OAuth2 才能连接；若账号仍允许应用密码则可直接用。',
    caveat: '基础认证被拒时通常报 “LOGIN failed” 或 “Authentication unsuccessful”，这不是配置写错，而是服务端策略。',
  },
  icloud: {
    label: 'iCloud 邮箱',
    imap: e('imap.mail.me.com', 993, true),
    smtp: e('smtp.mail.me.com', 587, false, true),
    auth: 'app-password',
    hint: '需在 Apple ID 里生成 App 专用密码。',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imap: e('imap.mail.yahoo.com', 993, true),
    smtp: e('smtp.mail.yahoo.com', 465, true),
    auth: 'app-password',
    hint: '需在账号安全设置里生成 App password。',
  },
  zoho: {
    label: 'Zoho Mail',
    imap: e('imap.zoho.com', 993, true),
    smtp: e('smtp.zoho.com', 465, true),
    auth: 'app-password',
    hint: '多数据中心的服务器地址不同（如 imap.zoho.eu），跨区账号请直接写 imap/smtp。',
  },
  fastmail: {
    label: 'Fastmail',
    imap: e('imap.fastmail.com', 993, true),
    smtp: e('smtp.fastmail.com', 465, true),
    auth: 'app-password',
    hint: '需生成 App password。',
  },
};

/**
 * Email domain → preset id.
 *
 * Domains are matched exactly first, then by the longest suffix on a label
 * boundary, so `mail.gmail.com` resolves while `acme.com` never matches
 * `me.com`. This is what lets a user write only `address:` and still get the
 * right servers.
 */
const DOMAINS = {
  'qq.com': 'qq',
  'qq.cn': 'qq',
  'vip.qq.com': 'qq',
  'foxmail.com': 'qq',
  'exmail.qq.com': 'exmail',
  '163.com': '163',
  '126.com': '126',
  'yeah.net': 'yeah',
  'sina.com': 'sina',
  'sina.cn': 'sina',
  'sohu.com': 'sohu',
  '139.com': '139',
  '189.cn': '189',
  'aliyun.com': 'aliyun',
  'qiye.aliyun.com': 'aliyun',
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
  'office365.com': 'outlook',
  'microsoft365.com': 'outlook',
  'icloud.com': 'icloud',
  'me.com': 'icloud',
  'mac.com': 'icloud',
  'yahoo.com': 'yahoo',
  'yahoo.com.cn': 'yahoo',
  'ymail.com': 'yahoo',
  'zoho.com': 'zoho',
  'zoho.eu': 'zoho',
  'zohomail.com': 'zoho',
  'fastmail.com': 'fastmail',
  'fastmail.fm': 'fastmail',
};

/** Provider-name aliases accepted in `provider:` (not domain matching). */
const ALIASES = {
  foxmail: 'qq',
  netease: '163',
  qiye: 'aliyun',
  google: 'gmail',
  googlemail: 'gmail',
  office365: 'outlook',
  microsoft: 'outlook',
  microsoft365: 'outlook',
  outlook365: 'outlook',
  hotmail: 'outlook',
  live: 'outlook',
  ymail: 'yahoo',
  zohomail: 'zoho',
};

const SUFFIXES = Object.keys(DOMAINS).sort((a, b) => b.length - a.length);

/**
 * Guess a preset id from an email domain.
 * @param {string} domain e.g. `gmail.com` or `@163.com`
 * @returns {string|null} preset id
 */
export function providerForDomain(domain) {
  const d = String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/^@/, '');
  if (d === '') return null;
  if (PROVIDERS[d] !== undefined) return d; // '163', '126', 'qq', ...
  if (DOMAINS[d] !== undefined) return DOMAINS[d];
  if (ALIASES[d] !== undefined) return ALIASES[d];
  for (const suffix of SUFFIXES) {
    if (d.endsWith(`.${suffix}`)) return DOMAINS[suffix];
  }
  return null;
}

export function presetFor(provider) {
  const key = String(provider ?? '')
    .trim()
    .toLowerCase();
  if (key === '') return null;
  // Accept a preset id, a provider alias, or a raw domain.
  const id = PROVIDERS[key] !== undefined ? key : (ALIASES[key] ?? DOMAINS[key] ?? null);
  return id === null ? null : (PROVIDERS[id] ?? null);
}

/** All preset ids, for error messages and documentation. */
export function presetIds() {
  return Object.keys(PROVIDERS);
}
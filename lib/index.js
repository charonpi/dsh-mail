/**
 * dsh-mail —— Host 插件：把「收发邮件」注册为一组模型可调用的工具。
 *
 * 结构上刻意保持最小：
 *   - `apply(ctx, config)` 只做一件事：往 `ctx.tools` 注册工具。
 *   - 配置解析在 ./config.js，邮件引擎在 ./mail.js，服务商预设在 ./providers.js。
 *   - 每次调用都重新解析配置，这样新加的环境变量（授权码）无需重载插件即可生效。
 *
 * 工具输出统一为「已排版好的文本」：模型拿到的就是可直接读的内容，
 * 少一层结构体解析，也避免输出 schema 与返回值不一致。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { normalizeConfig, publicAccount, selectAccount, unwrapVolatile } from './config.js';
import { mergeAccounts, readAccountsFile } from './accounts-file.js';
import { presetFor, presetIds } from './providers.js';
import { mountSetupApi } from './setup-routes.js';
import {
  listMailboxes,
  listMessages,
  readMessage,
  replyTargets,
  sanitizeFilename,
  saveAttachments,
  sendMessage,
  updateMessages,
} from './mail.js';

export const name = 'dsh-mail';
// 刻意**不**声明对象级 `inject`：那会把整个 apply() 推迟到依赖就绪之后，而桌面端
// 的页面注入表是宿主启动时**一次性收集**的 —— apply 晚一步，悬浮入口就永远进不了
// 那张表，界面便不会出现（dsh-whale-widget 的 #152/#153 就是同一个坑）。所以 apply
// 立刻执行、第一件事就是注册注入行，工具与 web 接口各自在 apply 内部等依赖。

/**
 * Plugin config schema — this is what gives the plugin a settings form.
 *
 * The Settings page derives an editable form from this schema, so the user can
 * add accounts and paste an authorization code on first use instead of editing
 * YAML or exporting environment variables. Three deliberate choices:
 *
 * 1. Nothing is `.required()`. A half-filled form must never stop the plugin
 *    from activating. `normalizeConfig` already turns a broken account into a
 *    readable problem that the tools report; failing activation instead would
 *    take the tools away and leave no way to see why.
 * 2. Every field the user may change is `.volatile()`. That is what puts a field
 *    into the form, and it also hands the plugin a live reference, so an edit
 *    applies on the next tool call with no restart.
 * 3. The secret fields carry `role('secret')`. The settings layer strips them
 *    from every value crossing to the client and sends only an "is it set"
 *    marker, so the authorization code is never rendered back into the browser.
 */
/**
 * Accept a number, or the numeric string a quoted YAML scalar produces.
 *
 * `port: "993"` must not fail activation: the plugin's whole design is that a
 * bad value becomes a readable problem the tools can report, never a plugin
 * that refuses to load and takes its tools away with it.
 */
const numberLike = (description) => z.union([z.number(), z.string()]).description(description);

/** Accept a boolean, or the common string spellings, for the same reason. */
const booleanLike = (description) => z.union([z.boolean(), z.string()]).description(description);

const ENDPOINT_FIELDS = {
  host: z.string().description('服务器地址，如 imap.qq.com'),
  port: numberLike('端口，如 993'),
  secure: booleanLike('true＝连接即 TLS（993/465）；false＝明文连接后用 STARTTLS 升级（587）'),
  requireTLS: booleanLike('secure 为 false 时强制 STARTTLS 升级'),
};

const ACCOUNT_FIELDS = {
  id: z.string().description('账号标识，工具里的 account 参数就填它。留空会用邮箱地址自动生成'),
  label: z.string().description('显示名，只影响工具输出'),
  address: z.string().description('完整邮箱地址，同时作为默认登录用户名'),
  email: z.string().description('address 的别名'),
  provider: z.string().description(
    `预设 id、别名或域名（可用：${presetIds().join(' / ')}）。留空则按 address 的域名自动推断`,
  ),
  userName: z.string().description('登录用户名，默认等于 address（有些服务器要求不带域名的短名）'),
  user: z.string().description('userName 的别名'),
  imap: z.object(ENDPOINT_FIELDS).description('IMAP 服务器。写了就完全覆盖预设'),
  smtp: z.object(ENDPOINT_FIELDS).description('SMTP 服务器。写了就完全覆盖预设'),
  senderName: z.string().description('发信时的显示名'),
  replyTo: z.string().description('发信时固定带的 Reply-To'),
  signature: z.string().description('自动追加到纯文本正文末尾的签名'),
  sentFolder: z.string().description('「已发送」文件夹，默认按服务器标记自动识别'),
  draftsFolder: z.string().description('「草稿」文件夹'),
  trashFolder: z.string().description('「垃圾箱」文件夹'),
  appendToSent: booleanLike('发信后是否把副本追加进「已发送」，默认 true'),
  password: z.string().role('secret').description('密码或授权码。QQ/163 等要填 16 位授权码，不是登录密码'),
  authCode: z.string().role('secret').description('授权码（password 的别名）'),
  token: z.string().role('secret').description('令牌（password 的别名）'),
  passwordEnv: z.string().description('改为从该环境变量读取密码/授权码'),
  authCodeEnv: z.string().description('改为从该环境变量读取授权码'),
  tokenEnv: z.string().description('改为从该环境变量读取令牌'),
  passwordFile: z.string().description('改为从该文件读取密码/授权码（文件内容是明文，请自行收紧权限）'),
};

export const Config = z
  .object({
    defaultAccount: z
      .string()
      .volatile()
      .description('默认账号 id。多账号时必填，只有一个账号可省略'),
    attachmentDir: z
      .string()
      .volatile()
      .default('mail-attachments')
      .description('附件默认落地目录。相对路径按当前会话工作目录解析'),
    maxBodyChars: numberLike('单封邮件正文最多回传给模型的字符数，超出截断，默认 20000')
      .volatile()
      .default(20000),
    timeoutMs: numberLike('连接与命令超时（毫秒），默认 30000').volatile().default(30000),
    accounts: z
      .array(z.object(ACCOUNT_FIELDS).description('一个邮箱账号：地址、服务商与授权码'))
      .volatile()
      .description('邮箱账号列表。首次使用在这里添加账号，并填入邮箱服务商给的授权码'),
  })
  .description('dsh-mail：让 agent 通过 IMAP/SMTP 收发邮件并处理附件');

/** Every tool returns one formatted string. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

const ACCOUNT_PARAM = { type: 'string', description: '账号 id（见 mail_accounts）。多账号时必填，单账号可省略。' };
const FOLDER_PARAM = { type: 'string', description: '文件夹路径，默认 INBOX。可用 mail_folders 查看。' };
const UID_PARAM = { type: 'integer', required: true, description: '邮件 UID，来自 mail_list / mail_search 的结果。' };

/** Hard ceiling on how many message summaries one call may return. */
const MAX_LIST_LIMIT = 200;

/** Clamp a caller-supplied page size so one call cannot flood the context. */
function clampLimit(value, fallback) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LIST_LIMIT);
}

function toText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function fmtAddrList(list) {
  if (!Array.isArray(list) || list.length === 0) return '(无)';
  return list.map((a) => (a.name ? `${a.name} <${a.address ?? '?'}>` : (a.address ?? '?'))).join(', ');
}

function fmtDate(iso) {
  if (!iso) return '未知时间';
  return iso.replace('T', ' ').slice(0, 16);
}

/** `host:port TLS`，主机名缺失时说清楚，而不是打印 `undefined:993`。 */
function fmtEndpoint(endpoint) {
  const host = endpoint?.host;
  if (!host) return '(未填 —— 这个地址猜不出服务商，请在配置里写明 imap / smtp)';
  return `${host}:${endpoint.port} ${endpoint.secure ? 'TLS' : 'STARTTLS'}`;
}

function fmtBytes(size) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return '?';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fmtList(result) {
  const head = `文件夹 ${result.folder}：共 ${result.total} 封，返回 ${result.messages.length} 封（最新在前）` +
    (result.matched !== undefined && result.matched !== result.total ? `，命中 ${result.matched} 封` : '');
  if (result.messages.length === 0) return `${head}\n（没有符合条件的邮件）`;
  const rows = result.messages.map((m) => {
    const flags = [m.seen ? '' : '未读', m.flagged ? '★' : '', m.answered ? '已回复' : '', m.hasAttachments ? '有附件' : '']
      .filter(Boolean)
      .join(' ');
    return [
      `#${m.n}  uid=${m.uid}  ${fmtDate(m.date)}${flags ? `  [${flags}]` : ''}`,
      `     发件人: ${fmtAddrList(m.from)}`,
      `     主题: ${m.subject}`,
      `     大小: ${fmtBytes(m.size)}`,
    ].join('\n');
  });
  return `${head}\n\n${rows.join('\n\n')}\n\n读正文用 mail_read(uid=...)。`;
}

function fmtMessage(m) {
  const lines = [
    `uid=${m.uid}  文件夹=${m.folder}`,
    `主题: ${m.subject}`,
    `发件人: ${fmtAddrList(m.from)}`,
    `收件人: ${fmtAddrList(m.to)}`,
  ];
  if (m.cc?.length) lines.push(`抄送: ${fmtAddrList(m.cc)}`);
  if (m.replyTo?.length) lines.push(`回复至: ${fmtAddrList(m.replyTo)}`);
  lines.push(`时间: ${fmtDate(m.date)}`, `Message-ID: ${m.messageId ?? '(无)'}`);
  if (m.attachmentCount > 0) {
    lines.push('', `附件 ${m.attachmentCount} 个：`);
    for (const a of m.attachments) {
      lines.push(`  [${a.index}] ${a.filename}  ${a.contentType}  ${fmtBytes(a.size)}`);
    }
  }
  lines.push('', '---- 正文 ----', m.body || '(正文为空)');
  return lines.join('\n');
}

/** Resolve a possibly-relative path against the session working directory. */
function resolveUserPath(p, base) {
  const text = String(p ?? '').trim();
  if (text === '') return text;
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')) return text;
  return `${base.replace(/[\\/]+$/, '')}\\${text}`;
}

function sessionBaseDir(exec) {
  const candidates = [exec?.agent?.session?.cwd, exec?.cwd, exec?.agent?.cwd];
  for (const c of candidates) if (typeof c === 'string' && c !== '') return c;
  return process.cwd();
}

/**
 * @param {object} ctx registrant context
 * @param {unknown} config the row's `config`
 */
export function apply(ctx, config) {
  /**
   * Re-read config (and therefore env vars and the saved accounts file) on every call.
   *
   * 界面保存的账号存在一个独立 JSON 文件里；它优先于 `cordis.patch.yml` 里的同名
   * 账号（用户刚刚在界面上改过，就该以界面为准），配置里独有的账号仍然保留。
   */
  const cfg = () => {
    const base = unwrapVolatile(config);
    const plain = base && typeof base === 'object' ? base : {};
    const { accounts: saved } = readAccountsFile();
    return normalizeConfig({ ...plain, accounts: mergeAccounts(plain.accounts, saved) });
  };

  /** 当前配置里的账号（给界面只读展示用；不含任何授权码）。 */
  const configAccountsForUi = () => {
    const base = unwrapVolatile(config);
    const plain = base && typeof base === 'object' ? base : {};
    const list = Array.isArray(plain.accounts) ? plain.accounts : [];
    return list.map((a, index) => {
      const id = String(a?.id ?? a?.address ?? `account${index + 1}`);
      return {
        id,
        address: String(a?.address ?? ''),
        provider: a?.provider ? String(a.provider) : null,
        label: a?.label ? String(a.label) : null,
        hasSecret: Boolean(a?.password ?? a?.authCode ?? a?.token ?? a?.passwordEnv ?? a?.authCodeEnv ?? a?.passwordFile),
      };
    });
  };

  // 界面本体是客户端插件（lib/client.js，侧栏 + 主区页面），这里只提供它要用的
  // JSON 接口。宿主没有 webServer（例如 TUI）时整段跳过，邮件工具照常可用。
  let providerChoices = [];
  try {
    providerChoices = presetIds().map((id) => ({ id, label: presetFor(id)?.label ?? id }));
  } catch {
    providerChoices = [];
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (webCtx) => {
        try {
          const dispose = mountSetupApi(webCtx, {
            listConfig: configAccountsForUi,
            providers: providerChoices,
          });
          if (typeof webCtx.effect === 'function') {
            try {
              webCtx.effect(() => dispose);
            } catch {
              /* effect 不可用时留给进程退出 */
            }
          }
        } catch {
          /* 路由注册失败不该把整个插件拖垮：邮件工具照常可用 */
        }
      });
    } catch {
      /* webServer 永远不出现也不影响收发邮件 */
    }
  }


  /** Resolve the account, then run `fn`; config/account problems become tool errors. */
  const withAccount = (args, fn) => {
    const resolved = cfg();
    const picked = selectAccount(resolved, args?.account);
    if (picked.error) throw new Error(picked.error);
    return fn(picked.account, resolved);
  };

  const registerTools = (toolCtx) => {
    const register = (spec) => toolCtx.tools.register(defineTool(spec));

  register({
    name: 'mail_accounts',
    description:
      '列出 dsh-mail 配置的邮箱账号及其可用状态（服务器、认证方式、是否已提供授权码）。' +
      '收发邮件前先用它确认账号 id；如果返回「不可用」，按提示补配置而不是反复重试。',
    parameters: {},
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute() {
      const resolved = cfg();
      if (resolved.accounts.length === 0) {
        return [
          '未配置任何邮箱账号。',
          '',
          '推荐做法：打开左侧栏的「邮件」页面，在表单里填三样东西即可：',
          '  address   你的邮箱地址',
          '  provider  服务商（可留空，会按域名自动判断为 qq / 163 / 126 / gmail / outlook 等）',
          '  password  邮箱服务商给的授权码（16 位，不是登录密码）',
          '点保存立刻生效，不需要重启。',
          '',
          '看不到那个入口？说明客户端插件没加载（多半是插件刚更新、还没重启 DSH）。',
          '这时可以直接编辑 profile 的 cordis.patch.yml 里 id 为 dsh-mail 这一行，例如：',
          '',
          '  config:',
          '    accounts:',
          '      - id: qq',
          '        provider: qq                 # qq / 163 / 126 / gmail / outlook / icloud / 自定义',
          '        address: 你的QQ号@qq.com',
          '        authCodeEnv: QQMAIL_AUTH_CODE  # 不想让授权码明文落盘就用环境变量或 passwordFile',
          '',
          '授权码获取方式见插件 README（QQ 邮箱为「设置 → 账户 → IMAP/SMTP 服务」）。',
        ].join('\n');
      }
      const blocks = resolved.accounts.map((a) => {
        const p = publicAccount(a);
        return [
          `- id: ${p.id}${p.id === resolved.defaultAccount ? '   [默认账号]' : ''}`,
          `  地址: ${p.address || '(未填)'}${p.label && p.label !== p.address ? `   (${p.label})` : ''}`,
          `  服务商: ${p.providerLabel ?? p.provider ?? '自定义'}${p.providerHint ? `\n  说明: ${p.providerHint}` : ''}`,
          // 主机名没解析出来时不要打印 "undefined:993" —— 那看起来像插件坏了，
          // 实际是「这个地址猜不出服务商，得自己填 imap/smtp」。
          `  IMAP: ${fmtEndpoint(p.imap)}`,
          `  SMTP: ${fmtEndpoint(p.smtp)}`,
          `  凭证: ${p.hasSecret ? `已提供（来源 ${p.secretSource}）` : '缺失'}   状态: ${p._ready ? '可用' : '不可用'}`,
        ].join('\n');
      });
      const out = [`已配置 ${resolved.accounts.length} 个账号：`, '', blocks.join('\n\n')];
      if (resolved.problems.length > 0) out.push('', '需要注意：', ...resolved.problems.map((s) => `- ${s}`));
      out.push('', `附件默认落地目录: ${resolved.attachmentDir}`);
      return out.join('\n');
    },
  });

  register({
    name: 'mail_folders',
    description: '列出某个邮箱账号的 IMAP 文件夹（收件箱、已发送、草稿、垃圾箱等），含邮件数与未读数。',
    parameters: { account: ACCOUNT_PARAM },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return withAccount(args, async (account) => {
        const boxes = await listMailboxes(account);
        if (boxes.length === 0) return `账号 ${account.id} 没有返回任何文件夹。`;
        const rows = boxes.map((b) => {
          const counts = [b.messages !== null ? `${b.messages} 封` : null, b.unseen ? `${b.unseen} 未读` : null]
            .filter(Boolean)
            .join('，');
          return `- ${b.path}${b.specialUse ? `  [${b.specialUse}]` : ''}${counts ? `  ${counts}` : ''}`;
        });
        return `账号 ${account.id}（${account.address}）的文件夹：\n${rows.join('\n')}`;
      });
    },
  });

  register({
    name: 'mail_list',
    description:
      '列出某文件夹里最新的邮件（默认收件箱，最新在前），可按未读、时间范围、发件人、主题、正文关键词过滤。' +
      '返回每封的 uid、发件人、主题、时间、是否有附件；读正文再用 mail_read。',
    parameters: {
      account: ACCOUNT_PARAM,
      folder: FOLDER_PARAM,
      limit: { type: 'integer', description: `返回条数上限，默认 20，最大 ${MAX_LIST_LIMIT}。` },
      unreadOnly: { type: 'boolean', description: '只要未读邮件。' },
      since: { type: 'string', description: '只看该日期之后（含）的邮件，如 2026-10-01 或 ISO 时间。' },
      before: { type: 'string', description: '只看该日期之前的邮件。' },
      from: { type: 'string', description: '按发件人过滤（服务端子串匹配）。' },
      to: { type: 'string', description: '按收件人过滤。' },
      subject: { type: 'string', description: '按主题过滤。' },
      text: { type: 'string', description: '按整封邮件（含正文）全文搜索。' },
      body: { type: 'string', description: '只搜正文。' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return withAccount(args, async (account, resolved) => {
        const result = await listMessages(account, {
          folder: args.folder ?? 'INBOX',
          limit: clampLimit(args.limit, Math.min(20, resolved.maxMessages)),
          unreadOnly: args.unreadOnly === true,
          since: args.since,
          before: args.before,
          from: args.from,
          to: args.to,
          subject: args.subject,
          text: args.text,
          body: args.body,
        });
        return fmtList(result);
      });
    },
  });

  register({
    name: 'mail_search',
    description:
      '在邮箱里搜索邮件（发件人 / 主题 / 正文关键词 / 时间范围 / 未读），跨文件夹时请分别指定 folder。' +
      '等价于带条件的 mail_list，但描述更明确、默认返回更多条。',
    parameters: {
      account: ACCOUNT_PARAM,
      folder: FOLDER_PARAM,
      from: { type: 'string', description: '发件人关键词，如 bristol.ac.uk 或 Kai Zhang。' },
      to: { type: 'string', description: '收件人关键词。' },
      subject: { type: 'string', description: '主题关键词。' },
      text: { type: 'string', description: '全文关键词（含正文）。' },
      body: { type: 'string', description: '仅正文关键词。' },
      since: { type: 'string', description: '起始日期，如 2026-09-01。' },
      before: { type: 'string', description: '截止日期（不含）。' },
      unreadOnly: { type: 'boolean', description: '只要未读。' },
      limit: { type: 'integer', description: `返回条数上限，默认 25，最大 ${MAX_LIST_LIMIT}。` },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args) {
      return withAccount(args, async (account) => {
        if (!args.from && !args.to && !args.subject && !args.text && !args.body && !args.since && !args.before && !args.unreadOnly) {
          throw new Error('mail_search 至少要有一个搜索条件（from / to / subject / text / body / since / before / unreadOnly）。只是想看最新邮件请用 mail_list。');
        }
        const result = await listMessages(account, {
          folder: args.folder ?? 'INBOX',
          limit: clampLimit(args.limit, 25),
          unreadOnly: args.unreadOnly === true,
          since: args.since,
          before: args.before,
          from: args.from,
          to: args.to,
          subject: args.subject,
          text: args.text,
          body: args.body,
        });
        return fmtList(result);
      });
    },
  });

  register({
    name: 'mail_read',
    description:
      '按 uid 读取一封邮件的完整内容：主题、收发件人、时间、纯文本正文，以及附件清单。' +
      '默认不会把邮件标记为已读（markSeen=true 才标记）。' +
      '用 saveAttachmentsTo 可把附件保存到本地目录（下载附件）；直接传相对目录即可。',
    parameters: {
      uid: UID_PARAM,
      account: ACCOUNT_PARAM,
      folder: FOLDER_PARAM,
      includeHtml: { type: 'boolean', description: '同时返回 HTML 正文（默认只返回纯文本）。' },
      markSeen: { type: 'boolean', description: '置为已读。默认 false，不改变邮箱状态。' },
      saveAttachmentsTo: { type: 'string', description: '把该邮件所有附件保存到此目录并返回文件路径。' },
      attachmentIndexes: {
        type: 'array',
        items: { type: 'integer' },
        description: '配合 saveAttachmentsTo：只保存指定序号的附件（序号见返回的附件清单）。不传则保存全部。',
      },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return withAccount(args, async (account, resolved) => {
        const message = await readMessage(account, {
          uid: args.uid,
          folder: args.folder ?? 'INBOX',
          includeHtml: args.includeHtml === true,
          markSeen: args.markSeen === true,
          maxBodyChars: resolved.maxBodyChars,
        });
        const parts = [fmtMessage(message)];
        if (args.saveAttachmentsTo) {
          const dir = resolveUserPath(args.saveAttachmentsTo, sessionBaseDir(exec));
          const saved = await saveAttachments(message, dir, args.attachmentIndexes);
          parts.push(
            '',
            '---- 附件已保存 ----',
            `目录: ${saved.directory}`,
            ...saved.saved.map((s) => `  ${s.name}  ${fmtBytes(s.size)}`),
            saved.saved.length === 0 ? '  （该邮件没有附件）' : '',
          );
        }
        if (args.includeHtml && message.html) parts.push('', '---- HTML 正文 ----', message.html);
        return parts.filter((p) => p !== '').join('\n');
      });
    },
  });

  register({
    name: 'mail_send',
    description:
      '通过 SMTP 发送一封新邮件。attachments 传本地文件路径数组（这就是「上传附件」）。' +
      '路径可写绝对路径，也可写相对当前会话工作目录的相对路径。' +
      '发送前后都可先用 mail_accounts 确认账号可用。',
    parameters: {
      to: { type: 'string', required: true, description: '收件人，多个用逗号或分号分隔。' },
      subject: { type: 'string', required: true, description: '主题。' },
      text: { type: 'string', description: '纯文本正文。与 html 至少给一个。' },
      html: { type: 'string', description: 'HTML 正文。' },
      cc: { type: 'string', description: '抄送。' },
      bcc: { type: 'string', description: '密送。' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: '附件文件路径数组（绝对路径，或相对当前会话工作目录）。',
      },
      account: ACCOUNT_PARAM,
      replyTo: { type: 'string', description: '覆盖 Reply-To 地址。' },
      senderName: { type: 'string', description: '覆盖发件人显示名。' },
      appendToSent: { type: 'boolean', description: '是否把发件副本追加到「已发送」文件夹，默认按账号配置（通常为 true）。' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return withAccount(args, async (account) => {
        if (!args.text && !args.html) throw new Error('mail_send 需要 text 或 html 正文。');
        const base = sessionBaseDir(exec);
        const attachments = (Array.isArray(args.attachments) ? args.attachments : []).map((p) => resolveUserPath(p, base));
        const result = await sendMessage(account, {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
          attachments,
          replyTo: args.replyTo,
          senderName: args.senderName,
          appendToSent: args.appendToSent,
        });
        const lines = [
          `已通过 ${account.id}（${account.address}）发出。`,
          `收件人: ${result.accepted.join(', ') || '(无)'}`,
        ];
        if (result.rejected?.length) lines.push(`被拒收件人: ${result.rejected.join(', ')}`);
        lines.push(`Message-ID: ${result.messageId ?? '(无)'}`, `服务器响应: ${result.response ?? '(无)'}`);
        if (result.attachmentCount > 0) {
          lines.push(`附件 ${result.attachmentCount} 个：${result.attachments.map((a) => `${a.filename} (${fmtBytes(a.size)})`).join('、')}`);
        }
        lines.push(result.appendedTo ? `已追加到「${result.appendedTo}」` : '未追加发件副本（可忽略）');
        return lines.join('\n');
      });
    },
  });

  register({
    name: 'mail_reply',
    description:
      '回复某封邮件：自动带上 Re: 主题、In-Reply-To 与 References 会话头，保证在收件人那边是同一会话。' +
      '先用 mail_read 看原文再决定正文。all=true 回复全部（含抄送）。quote=true 会在正文末尾附上原文。',
    parameters: {
      uid: UID_PARAM,
      text: { type: 'string', description: '回复正文（纯文本）。与 html 至少给一个。' },
      html: { type: 'string', description: '回复正文（HTML）。' },
      all: { type: 'boolean', description: '回复全部（把原收件人加入抄送）。默认只回复发件人。' },
      quote: { type: 'boolean', description: '在正文末尾附上原邮件内容。默认 false。' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: '附件文件路径数组。',
      },
      account: ACCOUNT_PARAM,
      folder: { type: 'string', description: '原邮件所在文件夹，默认 INBOX。' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return withAccount(args, async (account, resolved) => {
        if (!args.text && !args.html) throw new Error('mail_reply 需要 text 或 html 正文。');
        const original = await readMessage(account, {
          uid: args.uid,
          folder: args.folder ?? 'INBOX',
          markSeen: false,
          maxBodyChars: resolved.maxBodyChars,
        });
        const target = replyTargets(original, args.all === true ? 'replyAll' : 'reply', [
          account.address,
          account.userName,
        ]);
        if (!target.to) throw new Error(`uid=${args.uid} 这封邮件没有可回复的发件人地址。`);

        let text = args.text ?? '';
        if (args.quote === true) {
          const quoted = (original.body || '').split('\n').map((l) => `> ${l}`).join('\n');
          text = `${text}\n\n在 ${fmtDate(original.date)}，${fmtAddrList(original.from)} 写道：\n${quoted}`;
        }
        const base = sessionBaseDir(exec);
        const attachments = (Array.isArray(args.attachments) ? args.attachments : []).map((p) => resolveUserPath(p, base));

        const result = await sendMessage(account, {
          to: target.to,
          cc: target.cc,
          subject: target.subject,
          text: args.text ? text : undefined,
          html: args.html,
          attachments,
          inReplyTo: target.inReplyTo,
          references: target.references,
        });
        return [
          `已回复 uid=${args.uid}（原主题: ${original.subject}）。`,
          `发往: ${target.to}${target.cc?.length ? `，抄送 ${target.cc.join(', ')}` : ''}`,
          `主题: ${target.subject}`,
          `Message-ID: ${result.messageId ?? '(无)'}`,
          `服务器响应: ${result.response ?? '(无)'}`,
        ].join('\n');
      });
    },
  });

  register({
    name: 'mail_update',
    description:
      '改变邮件的状态或位置：标记已读/未读、加/取消星标、移动到指定文件夹、删除（移到垃圾箱，可逆）。' +
      'uids 传一个或多个 uid。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['markRead', 'markUnread', 'flag', 'unflag', 'move', 'delete'],
        description: 'markRead 标为已读 | markUnread 标为未读 | flag 加星标 | unflag 取消星标 | move 移动到 to | delete 移到垃圾箱（可逆）。',
      },
      uid: { type: 'integer', description: '单个邮件 UID。' },
      uids: { type: 'array', items: { type: 'integer' }, description: '多个邮件 UID。' },
      to: { type: 'string', description: 'action=move 时的目标文件夹。' },
      folder: FOLDER_PARAM,
      account: ACCOUNT_PARAM,
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      return withAccount(args, async (account) => {
        const uids = [].concat(args.uid ?? [], args.uids ?? []).filter((v) => v !== undefined && v !== null);
        if (uids.length === 0) throw new Error('mail_update 需要 uid 或 uids。');
        const result = await updateMessages(account, args.action, {
          uid: uids,
          folder: args.folder ?? 'INBOX',
          to: args.to,
        });
        if (result.moved !== undefined) return `已把 ${result.moved} 封邮件从 ${args.folder ?? 'INBOX'} 移动到「${result.to}」。`;
        return `已对 ${result.updated} 封邮件执行 ${result.action}（文件夹 ${result.folder}）。`;
      });
    },
  });
  };

  // ③ 工具：**必须**走 inject 声明依赖。
  //    绝对不能去「探测」`ctx.tools` 来判断服务在不在：cordis 的上下文在没有声明该依赖时
  //    访问服务会直接抛 `cannot get property "tools" without inject` —— 而 `ctx?.tools &&`
  //    这种写法救不了，getter 在求值那一步就炸了。炸的后果是整个插件激活失败，工具和界面
  //    一起消失（这一条是真实踩过的坑，别改回去）。
  if (typeof ctx.inject === 'function') ctx.inject(['tools'], registerTools);
  else registerTools(ctx); // 测试里的假 ctx 没有 inject，直接同步注册
}

// Keep the helpers exported so a Host-local consumer or a test can format the
// same way the tools do, without duplicating the layout or the page-size rule.
export { clampLimit, MAX_LIST_LIMIT, sanitizeFilename, toText };

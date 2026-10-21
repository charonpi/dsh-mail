/**
 * dsh-mail 冒烟测试 —— 尽力在没有真实邮箱凭证的前提下，把能验证的都验证掉。
 *
 * 覆盖：
 *   1. 用真实的 `defineTool` 注册全部 8 个工具（参数 DSL 一旦写错就会在这里抛）。
 *   2. 参数 DSL 真的被转成了 JSON Schema（检查 required / enum）。
 *   3. `apply()` 对空配置不抛异常，并给出可操作的补配置指引。
 *   4. 配置解析：预设、环境变量、多账号、默认账号、问题清单。
 *   5. 凭证不外泄：不可枚举、不进入 JSON.stringify / spread / 工具输出。
 *   6. 附件真的要读盘并进入 MIME（用捕获式 transport 检查组信，再用真实 nodemailer 产出 MIME）。
 *   7. 回复头（Re: / In-Reply-To / References / reply-all 去重）。
 *   8. IMAP 连不上时给出的是「可操作的中文提示」而不是裸错误。
 *   9. 附件文件名防目录穿越。
 *
 * 未能覆盖（需要真实凭证或服务器）：真实 IMAP 登录、真实 SMTP 投递、
 * 真实附件下载。这些留给带授权码的端到端验收。
 *
 * 运行： node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.tmp-test');

// Windows: the ESM loader rejects a bare absolute path — it needs a file:// URL.
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}
async function acheck(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}\n       ${error.message}`);
  }
}

const SECRET = 'zbqxmnvjkasdfwer'; // a 16-char stand-in for a QQ authorization code
process.env.QQMAIL_AUTH_CODE = SECRET;

console.log('== 1/2. 工具注册（真实 defineTool） ==');
const {
  apply,
  name: pluginName,
  clampLimit,
  MAX_LIST_LIMIT,
} = await imp('lib/index.js');
assert.equal(pluginName, 'dsh-mail');
// 刻意不导出对象级 inject：那会把 apply() 推迟，而桌面端的页面注入表只收集一次，
// 晚一步悬浮入口就永远进不了表（界面不出现）。工具改成在 apply 内部同步注册，
// 或等 tools 就绪后再注册 —— 两条路都要在下面的断言里被覆盖。
assert.equal(typeof apply, 'function', 'apply 必须是函数');

// 让 cfg() 读账号文件时落在临时目录，避免受本机已保存账号影响
process.env.DSH_MAIL_DATA_DIR = path.join(root, '.tmp-test', 'smoke-data');

function registerWith(config) {
  const tools = new Map();
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return tool;
      },
    },
  };
  apply(ctx, config);
  return tools;
}

const emptyConfig = { accounts: [] };
let tools = registerWith(emptyConfig);
const EXPECTED = [
  'mail_accounts',
  'mail_folders',
  'mail_list',
  'mail_search',
  'mail_read',
  'mail_send',
  'mail_reply',
  'mail_update',
];
check('注册了全部 8 个工具', () => {
  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED].sort());
});
check('每个工具都有描述、参数与输出 schema', () => {
  for (const t of tools.values()) {
    assert.equal(typeof t.description, 'string');
    assert.ok(t.description.length > 10, `${t.name} 描述太短`);
    assert.equal(typeof t.parameters, 'object');
    assert.ok(t.output?.schema, `${t.name} 缺少 output.schema`);
    assert.equal(typeof t.execute, 'function', `${t.name} 缺少 execute`);
  }
});
check('mail_send 必需的 to/subject 进入了 JSON Schema 的 required', () => {
  const p = tools.get('mail_send').parameters;
  assert.equal(p.type, 'object');
  assert.deepEqual([...p.required].sort(), ['subject', 'to']);
  assert.equal(p.properties.attachments.type, 'array');
  assert.equal(p.properties.attachments.items.type, 'string');
  assert.equal(p.properties.to.type, 'string');
});
check('mail_update 的 action 枚举被保留', () => {
  const p = tools.get('mail_update').parameters;
  assert.deepEqual(p.required, ['action']);
  assert.deepEqual(p.properties.action.enum, ['markRead', 'markUnread', 'flag', 'unflag', 'move', 'delete']);
});
check('mail_read 的 uid 是必填 integer', () => {
  const p = tools.get('mail_read').parameters;
  assert.deepEqual(p.required, ['uid']);
  assert.equal(p.properties.uid.type, 'integer');
  assert.equal(p.properties.attachmentIndexes.items.type, 'integer');
});
check('mail_accounts 不接受任何参数', () => {
  const p = tools.get('mail_accounts').parameters;
  assert.equal(p.type, 'object');
  assert.deepEqual(p.required ?? [], []);
});
check(`limit 被夹在 1..${MAX_LIST_LIMIT}，工具描述与实际上限一致`, () => {
  assert.equal(clampLimit(undefined, 20), 20);
  assert.equal(clampLimit(null, 25), 25);
  assert.equal(clampLimit(0, 20), 1);
  assert.equal(clampLimit(-5, 20), 1);
  assert.equal(clampLimit(5.9, 20), 5);
  assert.equal(clampLimit(999999, 20), MAX_LIST_LIMIT);
  assert.equal(clampLimit(Number.NaN, 20), 20);
  assert.match(tools.get('mail_list').parameters.properties.limit.description, new RegExp(String(MAX_LIST_LIMIT)));
  assert.match(tools.get('mail_search').parameters.properties.limit.description, new RegExp(String(MAX_LIST_LIMIT)));
});

console.log('\n== 2.5 宿主的真实 schema 校验（register 内部用的就是这几个函数） ==');
const { assertObjectJsonSchema, assertSupportedJsonSchema } = await import('@deepseek-ai/dsh-tools');
check('每个工具的 output.schema 通过宿主支持的 JSON Schema 子集校验', () => {
  for (const t of tools.values()) assertSupportedJsonSchema(t.output.schema);
});
check('每个工具的 parameters 是 object-rooted 且通过校验', () => {
  for (const t of tools.values()) assertObjectJsonSchema(t.parameters);
});
await acheck('真实 defineTool 的入参校验会拦住缺必填参数的调用', async () => {
  await assert.rejects(
    () => tools.get('mail_send').execute({ subject: 's', text: 't' }, {}),
    (error) => error?.name === 'ToolArgsError' || /to/.test(error?.message ?? ''),
  );
});
await acheck('真实 defineTool 的入参校验会拦住类型错误的调用', async () => {
  await assert.rejects(
    () => tools.get('mail_read').execute({ uid: 'not-a-number' }, {}),
    (error) => error?.name === 'ToolArgsError' || /uid/.test(error?.message ?? ''),
  );
});

console.log('\n== 3. 空配置不致命，且给出补配置指引 ==');
await acheck('mail_accounts 在没有任何账号时返回指引而不是抛错', async () => {
  const text = await tools.get('mail_accounts').execute({}, {});
  assert.match(text, /未配置任何邮箱账号/);
  assert.match(text, /authCodeEnv/);
  assert.match(text, /授权码/);
});
await acheck('没有账号时 mail_send 先报告账号缺失（缺账号比缺正文更根本）', async () => {
  await assert.rejects(
    () => tools.get('mail_send').execute({ to: 'a@b.com', subject: 's' }, {}),
    /没有可用账号/,
  );
});

console.log('\n== 4. 配置解析 ==');
const fullConfig = {
  defaultAccount: 'qq',
  attachmentDir: 'mail-attachments',
  accounts: [
    { id: 'qq', provider: 'qq', address: '948048162@qq.com', authCodeEnv: 'QQMAIL_AUTH_CODE' },
    {
      id: 'work',
      address: 'me@example.org',
      imap: { host: 'imap.example.org', port: 993, secure: true },
      smtp: { host: 'smtp.example.org', port: 587, secure: false },
      password: 'inline-secret-value',
    },
    { id: 'broken', address: 'broken@example.org', provider: 'nosuchprovider' },
  ],
};
tools = registerWith(fullConfig);
const { normalizeConfig, publicAccount, selectAccount } = await imp('lib/config.js');
await acheck('有账号但缺正文时 mail_send 报正文缺失', async () => {
  await assert.rejects(
    () => tools.get('mail_send').execute({ to: 'a@b.com', subject: 's', account: 'work' }, {}),
    /text 或 html/,
  );
});
const parsed = normalizeConfig(fullConfig);
check('qq 预设被解析出来（IMAP 993 / SMTP 465）', () => {
  const qq = parsed.accounts.find((a) => a.id === 'qq');
  assert.equal(qq.imap.host, 'imap.qq.com');
  assert.equal(qq.imap.port, 993);
  assert.equal(qq.imap.secure, true);
  assert.equal(qq.smtp.host, 'smtp.qq.com');
  assert.equal(qq.smtp.port, 465);
  assert.equal(qq.smtp.secure, true);
  assert.equal(qq._ready, true);
});
check('环境变量里的授权码被读到', () => {
  const qq = parsed.accounts.find((a) => a.id === 'qq');
  assert.equal(qq._secret, SECRET);
  assert.equal(qq._secretSource, 'env:QQMAIL_AUTH_CODE');
});
check('自定义 imap/smtp 走 STARTTLS (587)', () => {
  const work = parsed.accounts.find((a) => a.id === 'work');
  assert.equal(work.imap.port, 993);
  assert.equal(work.smtp.port, 587);
  assert.equal(work.smtp.secure, false);
  assert.equal(work._secret, 'inline-secret-value');
});
check('坏账号被报告为问题而不是崩溃', () => {
  assert.ok(parsed.problems.some((p) => p.includes('nosuchprovider')), parsed.problems.join(' | '));
  assert.ok(parsed.problems.some((p) => p.includes('找不到密码')), parsed.problems.join(' | '));
});
check('selectAccount 应用默认账号并能报错', () => {
  assert.equal(selectAccount(parsed, undefined).account.id, 'qq');
  assert.equal(selectAccount(parsed, 'work').account.id, 'work');
  assert.match(selectAccount(parsed, 'nope').error, /nope/);
});

console.log('\n== 4.5 域名 → 服务商自动推断 ==');
const { providerForDomain, presetFor, presetIds } = await imp('lib/providers.js');
check('常见的国内/国际域名都能推断出预设', () => {
  const cases = {
    'qq.com': 'qq',
    'foxmail.com': 'qq',
    'vip.qq.com': 'qq',
    'exmail.qq.com': 'exmail',
    '163.com': '163',
    '126.com': '126',
    'yeah.net': 'yeah',
    'sina.com': 'sina',
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
    'icloud.com': 'icloud',
    'me.com': 'icloud',
    'mac.com': 'icloud',
    'yahoo.com': 'yahoo',
    'ymail.com': 'yahoo',
    'zoho.com': 'zoho',
    'zoho.eu': 'zoho',
    'fastmail.com': 'fastmail',
  };
  for (const [domain, expected] of Object.entries(cases)) {
    assert.equal(providerForDomain(domain), expected, `${domain} 应推断为 ${expected}`);
  }
});
check('大小写、@ 前缀与子域都被归一化', () => {
  assert.equal(providerForDomain('  GMAIL.COM '), 'gmail');
  assert.equal(providerForDomain('@163.com'), '163');
  assert.equal(providerForDomain('mail.gmail.com'), 'gmail');
  assert.equal(providerForDomain('student.163.com'), '163');
});
check('不会把 acme.com 误判成 icloud（后缀必须落在标签边界）', () => {
  assert.equal(providerForDomain('acme.com'), null);
  assert.equal(providerForDomain('notme.com'), null);
  assert.equal(providerForDomain('example.org'), null);
  assert.equal(providerForDomain(''), null);
  assert.equal(providerForDomain(undefined), null);
});
check('presetFor 接受预设 id、别名与裸域名', () => {
  assert.equal(presetFor('qq').label, 'QQ 邮箱');
  assert.equal(presetFor('163').label, '网易 163');
  assert.equal(presetFor('netease').label, '网易 163');
  assert.equal(presetFor('163.com').label, '网易 163');
  assert.equal(presetFor('google').label, 'Gmail');
  assert.equal(presetFor('microsoft').label, 'Outlook / Microsoft 365');
  assert.equal(presetFor('nosuch'), null);
  assert.equal(presetFor(''), null);
});
check('只写 address（不写 provider）也能拿到服务器地址', () => {
  const c = normalizeConfig({ accounts: [{ id: 'g', address: 'me@gmail.com', password: 'x' }] });
  const acc = c.accounts[0];
  assert.equal(acc.provider, 'gmail');
  assert.equal(acc.imap.host, 'imap.gmail.com');
  assert.equal(acc.smtp.host, 'smtp.gmail.com');
  assert.equal(acc._ready, true);
  assert.deepEqual(c.problems, []);
});
check('每个预设都有 label 与整数端口', () => {
  const ids = presetIds();
  assert.ok(ids.length >= 16, `预设数量偏少：${ids.length}`);
  for (const id of ids) {
    const p = presetFor(id);
    assert.ok(p.imap?.host, `${id} 缺 imap.host`);
    assert.ok(p.smtp?.host, `${id} 缺 smtp.host`);
    assert.equal(typeof p.label, 'string');
    assert.ok(Number.isInteger(p.imap.port) && Number.isInteger(p.smtp.port), `${id} 端口不是整数`);
  }
});
check('outlook / icloud 用 587 + STARTTLS，Gmail 用 465 隐式 TLS', () => {
  assert.equal(presetFor('outlook').smtp.port, 587);
  assert.equal(presetFor('outlook').smtp.secure, false);
  assert.equal(presetFor('outlook').smtp.requireTLS, true);
  assert.equal(presetFor('icloud').smtp.port, 587);
  assert.equal(presetFor('icloud').smtp.secure, false);
  assert.equal(presetFor('gmail').smtp.port, 465);
  assert.equal(presetFor('gmail').smtp.secure, true);
});

console.log('\n== 5. 凭证不外泄 ==');
check('_secret 不可枚举', () => {
  const qq = parsed.accounts.find((a) => a.id === 'qq');
  assert.ok(!Object.keys(qq).includes('_secret'));
  assert.ok(!Object.keys(qq).includes('_secretSource'));
  assert.ok(!Object.getOwnPropertyDescriptor(qq, '_secret').enumerable);
});
check('JSON.stringify 整个配置不含授权码', () => {
  const dump = JSON.stringify(parsed);
  assert.ok(!dump.includes(SECRET), '授权码出现在 JSON.stringify 结果里！');
  assert.ok(!dump.includes('inline-secret-value'), '内联密码出现在 JSON.stringify 结果里！');
});
check('展开对象不含授权码', () => {
  const qq = parsed.accounts.find((a) => a.id === 'qq');
  assert.ok(!JSON.stringify({ ...qq }).includes(SECRET));
});
check('publicAccount 只暴露「有没有」，不暴露「是什么」', () => {
  const pub = publicAccount(parsed.accounts.find((a) => a.id === 'qq'));
  assert.equal(pub.hasSecret, true);
  assert.equal(pub.secretSource, 'env:QQMAIL_AUTH_CODE');
  assert.ok(!JSON.stringify(pub).includes(SECRET));
});
await acheck('mail_accounts 的真实输出不含授权码', async () => {
  const text = await tools.get('mail_accounts').execute({}, {});
  assert.ok(!text.includes(SECRET), '工具输出泄露了授权码！');
  assert.match(text, /948048162@qq\.com/);
  assert.match(text, /imap\.qq\.com:993 TLS/);
  assert.match(text, /已提供（来源 env:QQMAIL_AUTH_CODE）/);
  assert.match(text, /\[默认账号\]/);
});

console.log('\n== 6. 附件组装（捕获 transport + 真实 MIME，不发真实邮件） ==');
mkdirSync(tmp, { recursive: true });
const attachmentPath = path.join(tmp, '申请材料.txt');
const attachmentBody = '这是附件正文，用来验证附件真的被读到并进入了 MIME。\n';
writeFileSync(attachmentPath, attachmentBody, 'utf8');
const { sendMessage, replyTargets, sanitizeFilename } = await imp('lib/mail.js');
const nodemailer = (await import('nodemailer')).default;
const workAccount = parsed.accounts.find((a) => a.id === 'work');

// A transport that records exactly what sendMessage hands to the mailer. This
// is the strongest check of the plugin's own assembly, with no network at all.
const captured = [];
const capturingTransport = {
  sendMail(options) {
    captured.push(options);
    // Mirror real nodemailer: accepted covers to + cc + bcc.
    const accepted = [].concat(options.to ?? [], options.cc ?? [], options.bcc ?? []);
    return Promise.resolve({
      accepted,
      rejected: [],
      messageId: '<captured@dsh-mail.test>',
      response: '250 captured',
    });
  },
};

await acheck('sendMessage 组出的信封与附件完全符合预期', async () => {
  const result = await sendMessage(
    workAccount,
    {
      to: 'kai.zhang@bristol.ac.uk',
      cc: 'a@b.com, c@d.com',
      subject: 'PhD Application',
      text: '正文',
      attachments: [attachmentPath],
      appendToSent: false,
    },
    { transport: capturingTransport },
  );
  assert.equal(captured.length, 1);
  const sent = captured[0];
  assert.equal(sent.subject, 'PhD Application');
  assert.equal(sent.text, '正文');
  assert.deepEqual(sent.to, ['kai.zhang@bristol.ac.uk']);
  assert.deepEqual(sent.cc, ['a@b.com', 'c@d.com']);
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].filename, '申请材料.txt');
  assert.ok(Buffer.isBuffer(sent.attachments[0].content), '附件必须是 Buffer');
  assert.equal(sent.attachments[0].content.toString('utf8'), attachmentBody, '附件内容必须与磁盘一致');
  assert.equal(result.attachmentCount, 1);
  assert.equal(result.attachments[0].filename, '申请材料.txt');
  assert.equal(
    result.attachments[0].size,
    Buffer.byteLength(attachmentBody, 'utf8'),
    '上报的附件大小必须是磁盘字节数（不能是 sendMail 改写后的 base64 长度）',
  );
  assert.deepEqual(result.accepted, ['kai.zhang@bristol.ac.uk', 'a@b.com', 'c@d.com']);
  assert.ok(result.messageId, '缺少 Message-ID');
  assert.equal(result.appendedTo, null);
});

await acheck('把捕获到的信封交给真实 nodemailer，产出真正的 MIME 并带上附件', async () => {
  const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await streamTransport.sendMail(captured[0]);
  const mime = Buffer.isBuffer(info.message) ? info.message.toString('utf8') : String(info.message);
  assert.match(mime, /^From: /m);
  assert.match(mime, /^Subject: PhD Application$/m);
  assert.match(mime, /multipart\/mixed/);
  assert.match(mime, /Content-Disposition: attachment/);
  // A non-ASCII filename must survive as RFC 2231 continuation encoding, and
  // the attachment body must appear base64-encoded.
  assert.match(mime, /filename\*0\*=utf-8''/, '中文附件名必须按 RFC 2231 编码');
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  const b64 = Buffer.from(attachmentBody, 'utf8').toString('base64');
  assert.ok(mime.replace(/\r\n/g, '').includes(b64), 'MIME 里必须能找到附件正文的 base64');
});
await acheck('不存在的附件会抛可读错误', async () => {
  await assert.rejects(
    () =>
      sendMessage(
        workAccount,
        { to: 'a@b.com', subject: 's', text: 't', attachments: [path.join(tmp, 'nope.txt')], appendToSent: false },
        { transport: capturingTransport },
      ),
    /附件不存在或不是文件/,
  );
});
await acheck('没有收件人会抛可读错误', async () => {
  await assert.rejects(
    () => sendMessage(workAccount, { to: '', subject: 's', text: 't', appendToSent: false }, { transport: capturingTransport }),
    /收件人/,
  );
});

console.log('\n== 7. 回复头 ==');
check('mail_reply 的头部正确（Re: / In-Reply-To / References 累加）', () => {
  const original = {
    subject: 'PhD Application-Zizheng Wang',
    messageId: '<abc@qq.com>',
    references: ['<root@x.com>'],
    from: [{ address: 'kai.zhang@bristol.ac.uk' }],
    to: [{ address: '948048162@qq.com' }, { address: 'other@x.com' }],
    cc: [{ address: 'cc@x.com' }],
  };
  const single = replyTargets(original, 'reply');
  assert.equal(single.to, 'kai.zhang@bristol.ac.uk');
  assert.deepEqual(single.cc, []);
  assert.equal(single.subject, 'Re: PhD Application-Zizheng Wang');
  assert.equal(single.inReplyTo, '<abc@qq.com>');
  assert.deepEqual(single.references, ['<root@x.com>', '<abc@qq.com>']);

  const all = replyTargets(original, 'replyAll', ['948048162@qq.com']);
  assert.equal(all.to, 'kai.zhang@bristol.ac.uk');
  assert.deepEqual(all.cc.sort(), ['cc@x.com', 'other@x.com'], 'reply-all 应排除自己并去重');
  const withoutOwn = replyTargets(original, 'replyAll');
  assert.ok(
    withoutOwn.cc.includes('948048162@qq.com'),
    '不传自己的地址就无法排除自己 —— 所以 mail_reply 必须把账号地址传进来',
  );
});
check('已有 Re: 前缀不重复添加', () => {
  assert.equal(replyTargets({ subject: 'Re: x', from: [{ address: 'a@b.c' }] }, 'reply').subject, 'Re: x');
  assert.equal(replyTargets({ subject: 'RE: x', from: [{ address: 'a@b.c' }] }, 'reply').subject, 'RE: x');
});

console.log('\n== 8/9. 错误提示与文件名安全 ==');
await acheck('IMAP 连不上时给出可操作的中文提示（且不含密码）', async () => {
  const fake = {
    id: 'probe',
    address: 'probe@example.org',
    userName: 'probe@example.org',
    imap: { host: '127.0.0.1', port: 9, secure: false },
    smtp: { host: '127.0.0.1', port: 9, secure: false },
    timeoutMs: 3000,
    _secret: SECRET,
  };
  const { listMailboxes } = await imp('lib/mail.js');
  const error = await listMailboxes(fake).then(
    () => null,
    (e) => e,
  );
  assert.ok(error, '应当抛错');
  assert.match(error.message, /无法连接|超时|登录被拒|TLS|认证|失败/);
  assert.ok(!error.message.includes(SECRET), '错误信息泄露了授权码！');
});
check('sanitizeFilename 挡住目录穿越与非法字符', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeFilename('C:\\Users\\x\\a.txt'), 'a.txt');
  assert.equal(sanitizeFilename('/etc/shadow'), 'shadow');
  assert.equal(sanitizeFilename('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.ok(!sanitizeFilename('...').includes('..'));
  assert.ok(sanitizeFilename('').length > 0, '空名要有兜底');
});

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('全部通过。');
/**
 * 收信链路集成测试：真实的 IMAP 协议 + 真实的 MIME。
 *
 * 与 smtp-send.mjs 对称：那边验证「发得出去」，这边验证「收得回来」。两者都跑真实的
 * 进程内服务器和真正的线协议，因此不需要任何邮箱账号或网络。
 *
 * 覆盖：文件夹列表（含特殊用途与未读计数）、邮件列表（信封/标志/大小/附件判定）、
 * 条件搜索、按 UID 读信（正文、收件人、抄送、附件清单）、附件落盘、标记已读/星标、
 * 移动到垃圾箱，以及「回复全部」的抄送集合。
 *
 * 特别地，这里断言 `to`/`cc` **不能是空地址**：曾经它们被直接喂给 addressList，
 * 而 mailparser 交出来的是 `{value, text}` 而非地址数组，于是每条真实邮件的
 * 收件人都会变成 `[{name: null, address: null}]`，「回复全部」也就会静默丢掉所有抄送人。
 *
 * 不覆盖：真实邮箱服务商的行为差异（需要你的授权码）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakeImap } from './fake-imap.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.tmp-test', 'imap');
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
    console.log(`  FAIL ${label}\n         ${error.message}`);
  }
}
async function acheck(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}\n         ${error.message}`);
  }
}

rmSync(path.join(root, '.tmp-test', 'imap'), { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// ---------------------------------------------------------------------------
// 两封真实结构的邮件
// ---------------------------------------------------------------------------
const CRLF = '\r\n';
const b64 = (b) => Buffer.from(b).toString('base64').replace(/(.{76})/g, `$1${CRLF}`);

const SIMPLE = [
  'From: Alice <alice@example.org>',
  'To: me@example.org',
  'Subject: Hello from Alice',
  'Date: Mon, 20 Oct 2026 10:00:00 +0800',
  'Message-ID: <one@example.org>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '第一封：纯文本，没有附件。',
  '',
].join(CRLF);

const ATTACH_NAME = '报告.txt';
const ATTACH_BODY = '附件内容：博士申请材料\n';
const encName = `=?UTF-8?B?${Buffer.from(ATTACH_NAME, 'utf8').toString('base64')}?=`;
const WITH_ATTACHMENT = [
  'From: Bob <bob@example.org>',
  'To: me@example.org',
  'Cc: carol@example.org',
  'Subject: Report attached',
  'Date: Mon, 20 Oct 2026 11:30:00 +0800',
  'Message-ID: <two@example.org>',
  'In-Reply-To: <one@example.org>',
  'References: <one@example.org>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BB"',
  '',
  '--BB',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '第二封：请看附件。',
  '--BB',
  'Content-Type: text/plain; charset=utf-8; name="' + encName + '"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="' + encName + '"',
  '',
  b64(Buffer.from(ATTACH_BODY, 'utf8')),
  '--BB--',
  '',
].join(CRLF);

const fake = createFakeImap({
  user: 'me@example.org',
  pass: 'imap-secret-value',
  messages: [
    {
      uid: 1,
      flags: ['\\Seen'],
      source: SIMPLE,
      date: 'Mon, 20 Oct 2026 10:00:00 +0800',
      subject: 'Hello from Alice',
      from: [{ name: 'Alice', address: 'alice@example.org' }],
      to: [{ name: null, address: 'me@example.org' }],
      messageId: '<one@example.org>',
    },
    {
      uid: 2,
      flags: [],
      source: WITH_ATTACHMENT,
      date: 'Mon, 20 Oct 2026 11:30:00 +0800',
      subject: 'Report attached',
      from: [{ name: 'Bob', address: 'bob@example.org' }],
      to: [{ name: null, address: 'me@example.org' }],
      cc: [{ name: null, address: 'carol@example.org' }],
      messageId: '<two@example.org>',
      bodyStructure:
        '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 24 1 NIL NIL NIL NIL)' +
        '("TEXT" "PLAIN" ("CHARSET" "utf-8" "NAME" "report.txt") NIL NIL "BASE64" 40 1 ' +
        '("ATTACHMENT" ("FILENAME" "report.txt")) NIL NIL)' +
        ' "MIXED" ("BOUNDARY" "BB") NIL NIL NIL)',
    },
  ],
});

const port = await fake.listen();

const { apply } = await imp('lib/index.js');
const mail = await imp('lib/mail.js');
const { normalizeConfig } = await imp('lib/config.js');

const account = {
  id: 'fake',
  address: 'me@example.org',
  imap: { host: '127.0.0.1', port, secure: false },
  smtp: { host: '127.0.0.1', port: 1, secure: false, requireTLS: false },
  userName: 'me@example.org',
  password: 'imap-secret-value',
  appendToSent: false,
  timeoutMs: 8000,
};

const tools = new Map();
apply({ tools: { register: (t) => (tools.set(t.name, t), t) } }, { accounts: [account], timeoutMs: 8000 });
const call = (name, args) => tools.get(name).execute(args, {});
const normalized = normalizeConfig({ accounts: [account] }).accounts[0];

console.log('\n== 1. 认证与连接 ==');
check('账号归一化后就绪', () => assert.equal(normalized._ready, true));
await acheck('mail_folders 能列出来', async () => {
  const out = await call('mail_folders', {});
  assert.match(out, /INBOX/);
  assert.match(out, /Sent/);
  assert.match(out, /Trash/);
});
check('认证用的就是配置里的用户名与授权码', () => {
  const parts = String(fake.authSeen).split('\u0000');
  assert.ok(parts.includes('me@example.org'), `认证串里没有用户名: ${JSON.stringify(fake.authSeen)}`);
  assert.ok(parts.includes('imap-secret-value'), '认证串里没有授权码');
});

console.log('\n== 2. 邮件列表 ==');
let listOut = '';
await acheck('mail_list 返回两封，最新在前', async () => {
  listOut = await call('mail_list', { folder: 'INBOX', limit: 10 });
  assert.ok(listOut.includes('Report attached'), '缺第二封');
  assert.ok(listOut.includes('Hello from Alice'), '缺第一封');
  assert.ok(
    listOut.indexOf('Report attached') < listOut.indexOf('Hello from Alice'),
    '不是最新在前',
  );
});
check('列表里标出了未读与含附件', () => {
  // 标志打在 `#N  uid=N  日期  [未读 有附件]` 这一行，不在主题行
  const header = listOut.split('\n').find((l) => /uid=2\b/.test(l)) ?? '';
  assert.match(header, /未读/, `第二封应标未读: ${header}`);
  assert.match(header, /有附件/, `第二封应标含附件: ${header}`);
});
check('列表里第一封是已读且无附件', () => {
  const header = listOut.split('\n').find((l) => /uid=1\b/.test(l)) ?? '';
  assert.ok(!/未读/.test(header), `第一封不该标未读: ${header}`);
  assert.ok(!/有附件/.test(header), `第一封不该标含附件: ${header}`);
});
check('列表抬头给出总数与命中数', () => {
  assert.match(listOut, /文件夹 INBOX：共 2 封/);
});

console.log('\n== 3. 条件搜索 ==');
await acheck('unreadOnly 只返回未读那封', async () => {
  const out = await call('mail_search', { folder: 'INBOX', unreadOnly: true });
  assert.ok(out.includes('Report attached'), '应包含未读的第二封');
  assert.ok(!out.includes('Hello from Alice'), '不应包含已读的第一封');
});
await acheck('from 条件能命中发件人', async () => {
  const out = await call('mail_search', { folder: 'INBOX', from: 'alice@example.org' });
  assert.ok(out.includes('Hello from Alice'), '按发件人搜应命中第一封');
});
await acheck('搜不到时给出空结果而不是报错', async () => {
  const out = await call('mail_search', { folder: 'INBOX', subject: '绝不可能匹配的主题zzz' });
  assert.ok(!out.includes('Report attached'), '不该命中');
});

console.log('\n== 4. 按 UID 读信（真实 MIME 解码） ==');
let msg = null;
await acheck('mail_read 读到第二封', async () => {
  const out = await call('mail_read', { uid: 2, folder: 'INBOX' });
  assert.ok(out.includes('Report attached'), '缺主题');
  assert.ok(out.includes('bob@example.org'), '缺发件人');
  assert.ok(out.includes('第二封：请看附件。'), '缺正文');
  assert.ok(out.includes(ATTACH_NAME), `缺附件名 ${ATTACH_NAME}`);
  msg = await mail.readMessage(normalized, { uid: 2, folder: 'INBOX' });
});
check('readMessage 的 from 正确', () => {
  assert.deepEqual(msg.from, [{ name: 'Bob', address: 'bob@example.org' }]);
});
check('readMessage 的 to 不是空地址（回归：曾全部是 null）', () => {
  assert.deepEqual(msg.to, [{ name: null, address: 'me@example.org' }], `实际: ${JSON.stringify(msg.to)}`);
});
check('readMessage 的 cc 不是空地址（回归）', () => {
  assert.deepEqual(msg.cc, [{ name: null, address: 'carol@example.org' }], `实际: ${JSON.stringify(msg.cc)}`);
});
check('附件名（RFC 2047 中文）与大小正确', () => {
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, ATTACH_NAME);
  assert.equal(msg.attachments[0].size, Buffer.byteLength(ATTACH_BODY, 'utf8'));
});
check('会话头被保留（回复用得上）', () => {
  assert.equal(msg.messageId, '<two@example.org>');
  assert.equal(msg.inReplyTo, '<one@example.org>');
  assert.deepEqual(msg.references, ['<one@example.org>']);
});
check('回复全部带上抄送人（回归：曾静默丢光 cc）', () => {
  const targets = mail.replyTargets(msg, 'replyAll', ['me@example.org']);
  assert.equal(targets.to, 'bob@example.org');
  assert.deepEqual(targets.cc, ['carol@example.org'], `实际: ${JSON.stringify(targets.cc)}`);
  assert.equal(targets.subject, 'Re: Report attached');
});
check('单个人回复不带抄送', () => {
  const targets = mail.replyTargets(msg, 'reply', []);
  assert.deepEqual(targets.cc, []);
});

console.log('\n== 5. 附件下载到磁盘 ==');
await acheck('mail_read + saveAttachmentsTo 真的把附件写下来', async () => {
  const out = await call('mail_read', { uid: 2, folder: 'INBOX', saveAttachmentsTo: tmp });
  assert.ok(out.includes('附件已保存'), `输出里没有保存提示: ${out.slice(0, 200)}`);
  const file = path.join(tmp, ATTACH_NAME);
  assert.ok(readFileSync(file, 'utf8') === ATTACH_BODY, '落盘内容不一致');
});
await acheck('只下载指定序号的附件', async () => {
  const dir = path.join(tmp, 'only0');
  await call('mail_read', { uid: 2, folder: 'INBOX', saveAttachmentsTo: dir, attachmentIndexes: [0] });
  assert.equal(readFileSync(path.join(dir, ATTACH_NAME), 'utf8'), ATTACH_BODY);
});

console.log('\n== 6. 状态变更 ==');
await acheck('markRead 发出 +FLAGS (\\Seen)', async () => {
  await call('mail_update', { action: 'markRead', uid: 2, folder: 'INBOX' });
  const last = fake.stores.at(-1);
  assert.equal(last.sign, '+');
  assert.deepEqual(last.flags, ['\\Seen']);
  assert.deepEqual(last.uids, [2], `STORE 作用到了 ${JSON.stringify(last.uids)}`);
  assert.ok(fake.boxMessages.INBOX.find((m) => m.uid === 2).flags.includes('\\Seen'));
});
await acheck('markUnread 发出 -FLAGS (\\Seen)', async () => {
  await call('mail_update', { action: 'markUnread', uid: 2, folder: 'INBOX' });
  const last = fake.stores.at(-1);
  assert.equal(last.sign, '-');
  assert.deepEqual(last.flags, ['\\Seen']);
  assert.ok(!fake.boxMessages.INBOX.find((m) => m.uid === 2).flags.includes('\\Seen'));
});
await acheck('flag / unflag 操作星标', async () => {
  await call('mail_update', { action: 'flag', uid: 2, folder: 'INBOX' });
  assert.deepEqual(fake.stores.at(-1).flags, ['\\Flagged']);
  await call('mail_update', { action: 'unflag', uid: 2, folder: 'INBOX' });
  assert.equal(fake.stores.at(-1).sign, '-');
});
await acheck('多个 uid 一起处理', async () => {
  await call('mail_update', { action: 'markRead', uids: [1, 2], folder: 'INBOX' });
  assert.deepEqual(fake.stores.at(-1).uids.slice().sort(), [1, 2], `实际: ${JSON.stringify(fake.stores.at(-1).uids)}`);
});
await acheck('delete 把邮件移到垃圾箱（可逆）', async () => {
  await call('mail_update', { action: 'delete', uid: 1, folder: 'INBOX' });
  assert.equal(fake.moves.at(-1).to, 'Trash');
  assert.deepEqual(fake.moves.at(-1).uids, [1]);
  assert.deepEqual(fake.boxMessages.INBOX.map((m) => m.uid), [2], '第一封应已离开 INBOX');
});
await acheck('move 到指定文件夹', async () => {
  await call('mail_update', { action: 'move', uid: 2, folder: 'INBOX', to: 'Drafts' });
  assert.equal(fake.moves.at(-1).to, 'Drafts');
  assert.deepEqual(fake.boxMessages.Drafts.map((m) => m.uid), [2]);
});
await acheck('uid 缺失时报错而不是静默成功', async () => {
  await assert.rejects(() => call('mail_update', { action: 'markRead', folder: 'INBOX' }), /uid/i);
});
await acheck('不认识的 action 被拒绝', async () => {
  await assert.rejects(() => call('mail_update', { action: 'explode', uid: 1, folder: 'INBOX' }), /action/i);
});

console.log('\n== 7. 找不到的邮件要说清楚 ==');
await acheck('不存在的 uid 给出可读错误', async () => {
  await assert.rejects(() => call('mail_read', { uid: 9999, folder: 'INBOX' }), /9999|找不到|missing/i);
});

console.log('\n== 8. 协议层面做了什么 ==');
check('走的是标准 IMAP 命令序列', () => {
  for (const cmd of ['CAPABILITY', 'LIST', 'STATUS', 'SELECT', 'FETCH', 'UID', 'LOGOUT']) {
    assert.ok(fake.commands.includes(cmd), `命令序列里没有 ${cmd}（实际: ${[...new Set(fake.commands)].join(' ')}）`);
  }
});
check('移动用的是服务端 MOVE（而不是退化成本地拷贝）', () => {
  assert.ok(fake.moves.length >= 2, `只记录了 ${fake.moves.length} 次 MOVE`);
});
check('每个会话都干净登出', () => {
  const logouts = fake.commands.filter((c) => c === 'LOGOUT').length;
  assert.ok(logouts >= 8, `只登出了 ${logouts} 次`);
});

fake.close();

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）。`);
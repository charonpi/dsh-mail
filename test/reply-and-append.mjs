/**
 * 回复链路集成测试：从一个真实的 IMAP 服务器读原信，经一个真实的 SMTP 服务器发出去。
 *
 * 这是用户最常用的动作，也是唯一跨两套协议的操作，所以单独测：
 *   - 「回复」只发给原发件人；「回复全部」才带上原抄送人
 *   - Re: 主题、In-Reply-To、References 会话头真的进了报文（收件人那边才会归到同一会话）
 *   - quote=true 会附上原文
 *   - 读原信不应把原信标成已读
 *   - appendToSent=true 时真的向 IMAP 追加了一份发件副本
 *
 * 同样不需要任何邮箱账号或网络。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simpleParser } from 'mailparser';
import { createFakeImap } from './fake-imap.mjs';
import { createSmtpServer } from './fake-smtp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.tmp-test', 'reply');
const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);

let passed = 0;
const failures = [];
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

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const CRLF = '\r\n';
const b64 = (b) => Buffer.from(b).toString('base64').replace(/(.{76})/g, `$1${CRLF}`);
const ATTACH_NAME = '报告.txt';
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
  b64(Buffer.from('附件内容\n', 'utf8')),
  '--BB--',
  '',
].join(CRLF);

const fakeImap = createFakeImap({
  user: 'me@example.org',
  pass: 'imap-secret-value',
  messages: [
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
    },
  ],
});
const smtp = createSmtpServer();
const imapPort = await fakeImap.listen();
const smtpPort = await smtp.listen();

const { apply } = await imp('lib/index.js');
const account = {
  id: 'fake',
  address: 'me@example.org',
  imap: { host: '127.0.0.1', port: imapPort, secure: false },
  smtp: { host: '127.0.0.1', port: smtpPort, secure: false, requireTLS: false },
  userName: 'me@example.org',
  password: 'imap-secret-value',
  appendToSent: false,
  timeoutMs: 8000,
};
const tools = new Map();
apply({ tools: { register: (t) => (tools.set(t.name, t), t) } }, { accounts: [account], timeoutMs: 8000 });
const call = (name, args) => tools.get(name).execute(args, {});
const lastParsed = async () => simpleParser(smtp.messages.at(-1).raw);

console.log('\n== 1. 回复单个人 ==');
await acheck('mail_reply 只发给原发件人', async () => {
  const out = await call('mail_reply', { uid: 2, folder: 'INBOX', text: '收到，谢谢。' });
  assert.equal(smtp.messages.length, 1, '应该只发出 1 封');
  assert.ok(out.includes('bob@example.org'), `返回文案里没有收件人: ${out.slice(0, 160)}`);
  assert.deepEqual(smtp.messages[0].envelope.rcpt, ['bob@example.org'], '不该发给抄送人');
});
let parsed = null;
await acheck('报文里带上 Re: 主题与会话头', async () => {
  parsed = await lastParsed();
  assert.equal(parsed.subject, 'Re: Report attached');
  assert.equal(parsed.headers.get('in-reply-to'), '<two@example.org>');
  const refs = String(parsed.headers.get('references'));
  assert.ok(refs.includes('<one@example.org>'), `References 丢了原来的头: ${refs}`);
  assert.ok(refs.includes('<two@example.org>'), `References 没把当前邮件追加进去: ${refs}`);
  assert.ok(refs.indexOf('<one@example.org>') < refs.indexOf('<two@example.org>'), 'References 顺序不对');
});
check('正文就是给的内容，没有 Cc 头', () => {
  assert.ok(String(parsed.text).includes('收到，谢谢。'), '正文缺内容');
  assert.equal(parsed.headers.get('cc'), undefined, '单人回复不该有 Cc');
});
check('读原信没有把原信标成已读', () => {
  assert.deepEqual(fakeImap.stores, [], `不该发出 STORE：${JSON.stringify(fakeImap.stores)}`);
});

console.log('\n== 2. 回复全部 ==');
await acheck('mail_reply all=true 把原抄送人带上', async () => {
  const before = smtp.messages.length;
  const out = await call('mail_reply', { uid: 2, folder: 'INBOX', text: '大家都看一下。', all: true });
  assert.equal(smtp.messages.length, before + 1);
  const rcpt = smtp.messages.at(-1).envelope.rcpt;
  assert.ok(rcpt.includes('bob@example.org'), `缺原发件人: ${rcpt}`);
  assert.ok(rcpt.includes('carol@example.org'), `缺原抄送人: ${rcpt}`);
  assert.ok(out.includes('carol@example.org'), `返回文案没列出抄送人: ${out.slice(0, 200)}`);
});
await acheck('回复全部的报文里有 Cc 头', async () => {
  const p = await lastParsed();
  // mailparser 把 Cc 解析成地址对象（{value:[...], text}），不是字符串
  const cc = (p.cc?.value ?? []).map((a) => a.address);
  assert.ok(cc.includes('carol@example.org'), `Cc 头不对: ${JSON.stringify(cc)}`);
  assert.ok(!cc.includes('me@example.org'), `不该把自己放进 Cc: ${JSON.stringify(cc)}`);
});

console.log('\n== 3. 附上原文 ==');
await acheck('quote=true 把原文逐行加 > 引用', async () => {
  await call('mail_reply', { uid: 2, folder: 'INBOX', text: '见下。', quote: true });
  const p = await lastParsed();
  assert.ok(String(p.text).includes('见下。'), '缺新正文');
  assert.match(String(p.text), /写道：/, '缺引用引导语');
  assert.match(String(p.text), /^> 第二封：请看附件。/m, '原文没有被逐行引用');
});

console.log('\n== 4. 回复带附件 ==');
await acheck('mail_reply 的附件真的进了报文', async () => {
  const file = path.join(tmp, '补充材料.txt');
  writeFileSync(file, '补充材料内容\n', 'utf8');
  await call('mail_reply', { uid: 2, folder: 'INBOX', text: '补充材料见附件。', attachments: [file] });
  const p = await lastParsed();
  assert.equal(p.attachments.length, 1, `附件数不对: ${p.attachments.length}`);
  assert.equal(p.attachments[0].filename, '补充材料.txt');
  assert.equal(p.attachments[0].content.toString('utf8'), '补充材料内容\n');
});

console.log('\n== 5. 错误路径 ==');
await acheck('没有正文时拒绝发送', async () => {
  const before = smtp.messages.length;
  await assert.rejects(() => call('mail_reply', { uid: 2, folder: 'INBOX' }), /text|html|正文/i);
  assert.equal(smtp.messages.length, before, '不该发出任何邮件');
});
await acheck('uid 不存在时拒绝发送', async () => {
  const before = smtp.messages.length;
  await assert.rejects(() => call('mail_reply', { uid: 9999, folder: 'INBOX', text: 'x' }), /9999|找不到/i);
  assert.equal(smtp.messages.length, before, '不该发出任何邮件');
});

console.log('\n== 6. 追加发件副本 ==');
await acheck('appendToSent=true 会向 IMAP 追加一份', async () => {
  const before = (fakeImap.boxMessages.Sent ?? []).length;
  const out = await call('mail_send', {
    to: 'dave@example.org',
    subject: '带副本的信',
    text: '正文。',
    appendToSent: true,
  });
  const after = (fakeImap.boxMessages.Sent ?? []).length;
  assert.equal(after, before + 1, `Sent 里没有多出邮件（前 ${before} 后 ${after}）`);
  assert.ok(out.includes('已追加到'), `返回文案没说明追加: ${out.slice(-160)}`);
  // 中文主题在报文里是 MIME 编码的，所以解回来再比
  const copy = await simpleParser(fakeImap.boxMessages.Sent.at(-1).source);
  assert.equal(copy.subject, '带副本的信');
  assert.ok(fakeImap.boxMessages.Sent.at(-1).flags.includes('\\Seen'), '副本应带 \\Seen');
});
await acheck('副本与真正发出去的字节是同一份', async () => {
  const sent = await simpleParser(smtp.messages.at(-1).raw);
  const copy = await simpleParser(fakeImap.boxMessages.Sent.at(-1).source);
  assert.equal(copy.messageId, sent.messageId, 'Message-ID 不一致，说明是两次编译');
  assert.equal(String(copy.text).trim(), String(sent.text).trim());
});
await acheck('appendToSent=false 不去连 IMAP', async () => {
  const before = (fakeImap.boxMessages.Sent ?? []).length;
  const out = await call('mail_send', {
    to: 'dave@example.org',
    subject: '不带副本',
    text: '正文。',
    appendToSent: false,
  });
  assert.equal((fakeImap.boxMessages.Sent ?? []).length, before, '不该追加');
  assert.ok(out.includes('未追加发件副本'), `返回文案不对: ${out.slice(-120)}`);
});

fakeImap.close();
smtp.close();

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）。`);
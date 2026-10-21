/**
 * 出站链路集成测试：让 nodemailer 真的把邮件（含附件）通过一个 socket 发出去。
 *
 * 为什么需要它：单元测试能证明「附件对象被正确组装」，但证明不了「它真的能作为
 * MIME 的一部分走完协议、并且能被解回来」。这里在进程内起一个最小 SMTP 服务器，
 * 把收到的原始报文用**插件读信时用的同一个 mailparser** 解回来 —— 发出去的东西
 * 能被解回来，才算收发闭环。
 *
 * 刻意覆盖的点：
 *   - 多收件人 + cc + bcc 的**信封**与**信头**区别（bcc 必须在信封里、绝不能在信头里）
 *   - 附件的文件名与字节内容（含非 ASCII 文件名与非 ASCII 内容）
 *   - 多个附件
 *   - 非 ASCII 主题的编码与回解
 *   - senderName / replyTo 覆盖
 *   - requireTLS: false 真的不要求 STARTTLS
 *   - 认证确实带了账号的用户名与授权码
 *
 * 不覆盖：TLS/STARTTLS（测试账号显式设 requireTLS: false）与真实 IMAP 收信。
 * 需要真实凭据的那部分只能对着真实邮箱跑。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSmtpServer } from './fake-smtp.mjs';
import { simpleParser } from 'mailparser';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.tmp-test', 'smtp');
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

// ---------------------------------------------------------------------------
// 准备
// ---------------------------------------------------------------------------
rmSync(path.join(root, '.tmp-test', 'smtp'), { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const ATTACH_NAME = '申请材料-附件.txt';
const ATTACH_BODY = '第一行：博士申请材料\n第二行：with ascii and 中文 mixed\n';
const attachPath = path.join(tmp, ATTACH_NAME);
writeFileSync(attachPath, ATTACH_BODY, 'utf8');

const BIN_NAME = 'tiny.bin';
const BIN_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x7f, 0x80, 0x0a, 0x0d, 0x00]);
const binPath = path.join(tmp, BIN_NAME);
writeFileSync(binPath, BIN_BYTES);

const SECRET = 'auth-code-must-not-leak-into-transcript';
const smtp = createSmtpServer();
const port = await smtp.listen();

const account = {
  id: 'test',
  label: '测试账号',
  address: 'sender@example.org',
  senderName: '发件人显示名',
  replyTo: 'reply@example.org',
  imap: { host: '127.0.0.1', port: 1, secure: false },
  smtp: { host: '127.0.0.1', port, secure: false, requireTLS: false },
  userName: 'sender@example.org',
  password: SECRET,
  appendToSent: false,
};

const { apply } = await imp('lib/index.js');
const tools = new Map();
const ctx = { tools: { register: (t) => (tools.set(t.name, t), t) } };
apply(ctx, { accounts: [account], timeoutMs: 5000 });
const send = tools.get('mail_send');

console.log('\n== 1. 带附件的真实 SMTP 投递 ==');
const SUBJECT = '测试主题 with ASCII 和中文';
let out = '';
await acheck('mail_send 成功返回', async () => {
  out = await send.execute(
    {
      to: 'a@example.org, b@example.org',
      cc: 'c@example.org',
      bcc: 'd@example.org',
      subject: SUBJECT,
      text: '正文第一行\n正文第二行',
      attachments: [attachPath, binPath],
      senderName: '覆盖后的显示名',
      replyTo: '自定义回复@example.org',
    },
    {},
  );
  assert.equal(typeof out, 'string');
  assert.match(out, /已通过 test（sender@example\.org）发出/);
});

check('服务器确实收到了 1 封', () => assert.equal(smtp.messages.length, 1));

const received = smtp.messages[0];

check('SMTP 认证模式被使用（AUTH PLAIN 或 LOGIN）', () => {
  assert.ok(smtp.authMode === 'PLAIN' || smtp.authMode === 'LOGIN', `实际: ${smtp.authMode}`);
});
check('认证用的凭据就是账号地址与授权码', () => {
  const captured = received.auth?.plain ?? Object.values(received.auth ?? {}).filter(Boolean).join('\u0000');
  assert.ok(captured.includes('sender@example.org'), '认证里没有账号地址');
  assert.ok(captured.includes(SECRET), '认证里没有授权码');
});
check('链条里没有出现 STARTTLS（requireTLS: false 生效）', () => {
  assert.ok(!smtp.commands.includes('STARTTLS'), `命令序列: ${smtp.commands.join(' ')}`);
});
check('信封发件人正确', () => assert.equal(received.envelope.from, 'sender@example.org'));
check('信封收件人 = to + cc + bcc（bcc 必须出现在信封里）', () => {
  assert.deepEqual(
    received.envelope.rcpt.slice().sort(),
    ['a@example.org', 'b@example.org', 'c@example.org', 'd@example.org'].sort(),
  );
});

console.log('\n== 2. 把收到的原始报文用 mailparser 解回来 ==');
const parsed = await simpleParser(received.raw);

check('主题完整回解（含非 ASCII）', () => assert.equal(parsed.subject, SUBJECT));
check('发件人显示名用了 senderName 覆盖值', () => {
  assert.equal(parsed.from.value[0].name, '覆盖后的显示名');
  assert.equal(parsed.from.value[0].address, 'sender@example.org');
});
check('收件人与抄送正确', () => {
  assert.deepEqual(parsed.to.value.map((v) => v.address).sort(), ['a@example.org', 'b@example.org']);
  assert.deepEqual(parsed.cc.value.map((v) => v.address), ['c@example.org']);
});
check('bcc 绝不出现在信头里', () => {
  assert.equal(parsed.headers.get('bcc'), undefined, 'bcc 泄漏进了信头');
  assert.ok(!/^bcc:/im.test(received.raw), '原始报文里有 Bcc 信头');
});
check('Reply-To 被 replyTo 覆盖', () => {
  assert.equal(parsed.replyTo.value[0].address, '自定义回复@example.org');
});
check('正文完整回解', () => assert.match(parsed.text, /正文第一行[\s\S]*正文第二行/));
check('有 2 个附件', () => assert.equal(parsed.attachments.length, 2, `实际 ${parsed.attachments.length} 个`));

check('非 ASCII 附件名与字节内容完全一致', () => {
  const got = parsed.attachments.find((a) => a.filename === ATTACH_NAME);
  assert.ok(got, `没找到附件 ${ATTACH_NAME}，实际: ${parsed.attachments.map((a) => a.filename).join(', ')}`);
  assert.equal(got.content.toString('utf8'), ATTACH_BODY);
});
check('二进制附件的字节完全一致（未被换行转换破坏）', () => {
  const got = parsed.attachments.find((a) => a.filename === BIN_NAME);
  assert.ok(got, '没找到二进制附件');
  assert.ok(got.content.equals(BIN_BYTES), `字节不符: ${got.content.toString('hex')} vs ${BIN_BYTES.toString('hex')}`);
});

console.log('\n== 3. 工具返回文案 ==');
check('返回里有收件人、Message-ID 与服务器响应', () => {
  assert.match(out, /收件人: .*a@example\.org/);
  assert.match(out, /Message-ID: /);
  assert.match(out, /服务器响应: /);
});
check('返回里列出了两个附件及大小', () => {
  assert.match(out, /附件 2 个/);
  assert.ok(out.includes(ATTACH_NAME), '返回文案里没有附件名');
  assert.ok(out.includes(BIN_NAME), '返回文案里没有二进制附件名');
});
check('返回文案里没有授权码', () => {
  assert.ok(!out.includes(SECRET), '工具输出泄漏了授权码');
});
check('未追加发件副本（appendToSent: false 生效，没有去连 IMAP）', () => {
  assert.match(out, /未追加发件副本/);
});

console.log('\n== 4. 单附件与无附件路径 ==');
await acheck('无附件发送不带 multipart', async () => {
  smtp.messages.length = 0;
  const text = await send.execute({ to: 'z@example.org', subject: '无附件', text: 'hi' }, {});
  assert.equal(smtp.messages.length, 1);
  const p = await simpleParser(smtp.messages[0].raw);
  assert.equal(p.attachments.length, 0);
  assert.ok(!text.includes('附件'), `无附件时不该提附件: ${text}`);
});
await acheck('附件不存在时给出可读错误，而不是发出半截邮件', async () => {
  smtp.messages.length = 0;
  await assert.rejects(
    () => send.execute({ to: 'z@example.org', subject: 'x', text: 'hi', attachments: [path.join(tmp, '不存在.bin')] }, {}),
    /不存在|not found|ENOENT|读取/i,
  );
  assert.equal(smtp.messages.length, 0, '文件读不到时不应该发出任何邮件');
});

await smtp.close();

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）。`);

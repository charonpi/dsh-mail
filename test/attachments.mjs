/**
 * 附件下载链路测试：真实 MIME → mailparser 解码 → 落盘。
 *
 * 为什么需要它：单元测试覆盖了 sanitizeFilename，但 saveAttachments 本身此前**零覆盖**，
 * 而它正是「下载附件」的落地环节。这里喂进去的是一封手工构造的 multipart 报文
 * （模拟真实/恶意发件人），走的就是插件读信时那条解析路径。
 *
 * 刻意覆盖的点：
 *   - RFC 2047 编码的非 ASCII 文件名能被还原成中文名
 *   - 中文字节内容与二进制字节内容都逐字节一致
 *   - 名为 `../../evil.txt` 的附件**只能落在目标目录里**，目录外不得出现任何文件
 *   - only 按索引挑选、越界索引不报错、skipped 计数正确
 *   - 目标目录不存在时自动创建
 *
 * 说明：saveAttachments 里的「越界就抛错」是纵深防御。按 sanitizeFilename 的构造
 * （先取 basename，再剥首尾的点与空白）它实际上不可达 —— 所以这里断言的是**可观察性质**
 * （目录外没有东西被写出来），而不是一个构造不出来的抛错。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { simpleParser } from 'mailparser';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmp = path.join(root, '.tmp-test', 'attach');
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

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// ---------------------------------------------------------------------------
// 手工构造报文：这是恶意/普通发件人真正会发出来的那种结构
// ---------------------------------------------------------------------------
const CN_NAME = '申请材料.txt';
const CN_BODY = '第一行：博士申请材料\n第二行：中文与 ascii mixed\n';
const BIN_BYTES = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80, 0x0d, 0x0a, 0x1a, 0x00]);
const HOSTILE_NAME = '../../evil.txt';
const HOSTILE_BODY = 'EVIL-PAYLOAD';

const encName = `=?UTF-8?B?${Buffer.from(CN_NAME, 'utf8').toString('base64')}?=`;
const b64 = (buf) => Buffer.from(buf).toString('base64').replace(/(.{76})/g, '$1\r\n');

const raw = [
  'From: attacker@example.org',
  'To: me@example.org',
  'Subject: =?UTF-8?B?' + Buffer.from('附件测试', 'utf8').toString('base64') + '?=',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUND42"',
  '',
  '--BOUND42',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  '正文部分',
  '--BOUND42',
  'Content-Type: text/plain; charset=utf-8; name="' + encName + '"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="' + encName + '"',
  '',
  b64(Buffer.from(CN_BODY, 'utf8')),
  '--BOUND42',
  'Content-Type: application/octet-stream; name="tiny.bin"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="tiny.bin"',
  '',
  b64(BIN_BYTES),
  '--BOUND42',
  'Content-Type: text/plain; name="' + HOSTILE_NAME + '"',
  'Content-Transfer-Encoding: base64',
  'Content-Disposition: attachment; filename="' + HOSTILE_NAME + '"',
  '',
  b64(Buffer.from(HOSTILE_BODY, 'utf8')),
  '--BOUND42--',
  '',
].join('\r\n');

const parsed = await simpleParser(raw);

// readMessage 就是这样把解析结果挂到返回对象上的（不可枚举，避免被序列化出去）
const message = {
  uid: 7,
  subject: parsed.subject,
  attachments: parsed.attachments.map((a, i) => ({ index: i, filename: a.filename ?? null, size: a.content?.length ?? 0, contentType: a.contentType ?? null })),
  attachmentCount: parsed.attachments.length,
};
Object.defineProperty(message, '_parsed', { value: parsed, enumerable: false });

const { saveAttachments, sanitizeFilename } = await imp('lib/mail.js');

console.log('\n== 1. 报文本身被正确解析（先确认 fixture 立得住） ==');
check('解析出 3 个附件', () => assert.equal(parsed.attachments.length, 3, `实际 ${parsed.attachments.length}`));
check('RFC 2047 编码的中文文件名被还原', () => {
  assert.ok(
    parsed.attachments.some((a) => a.filename === CN_NAME),
    `实际文件名: ${parsed.attachments.map((a) => a.filename).join(' | ')}`,
  );
});

console.log('\n== 2. 落盘：字节与文件名 ==');
const dir = path.join(tmp, 'out');
let result;
await acheck('saveAttachments 全部保存成功', async () => {
  result = await saveAttachments(message, dir);
  assert.equal(result.saved.length, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.directory, path.resolve(dir));
});
check('目标目录被自动创建', () => assert.ok(existsSync(dir)));

check('中文名附件：名字还原正确、字节一致', () => {
  const got = result.saved.find((s) => s.name === CN_NAME);
  assert.ok(got, `没找到，实际: ${result.saved.map((s) => s.name).join(' | ')}`);
  assert.equal(readFileSync(got.file).toString('utf8'), CN_BODY);
  assert.equal(got.size, Buffer.byteLength(CN_BODY, 'utf8'));
});
check('二进制附件：字节逐字节一致（未被换行/编码破坏）', () => {
  const got = result.saved.find((s) => s.name === 'tiny.bin');
  assert.ok(got, '没找到 tiny.bin');
  assert.ok(readFileSync(got.file).equals(BIN_BYTES), `实际 ${readFileSync(got.file).toString('hex')}`);
  assert.equal(got.contentType, 'application/octet-stream');
});

console.log('\n== 3. 目录穿越：只允许落在目标目录内 ==');
check('恶意文件名被净化成 basename', () => {
  assert.equal(sanitizeFilename(HOSTILE_NAME), 'evil.txt');
});
check('恶意附件确实落在目标目录内，文件名是 evil.txt', () => {
  const got = result.saved.find((s) => s.name === 'evil.txt');
  assert.ok(got, `没找到 evil.txt，实际: ${result.saved.map((s) => s.name).join(' | ')}`);
  assert.equal(readFileSync(got.file).toString('utf8'), HOSTILE_BODY);
});
check('每一个落盘路径都在目标目录之内', () => {
  const base = path.resolve(dir) + path.sep;
  for (const s of result.saved) {
    assert.ok(path.resolve(s.file).startsWith(base), `越界: ${s.file}`);
  }
});
check('目录之外没有产生任何文件（../../evil.txt 那条路径不存在）', () => {
  // dir = <tmp>/out，所以 ../../evil.txt 相对 dir 会落到 <root>/.tmp-test 之外
  const escapes = [
    path.join(tmp, 'evil.txt'),
    path.resolve(dir, '..', '..', 'evil.txt'),
    path.resolve(dir, '..', 'evil.txt'),
  ];
  for (const p of escapes) assert.ok(!existsSync(p), `不该存在: ${p}`);
});

console.log('\n== 4. only 挑选与边界 ==');
await acheck('only 只取指定索引，skipped 计数正确', async () => {
  const one = await saveAttachments(message, path.join(tmp, 'one'), [1]);
  assert.deepEqual(one.saved.map((s) => s.name), ['tiny.bin']);
  assert.equal(one.skipped, 2);
});
await acheck('only 传单个数字也可以（不是数组）', async () => {
  const one = await saveAttachments(message, path.join(tmp, 'one2'), 0);
  assert.equal(one.saved.length, 1);
  assert.equal(one.saved[0].name, CN_NAME);
});
await acheck('越界索引不抛错，只是什么都没保存', async () => {
  const none = await saveAttachments(message, path.join(tmp, 'none'), [99]);
  assert.deepEqual(none.saved, []);
  assert.equal(none.skipped, 3);
});
await acheck('only 传 null/undefined 等价于全部', async () => {
  const a = await saveAttachments(message, path.join(tmp, 'allA'), null);
  const b = await saveAttachments(message, path.join(tmp, 'allB'), undefined);
  assert.equal(a.saved.length, 3);
  assert.equal(b.saved.length, 3);
  assert.equal(a.skipped, 0);
  assert.equal(b.skipped, 0);
});

console.log('\n== 5. 没有附件时不要制造空目录噪音 ==');
await acheck('无附件的邮件：saved 为空、不抛错', async () => {
  const bare = { uid: 1 };
  Object.defineProperty(bare, '_parsed', { value: { attachments: [] }, enumerable: false });
  const r = await saveAttachments(bare, path.join(tmp, 'bare'));
  assert.deepEqual(r.saved, []);
  assert.equal(r.skipped, 0);
});

console.log('');
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项，通过 ${passed} 项：`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`全部通过（${passed} 项）。`);
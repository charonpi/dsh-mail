/**
 * 清单自检 —— 一个插件能不能被 DSH 安装、能不能上架市场，靠的是包清单本身。
 * 这个脚本把「清单 ↔ 实际文件 ↔ 加载器方言」三者对齐关系全部机器校验一遍，
 * 任何一项不满足都直接失败，避免带着 not-bundle / 缺文件 / 图标不合规的包去发布。
 *
 * 覆盖：
 *   1. dsh.bundle.patch 声明存在、指向的文件真实存在、且能被 YAML 解析。
 *   2. patch 的方言正确：顶层是数组，元素含 insert 数组，行里有 id 与 name，
 *      且 name 与包名一致（否则装上了也不会加载）。
 *   3. files 里列出的每一项都存在（发布 tarball 用的是 files，不是目录遍历）。
 *   4. 运行期必需文件全部被 files 覆盖（漏一个就会装出个残缺包）。
 *   5. main / exports 指向的文件都存在。
 *   6. locale/*.json 的 meta.title 与 meta.description 都是非空字符串（市场展示用）。
 *   7. 图标存在、是 SVG、体积在限制内。
 *   8. engines.dsh 是合法 SemVer range；若本机装了 DSH，还能比对是否兼容。
 *
 * 运行： node test/validate-manifest.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const problems = [];
const checked = [];
const fail = (message) => problems.push(message);
const ok = (message) => checked.push(message);

// --- 1. bundle 声明 ---------------------------------------------------------
const patchRef = pkg.dsh?.bundle?.patch;
if (typeof patchRef !== 'string' || patchRef.trim() === '') {
  fail('package.json 缺少 dsh.bundle.patch —— 没有它安装会被以 not-bundle 拒绝');
} else {
  const patchPath = at(patchRef.replace(/^\.\//, ''));
  if (!existsSync(patchPath)) {
    fail(`dsh.bundle.patch 指向的 ${patchRef} 不存在；发布包里必须带上它`);
  } else {
    ok(`dsh.bundle.patch -> ${patchRef}`);

    // --- 2. patch 方言 ------------------------------------------------------
    let doc;
    try {
      doc = YAML.parse(readFileSync(patchPath, 'utf8'));
    } catch (error) {
      fail(`${patchRef} 不是合法 YAML：${error.message}`);
    }
    if (doc !== undefined) {
      if (!Array.isArray(doc)) {
        fail(`${patchRef} 的顶层必须是数组（加载器 patch 是一个 patch 列表）`);
      } else {
        const rows = doc.flatMap((entry) => (entry && typeof entry === 'object' && Array.isArray(entry.insert) ? entry.insert : []));
        if (rows.length === 0) {
          fail(`${patchRef} 里没有任何 \`insert:\` 行，装了也不会注册任何东西`);
        }
        const mine = rows.find((row) => row?.name === pkg.name);
        if (!mine) {
          fail(`${patchRef} 的 insert 行里没有 name 等于包名 "${pkg.name}" 的行；name 必须与包名一致才能被解析`);
        } else {
          if (typeof mine.id !== 'string' || mine.id.trim() === '') fail(`${patchRef} 中的 "${pkg.name}" 行缺少 id`);
          else ok(`patch 行 { id: ${mine.id}, name: ${mine.name} }`);
          if (mine.config !== undefined && (typeof mine.config !== 'object' || mine.config === null || Array.isArray(mine.config))) {
            fail(`${patchRef} 中 "${pkg.name}" 的 config 必须是对象`);
          }
        }
        // 用了 !!js 的话，纯 YAML 解析会得到字符串；本包刻意不使用，避免依赖求值上下文。
        if (readFileSync(patchPath, 'utf8').includes('!!js')) {
          fail(`${patchRef} 使用了 !!js 标量；本包不应依赖加载器求值上下文`);
        }
      }
    }
  }
}

// --- 3 & 4. files 覆盖面 ----------------------------------------------------
const declared = Array.isArray(pkg.files) ? pkg.files : [];
if (declared.length === 0) {
  fail('package.json 没有声明 files —— 会把 node_modules 之外的一切（含 test/）都发出去');
} else {
  for (const entry of declared) {
    if (!existsSync(at(entry))) fail(`files 里列出的 "${entry}" 不存在`);
  }
  ok(`files 的 ${declared.length} 项都存在`);
}

/** A runtime file that must be inside the published tarball. */
const REQUIRED_RUNTIME = [
  'lib/index.js',
  'lib/mail.js',
  'lib/config.js',
  'lib/providers.js',
  'locale/en.json',
  'locale/zh.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'LICENSE',
];
function coveredByFiles(target) {
  return declared.some((entry) => target === entry || target.startsWith(`${entry.replace(/\/$/, '')}/`));
}
for (const target of REQUIRED_RUNTIME) {
  if (!existsSync(at(target))) {
    fail(`运行期必需的 ${target} 不存在`);
  } else if (!coveredByFiles(target)) {
    fail(`${target} 没有被 files 覆盖，发布包里会缺它`);
  }
}
ok(`运行期必需的 ${REQUIRED_RUNTIME.length} 个文件都存在且被 files 覆盖`);

// 反向：不该发出去的东西
for (const bad of ['test/smoke.mjs', 'node_modules', '.tmp-test', 'package-lock.json']) {
  if (coveredByFiles(bad)) fail(`files 把不该发布的 "${bad}" 包含了进去`);
}

// --- 5. 入口 ----------------------------------------------------------------
const mainPath = String(pkg.main ?? '');
if (mainPath === '') fail('package.json 没有声明 main');
else if (!existsSync(at(mainPath))) fail(`main 指向的 ${mainPath} 不存在`);
else ok(`main -> ${mainPath}`);

for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value !== 'string') continue;
  if (value.includes('*')) {
    // 通配导出（如 ./locale/*.json）只要求前缀目录存在
    const dir = value.slice(0, value.indexOf('*')).replace(/\/$/, '');
    if (dir !== '' && !existsSync(at(dir))) fail(`exports["${key}"] 的前缀目录 ${dir} 不存在`);
    else ok(`exports["${key}"] -> ${value}`);
    continue;
  }
  if (!existsSync(at(value))) fail(`exports["${key}"] 指向的 ${value} 不存在`);
  else ok(`exports["${key}"] -> ${value}`);
}

// --- 6. 本地化展示元数据 ----------------------------------------------------
const locales = ['locale/en.json', 'locale/zh.json'];
for (const file of locales) {
  if (!existsSync(at(file))) {
    fail(`缺少 ${file}（市场与插件页展示需要本地化标题与描述）`);
    continue;
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(at(file), 'utf8'));
  } catch (error) {
    fail(`${file} 不是合法 JSON：${error.message}`);
    continue;
  }
  for (const key of ['title', 'description']) {
    const value = meta?.meta?.[key];
    if (typeof value !== 'string' || value.trim() === '') fail(`${file} 的 meta.${key} 必须是非空字符串`);
  }
  ok(`${file} 的 meta.title / meta.description 就绪`);
}
if (!locales.includes('locale/en.json')) fail('必须有 locale/en.json');
if (!locales.includes('locale/zh.json')) fail('必须有 locale/zh.json');

// --- 7. 图标 ----------------------------------------------------------------
const iconField = pkg.icon ?? '';
if (iconField === '') {
  fail('package.json 没有声明 icon');
} else {
  const iconPath = at(String(iconField).replace(/^\.\//, ''));
  if (!existsSync(iconPath)) {
    fail(`icon 指向的 ${iconField} 不存在`);
  } else {
    const size = statSync(iconPath).size;
    const head = readFileSync(iconPath, 'utf8').trimStart().slice(0, 200);
    if (size > 256 * 1024) fail(`图标 ${iconField} 有 ${size} 字节，超过 256 KiB`);
    if (!head.startsWith('<svg') && !head.startsWith('<?xml')) fail(`图标 ${iconField} 看起来不是 SVG`);
    if (!head.includes('xmlns="http://www.w3.org/2000/svg"')) fail(`图标 ${iconField} 缺少 SVG 命名空间`);
    ok(`icon -> ${iconField} (${size} 字节, SVG)`);
  }
}

/**
 * Read the DSH runtime version out of an installed `app.asar`.
 *
 * The version that decides `engines.dsh` compatibility is the *running* DSH,
 * and on an installed copy it lives inside the asar archive rather than on
 * disk. asar is cheap to read directly: a 16-byte pickle header, the JSON tree
 * at offset 16, and file bodies concatenated at `8 + picklePayloadSize`.
 * @returns {string|null} version, or null when no DSH install is found
 */
function readDshRuntimeVersion() {
  const candidates = [
    'D:\\DSH\\DSH NEXT\\resources\\app.asar',
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DSH', 'resources', 'app.asar'),
  ];
  const archive = candidates.find((p) => p !== '' && existsSync(p));
  if (archive === undefined) return null;
  let fd;
  try {
    fd = openSync(archive, 'r');
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const picklePayloadSize = head.readUInt32LE(4);
    const jsonSize = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    readSync(fd, json, 0, jsonSize, 16);
    const dataOffset = 8 + picklePayloadSize;
    const tree = JSON.parse(json.toString('utf8'));
    // 逐段下降，避免手写长链时漏掉某一层的 .files（asar 里每个目录都是节点）。
    const entry = ['node_modules', '@deepseek-ai', 'dsh-app-boot', 'package.json'].reduce(
      (acc, segment) => acc?.files?.[segment],
      tree,
    );
    if (entry === undefined || entry.offset === undefined) {
      // 找到安装却读不到版本，说明 asar 布局变了 —— 说出来，不要假装「没装」。
      console.log(`  (warn) 在 ${archive} 里没找到 @deepseek-ai/dsh-app-boot/package.json，asar 布局可能变了`);
      return null;
    }
    const body = Buffer.alloc(Number(entry.size));
    readSync(fd, body, 0, body.length, dataOffset + Number(entry.offset));
    return JSON.parse(body.toString('utf8')).version ?? null;
  } catch (error) {
    console.log(`  (warn) 读取 DSH 运行时版本失败：${error.message}`);
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// --- 8. engines.dsh ---------------------------------------------------------
const dshRange = pkg.engines?.dsh;
if (typeof dshRange !== 'string' || dshRange.trim() === '') {
  fail('package.json 没有声明 engines.dsh —— 安装器不校验 Node 的 engines，只认 engines.dsh 或 DSH peer 依赖');
} else {
  ok(`engines.dsh = ${dshRange}`);
  const semver = await import('semver').then((m) => m.default ?? m).catch(() => null);
  if (semver === null) {
    console.log('  (skip) 未安装 semver，跳过 range 合法性校验');
  } else {
    if (semver.validRange(dshRange) === null) fail(`engines.dsh "${dshRange}" 不是合法 SemVer range`);
    else ok('engines.dsh 是合法 SemVer range');
    // 本机装了 DSH 就顺便比对一下
    const runtime = readDshRuntimeVersion();
    if (runtime === null) {
      console.log('  (skip) 未找到本机 DSH 安装，跳过运行时版本比对');
    } else if (semver.satisfies(runtime, dshRange, { includePrerelease: true })) {
      ok(`本机 DSH ${runtime} 满足 engines.dsh`);
    } else {
      fail(`本机 DSH ${runtime} 不满足 engines.dsh "${dshRange}"，安装会被拒`);
    }
  }
}

// --- 源码里不该出现的东西 ---------------------------------------------------
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const shipped = walk(root).filter((f) => coveredByFiles(rel(f)));
const secretish = /(?:password|authCode|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i;
for (const file of shipped) {
  if (!/\.(js|json|yml|yaml)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  // 忽略示例/说明里的占位写法
  const hit = secretish.exec(text);
  if (hit && !/your|example|placehold|十六位|SECRET|xxx|\*\*\*/i.test(hit[0])) {
    fail(`${rel(file)} 里疑似硬编码了凭证：${hit[0].slice(0, 40)}…`);
  }
}
ok(`扫描了 ${shipped.length} 个将随包发布的文件，未发现硬编码凭证`);

// --- 结果 -------------------------------------------------------------------
console.log('清单自检结果：');
for (const line of checked) console.log(`  ok   ${line}`);
if (problems.length > 0) {
  console.log(`\n失败 ${problems.length} 项：`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  process.exit(1);
}
console.log(`\n全部通过（${checked.length} 项）。`);
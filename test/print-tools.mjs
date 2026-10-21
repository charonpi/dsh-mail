/**
 * 从真实注册结果导出工具参数表（Markdown），用于校验 README 与代码不漂移。
 * 运行： node test/print-tools.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { apply } = await import(pathToFileURL(path.join(root, 'lib/index.js')).href);

const tools = new Map();
apply({ tools: { register: (t) => (tools.set(t.name, t), t) } }, { accounts: [] });

for (const t of tools.values()) {
  const p = t.parameters;
  const required = new Set(p.required ?? []);
  const rows = Object.entries(p.properties ?? {}).map(([name, spec]) => {
    let type = spec.type;
    if (type === 'array') type = `array<${spec.items?.type ?? '?'}>`;
    if (spec.enum) type += ` (${spec.enum.join(' | ')})`;
    return `| \`${name}\` | ${type} | ${required.has(name) ? '必填' : '可选'} | ${(spec.description ?? '').replace(/\|/g, '\\|')} |`;
  });
  console.log(`\n### \`${t.name}\`\n`);
  console.log(t.description);
  console.log('\n| 参数 | 类型 | 必填 | 说明 |\n|---|---|---|---|');
  console.log(rows.length > 0 ? rows.join('\n') : '| — | — | — | 无参数 |');
}
console.log(`\n<!-- tools: ${[...tools.keys()].join(', ')} -->`);
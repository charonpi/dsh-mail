/**
 * 进程内最小 IMAP 服务器，用于离线验证收信链路。
 *
 * 只实现本插件实际用到的那部分 IMAP（命令序列由 `_research/imap-probe.mjs` 探明：
 * AUTHENTICATE PLAIN → CAPABILITY → LIST "" "" → LIST/LSUB → STATUS → SELECT →
 * [UID SEARCH] → [UID] FETCH → UID STORE / UID MOVE → LOGOUT）。
 *
 * 设计取舍：
 *   - 未知命令一律回 tagged OK，并把每条命令记进 `commands`/`log`。漏实现的部分会
 *     表现为断言失败，而不是让测试挂死。
 *   - 只支持 SEARCH 的 ALL/UNSEEN/SEEN/SUBJECT/FROM/TEXT —— 够覆盖插件会发的条件，
 *     其余条件退化为「全部匹配」，这个局限写在下面而不是假装支持。
 */
import net from 'node:net';

const CRLF = '\r\n';

function quote(s) {
  return `"${String(s).replace(/([\\"])/g, '\\$1')}"`;
}

/** 组装一个 IMAP ENVELOPE 结构。 */
function envelope({ date, subject, from, to, cc, messageId }) {
  const addr = (list) =>
    list === undefined || list === null
      ? 'NIL'
      : `(${list
          .map((a) => {
            const [mailbox, host] = String(a.address).split('@');
            return `(${a.name ? quote(a.name) : 'NIL'} NIL ${quote(mailbox)} ${quote(host)})`;
          })
          .join('')})`;
  return (
    `(${quote(date)} ${quote(subject)} ` +
    `${addr(from)} NIL NIL ${addr(to)} ${addr(cc)} NIL NIL ` +
    `${quote(messageId)})`
  );
}

/** SEARCH 条件求值。只认这几种，其余条件视为「全部匹配」。 */
function matches(msg, criteria) {
  const up = criteria.toUpperCase();
  // 搜索词可能是带引号的字符串，也可能是字面量（非 ASCII 通常走字面量）
  const grab = (key) => {
    const quoted = criteria.match(new RegExp(`${key}\\s+"([^"]*)"`, 'i'));
    if (quoted) return quoted[1];
    const bare = criteria.match(new RegExp(`${key}\\s+(.+)$`, 'i'));
    return bare ? bare[1].trim() : null;
  };
  if (/\bUNSEEN\b/.test(up)) return !msg.flags.includes('\\Seen');
  if (/\bSEEN\b/.test(up)) return msg.flags.includes('\\Seen');
  if (/\bFLAGGED\b/.test(up)) return msg.flags.includes('\\Flagged');
  if (/\bALL\b/.test(up)) return true;
  const subject = grab('SUBJECT');
  if (subject !== null) return String(msg.subject ?? '').toLowerCase().includes(subject.toLowerCase());
  const from = grab('FROM');
  if (from !== null) return (msg.from ?? []).some((a) => String(a.address).toLowerCase().includes(from.toLowerCase()));
  const text = grab('TEXT');
  if (text !== null) return String(msg.source).toLowerCase().includes(text.toLowerCase());
  return true;
}

export function createFakeImap({ user, pass, messages }) {
  const log = [];
  const raw = [];
  const commands = [];
  const stores = [];
  const moves = [];
  let authSeen = null;

  const boxes = [
    { path: 'INBOX', specialUse: '\\Inbox', subscribed: true },
    { path: 'Sent', specialUse: '\\Sent', subscribed: true },
    { path: 'Drafts', specialUse: '\\Drafts', subscribed: true },
    { path: 'Trash', specialUse: '\\Trash', subscribed: false },
  ];
  const boxMessages = { INBOX: messages ?? [] };

  const listLine = (b) => `* LIST (${b.specialUse && b.specialUse !== '\\Inbox' ? `${b.specialUse} ` : ''}\\HasNoChildren) "/" ${quote(b.path)}${CRLF}`;

  const statusLine = (path) => {
    const msgs = boxMessages[path] ?? [];
    const unseen = msgs.filter((m) => !m.flags.includes('\\Seen')).length;
    return `* STATUS ${quote(path)} (MESSAGES ${msgs.length} UIDNEXT ${msgs.length + 1} UIDVALIDITY 1 UNSEEN ${unseen})${CRLF}`;
  };

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let pending = null; // 正在等字面量：{ kind, size, acc, tag, cmd, box }
    let selected = 'INBOX';
    const write = (s) => {
      raw.push(`S ${JSON.stringify(String(s).slice(0, 200))}`);
      socket.write(s);
    };

    write(`* OK [CAPABILITY IMAP4rev1 MOVE UIDPLUS AUTH=PLAIN] fake-imap ready${CRLF}`);

    function parseSet(text) {
      const set = String(text).split(/\s+/)[0];
      const msgs = boxMessages[selected] ?? [];
      if (/^\d+$/.test(set)) return msgs.filter((x) => x.uid === Number(set));
      const range = set.match(/^(\d+):(\d+|\*)$/);
      if (range) {
        const lo = Number(range[1]);
        const hi = range[2] === '*' ? Infinity : Number(range[2]);
        return msgs.filter((x) => x.uid >= lo && x.uid <= hi);
      }
      const list = set.split(',').map(Number).filter(Number.isFinite);
      if (list.length > 0) return msgs.filter((x) => list.includes(x.uid));
      if (set === '*') return msgs;
      return [];
    }

    function doFetch(tag, rest, isUid) {
      const msgs = boxMessages[selected] ?? [];
      const items = (rest.match(/\(([^)]*)\)/)?.[1] ?? 'UID FLAGS').split(/\s+/).filter(Boolean);
      const setText = rest.split(/\s+/)[0];
      const targets = isUid ? parseSet(setText) : msgs;
      for (const msg of targets) {
        const seq = msgs.indexOf(msg) + 1;
        const parts = [];
        if (items.some((i) => i.toUpperCase() === 'UID')) parts.push(`UID ${msg.uid}`);
        if (items.includes('FLAGS')) parts.push(`FLAGS (${msg.flags.join(' ')})`);
        if (items.includes('RFC822.SIZE')) parts.push(`RFC822.SIZE ${Buffer.byteLength(msg.source)}`);
        if (items.includes('ENVELOPE')) parts.push(`ENVELOPE ${envelope(msg)}`);
        if (items.includes('BODYSTRUCTURE')) parts.push(`BODYSTRUCTURE ${msg.bodyStructure ?? '("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 2 1)'}`);
        if (/BODY(\[\]|\.PEEK\[\])/.test(items.join(' '))) {
          const src = Buffer.from(msg.source, 'utf8');
          write(`* ${seq} FETCH (${parts.join(' ')} BODY[] {${src.length}}${CRLF}`);
          socket.write(src);
          write(`)${CRLF}`);
        } else {
          write(`* ${seq} FETCH (${parts.join(' ')})${CRLF}`);
        }
      }
      return write(`${tag} OK ${isUid ? 'UID FETCH' : 'FETCH'} completed${CRLF}`);
    }

    function doStore(tag, rest, isUid) {
      const op = rest.match(/([+-])?FLAGS(?:\.SILENT)?\s*\(([^)]*)\)/i) ?? [];
      const sign = op[1] ?? '';
      const flags = (op[2] ?? '').split(/\s+/).filter(Boolean);
      const targets = parseSet(rest);
      for (const msg of targets) {
        if (sign === '-') msg.flags = msg.flags.filter((f) => !flags.includes(f));
        else for (const f of flags) if (!msg.flags.includes(f)) msg.flags.push(f);
      }
      stores.push({ isUid, sign: sign || '+', flags, uids: targets.map((t) => t.uid) });
      if (!/SILENT/i.test(rest)) {
        const msgs = boxMessages[selected] ?? [];
        for (const msg of targets) {
          write(`* ${msgs.indexOf(msg) + 1} FETCH (UID ${msg.uid} FLAGS (${msg.flags.join(' ')}))${CRLF}`);
        }
      }
      return write(`${tag} OK ${isUid ? 'UID STORE' : 'STORE'} completed${CRLF}`);
    }

    function doMove(tag, rest) {
      const dest = (rest.split(/\s+/)[1] ?? '').replace(/"/g, '');
      const targets = parseSet(rest);
      moves.push({ uids: targets.map((t) => t.uid), to: dest });
      boxMessages[dest] = boxMessages[dest] ?? [];
      for (const msg of targets) boxMessages[dest].push(msg);
      boxMessages[selected] = (boxMessages[selected] ?? []).filter((m) => !targets.includes(m));
      return write(`${tag} OK UID MOVE completed${CRLF}`);
    }

    function handle(line) {
      const m = line.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) return;
      const [, tag, cmdRaw, rest = ''] = m;
      const cmd = cmdRaw.toUpperCase();
      commands.push(cmd);
      const ok = (text = 'completed') => write(`${tag} OK ${cmd} ${text}${CRLF}`);

      const lit = rest.match(/\{(\d+)\}$/);
      if (lit) {
        pending = {
          kind: cmd === 'APPEND' ? 'append' : 'literal',
          size: Number(lit[1]),
          tag,
          cmd,
          // 字面量之前的命令行（用于 SEARCH：条件被拆成前缀 + 字面量）
          prefix: rest.replace(/\{\d+\}$/, '').trim(),
          box: (rest.match(/^"?([^"\s]+)"?/) ?? [, 'INBOX'])[1],
          // `APPEND "Sent" (\Seen) {n}` —— 字面量之前的 (…) 就是新邮件的标志
          flags: ((rest.match(/\(([^)]*)\)/) ?? [])[1] ?? '').split(/\s+/).filter(Boolean),
        };
        write(`+ Ready for literal data${CRLF}`);
        return;
      }

      switch (cmd) {
        case 'CAPABILITY':
          write(`* CAPABILITY IMAP4rev1 MOVE UIDPLUS AUTH=PLAIN${CRLF}`);
          return ok('CAPABILITY');
        case 'AUTHENTICATE':
          if (/PLAIN/i.test(rest)) {
            pending = { kind: 'auth', size: undefined, tag, cmd };
            write(`+ ${CRLF}`);
            return;
          }
          return ok('AUTHENTICATE');
        case 'LOGIN': {
          const parts = rest.split(/\s+/);
          authSeen = parts.join(' ');
          const good = parts.includes(user) && parts.includes(pass);
          return write(`${tag} ${good ? 'OK' : 'NO'} LOGIN ${good ? 'completed' : 'failed'}${CRLF}`);
        }
        case 'LIST': {
          if (/^""\s+""$/.test(rest.trim())) {
            write(`* LIST (\\Noselect) "/" ""${CRLF}`);
            return ok('LIST');
          }
          const pattern = (rest.match(/""\s+"?([^"]*)"?$/) ?? [, '*'])[1] || '*';
          for (const b of boxes) {
            if (pattern === '*' || b.path.toLowerCase() === pattern.toLowerCase()) write(listLine(b));
          }
          return ok('LIST');
        }
        case 'LSUB':
          for (const b of boxes.filter((x) => x.subscribed)) write(listLine(b));
          return ok('LSUB');
        case 'STATUS': {
          write(statusLine((rest.match(/^"?([^"\s]+)"?/) ?? [, 'INBOX'])[1]));
          return ok('STATUS');
        }
        case 'SELECT':
        case 'EXAMINE': {
          selected = (rest.match(/^"?([^"\s]+)"?/) ?? [, 'INBOX'])[1];
          const msgs = boxMessages[selected] ?? [];
          write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)${CRLF}`);
          write(`* ${msgs.length} EXISTS${CRLF}`);
          write(`* 0 RECENT${CRLF}`);
          const firstUnseen = msgs.findIndex((x) => !x.flags.includes('\\Seen'));
          if (firstUnseen >= 0) write(`* OK [UNSEEN ${firstUnseen + 1}] First unseen${CRLF}`);
          write(`* OK [UIDVALIDITY 1] UIDs valid${CRLF}`);
          write(`* OK [UIDNEXT ${msgs.length + 1}] Predicted next UID${CRLF}`);
          write(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Limited${CRLF}`);
          return write(`${tag} OK [${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed${CRLF}`);
        }
        case 'SEARCH': {
          const found = (boxMessages[selected] ?? []).filter((x) => matches(x, rest));
          write(`* SEARCH ${found.map((x) => x.uid).join(' ')}${CRLF}`);
          return ok('SEARCH');
        }
        case 'UID': {
          const sub = (rest.split(/\s+/)[0] ?? '').toUpperCase();
          const subRest = rest.replace(/^\S+\s*/, '');
          if (sub === 'SEARCH') {
            const found = (boxMessages[selected] ?? []).filter((x) => matches(x, subRest));
            write(`* SEARCH ${found.map((x) => x.uid).join(' ')}${CRLF}`);
            return ok('UID SEARCH');
          }
          if (sub === 'FETCH') return doFetch(tag, subRest, true);
          if (sub === 'STORE') return doStore(tag, subRest, true);
          if (sub === 'MOVE') return doMove(tag, subRest);
          return ok(`UID ${sub}`);
        }
        case 'FETCH':
          return doFetch(tag, rest, false);
        case 'STORE':
          return doStore(tag, rest, false);
        case 'LOGOUT':
          write(`* BYE logging out${CRLF}`);
          write(`${tag} OK LOGOUT completed${CRLF}`);
          return socket.end();
        case 'CLOSE':
        case 'NOOP':
          return ok(cmd);
        default:
          return ok(cmd);
      }
    }

    socket.on('data', (chunk) => {
      raw.push(`C ${JSON.stringify(chunk.toString('utf8').slice(0, 200))}`);
      // 必须按字节缓冲：IMAP 的 {n} 字面量长度是**字节数**，而一个汉字在 JS 字符串里
      // 只占 1 个字符。按字符切会永远等不齐字面量，客户端最后超时抛 NoConnection。
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        if (pending) {
          if (pending.kind === 'auth') {
            const idx = buf.indexOf(CRLF);
            if (idx < 0) break;
            const line = buf.subarray(0, idx).toString('utf8');
            buf = buf.subarray(idx + 2);
            const decoded = Buffer.from(line, 'base64').toString('utf8');
            authSeen = decoded;
            const parts = decoded.split('\u0000');
            const good = parts.includes(user) && parts.includes(pass);
            write(`${pending.tag} ${good ? 'OK' : 'NO'} AUTHENTICATE ${good ? 'completed' : 'failed'}${CRLF}`);
            pending = null;
            continue;
          }
          const accBytes = pending.acc ?? Buffer.alloc(0);
          const need = pending.size - accBytes.length;
          if (buf.length < need) break;
          pending.acc = Buffer.concat([accBytes, buf.subarray(0, need)]);
          buf = buf.subarray(need);
          const { tag, cmd, kind, box, prefix, flags } = pending;
          const acc = pending.acc.toString('utf8');
          pending = null;
          if (kind === 'append') {
            boxMessages[box] = boxMessages[box] ?? [];
            boxMessages[box].push({
              uid: 900 + boxMessages[box].length,
              flags: [...(flags ?? [])],
              source: acc,
              subject: '(appended)',
            });
            write(`${tag} OK [APPENDUID 1 900] ${cmd} completed${CRLF}`);
          } else if (/(^|\s)(UID\s+)?SEARCH\b/i.test(`${cmd} ${prefix}`)) {
            // 搜索词以字面量到达：把前缀和字面量拼回完整条件再求值
            const criteria = `${prefix} ${acc}`;
            const found = (boxMessages[selected] ?? []).filter((x) => matches(x, criteria));
            write(`* SEARCH ${found.map((x) => x.uid).join(' ')}${CRLF}`);
            write(`${tag} OK ${cmd} SEARCH completed${CRLF}`);
          } else {
            write(`${tag} OK ${cmd} completed${CRLF}`);
          }
          continue;
        }

        const idx = buf.indexOf(CRLF);
        if (idx < 0) break;
        const line = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 2);
        if (line === '') continue;
        log.push(`>> ${line}`);
        if (line.startsWith('+')) continue;
        handle(line);
      }
    });

    socket.on('error', () => {});
  });

  return {
    log,
    raw,
    commands,
    stores,
    moves,
    get authSeen() {
      return authSeen;
    },
    get boxMessages() {
      return boxMessages;
    },
    listen() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
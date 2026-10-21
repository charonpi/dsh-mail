/**
 * The mail engine: IMAP reads and SMTP sends, provider-agnostic.
 *
 * Everything here is plain Node. Heavy third-party libraries (`imapflow`,
 * `nodemailer`, `mailparser`) are imported lazily inside the functions that
 * need them, so a missing or not-yet-installed dependency produces one clear
 * error message instead of preventing the plugin from loading at all.
 */

const REQUIRED_DEPS = {
  imapflow: 'imapflow',
  nodemailer: 'nodemailer',
  mailparser: 'mailparser',
};

async function need(name) {
  try {
    return await import(name);
  } catch (error) {
    const err = new Error(
      `依赖 ${name} 未能加载：${String(error?.message ?? error)}。请在插件目录里执行 pnpm install / npm install 装上 ${Object.values(REQUIRED_DEPS).join('、')}。`,
    );
    err.code = 'MISSING_DEPENDENCY';
    throw err;
  }
}

/** Run `fn` against a connected IMAP client and always log out. */
export async function withImap(account, fn) {
  const { ImapFlow } = await need('imapflow');
  const client = new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    // Top-level SNI name: imapflow 2.x documents this for host-as-IP connections.
    servername: account.imap.host,
    auth: { user: account.userName || account.address, pass: account._secret },
    logger: false,
    connectionTimeout: account.timeoutMs ?? 30000,
    greetingTimeout: account.timeoutMs ?? 30000,
    socketTimeout: (account.timeoutMs ?? 30000) * 4,
    clientInfo: { name: 'dsh-mail', version: '0.1.0' },
  });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    throw decorate(error, account, 'IMAP');
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* nothing left to close */
      }
    }
  }
}

/** Turn low-level socket/auth failures into something a model can act on. */
function decorate(error, account, phase) {
  const raw = String(error?.message ?? error);
  const hints = [];
  if (/auth|login|credential|password|AUTHENTICATIONFAILED|LOGIN failed/i.test(raw)) {
    hints.push(
      `${account.providerLabel ?? account.provider ?? '该服务商'} 的 ${phase} 认证失败。绝大多数国内邮箱要求用「客户端授权码」而不是登录密码${
        account.providerHint ? `（${account.providerHint}）` : ''
      }。`,
    );
  }
  if (/certificate|self signed|SSL|TLS/i.test(raw)) hints.push('TLS 证书校验失败，请核对端口与 secure 设置。');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) hints.push('域名解析失败，检查服务器地址或本机网络/DNS。');
  if (/ETIMEDOUT|ECONNREFUSED|timeout/i.test(raw)) {
    hints.push('连接超时或被拒绝：确认端口正确、服务商已开启 IMAP/SMTP，必要时检查代理与防火墙。');
  }
  if (account.providerCaveat) hints.push(account.providerCaveat);
  const err = new Error(`${phase} 失败（${account.address || account.id}）：${raw}${hints.length ? `\n提示：${hints.join(' ')}` : ''}`);
  err.code = error?.code ?? 'MAIL_ERROR';
  return err;
}

const specialUseNames = {
  sent: ['\\Sent', '\\SentMail', '\\Sent Messages'],
  drafts: ['\\Drafts'],
  trash: ['\\Trash', '\\Deleted'],
  junk: ['\\Junk', '\\Spam'],
};

const fallbackNames = {
  sent: ['Sent', 'Sent Messages', 'Sent Items', '已发送', '已发送邮件', '已发送消息'],
  drafts: ['Drafts', '草稿', '草稿箱'],
  trash: ['Trash', 'Deleted Messages', '已删除', '已删除邮件'],
  junk: ['Junk', 'Spam', '垃圾邮件', '垃圾箱'],
};

/** Find a special folder by configured name, then by IMAP special-use, then by name. */
async function resolveFolder(client, kind, configured) {
  if (configured) return configured;
  let boxes = [];
  try {
    boxes = await client.list();
  } catch {
    return fallbackNames[kind][0];
  }
  const wanted = specialUseNames[kind];
  const bySpecial = boxes.find((b) => b.specialUse && wanted.includes(b.specialUse));
  if (bySpecial) return bySpecial.path;
  const wantedNames = fallbackNames[kind].map((s) => s.toLowerCase());
  const byName = boxes.find((b) => wantedNames.includes(String(b.path).toLowerCase()));
  return byName ? byName.path : fallbackNames[kind][0];
}

function addressList(list) {
  if (!Array.isArray(list)) return [];
  // mailparser yields `name: ''` for a bare address; normalize that to null so tool
  // output never carries a meaningless empty display name.
  return list.map((a) => ({ name: a?.name ? a.name : null, address: a?.address ?? null }));
}

/** imapflow reports flags as a Set; tolerate array shapes from other sources. */
function flagSetOf(msg) {
  if (msg?.flags instanceof Set) return msg.flags;
  if (Array.isArray(msg?.flags)) return new Set(msg.flags);
  return new Set();
}

/** Compact one-line summary of an envelope for tool output. */
function summarize(msg, index) {
  const env = msg.envelope ?? {};
  const flags = flagSetOf(msg);
  return {
    n: index,
    uid: msg.uid,
    seq: msg.seq,
    subject: env.subject ?? '(无主题)',
    from: addressList(env.from),
    to: addressList(env.to),
    date: env.date ? new Date(env.date).toISOString() : null,
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    size: msg.size ?? null,
    hasAttachments: hasAttachments(msg.bodyStructure),
  };
}

function hasAttachments(structure) {
  if (!structure) return false;
  const disposition = Array.isArray(structure.disposition)
    ? structure.disposition.join(' ')
    : String(structure.disposition ?? '');
  if (/attachment/i.test(disposition)) return true;
  if (Array.isArray(structure.childNodes)) return structure.childNodes.some(hasAttachments);
  return false;
}

export async function listMailboxes(account) {
  return withImap(account, async (client) => {
    // `statusQuery` is an option object, not an array of IMAP status names; the
    // counts arrive on each entry's `status`, never on the entry itself.
    const boxes = await client.list({ statusQuery: { messages: true, unseen: true } });
    return boxes.map((b) => ({
      path: b.path,
      name: b.name,
      delimiter: b.delimiter ?? null,
      specialUse: b.specialUse ?? null,
      subscribed: b.subscribed ?? null,
      messages: typeof b.status?.messages === 'number' ? b.status.messages : null,
      unseen: typeof b.status?.unseen === 'number' ? b.status.unseen : null,
    }));
  });
}

/**
 * List messages in a folder, newest first.
 * @param {object} account
 * @param {{folder?: string, limit?: number, unreadOnly?: boolean, since?: string, before?: string, from?: string, subject?: string, text?: string, markSeen?: boolean}} options
 */
export async function listMessages(account, options = {}) {
  const folder = options.folder ?? 'INBOX';
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 200);

  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const exists = client.mailbox?.exists ?? 0;
      if (exists === 0) return { folder, total: 0, messages: [] };

      const criteria = {};
      if (options.unreadOnly) criteria.seen = false;
      if (options.since) criteria.since = new Date(options.since);
      if (options.before) criteria.before = new Date(options.before);
      if (options.from) criteria.from = options.from;
      if (options.to) criteria.to = options.to;
      if (options.subject) criteria.subject = options.subject;
      // IMAP TEXT searches headers + body; BODY searches the body only.
      if (options.text) criteria.text = options.text;
      if (options.body) criteria.body = options.body;
      if (options.larger) criteria.larger = Number(options.larger);

      let uids = null;
      if (Object.keys(criteria).length > 0) {
        const found = await client.search(criteria, { uid: true });
        // imapflow types this as `number[] | false | undefined`; an empty or
        // missing result means "no match", not a crash.
        if (!Array.isArray(found) || found.length === 0) {
          return { folder, total: exists, matched: 0, messages: [] };
        }
        uids = found;
      }

      const wanted = uids !== null ? uids.slice(-limit) : null;
      let range;
      if (wanted !== null) range = wanted.join(',');
      else range = `${Math.max(1, exists - limit + 1)}:*`;

      const out = [];
      let index = 0;
      for await (const msg of client.fetch(
        range,
        { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
        { uid: wanted !== null },
      )) {
        index += 1;
        out.push(summarize(msg, index));
      }
      // fetch() yields ascending; callers almost always want newest first.
      out.reverse();
      return { folder, total: exists, matched: wanted !== null ? wanted.length : exists, messages: out };
    } finally {
      lock.release();
    }
  });
}

/**
 * Read one message by UID, including a decoded text body and attachment metadata.
 * @param {object} account
 * @param {{uid: number, folder?: string, includeHtml?: boolean, maxBodyChars?: number, saveAttachmentsTo?: string, markSeen?: boolean}} options
 */
export async function readMessage(account, options) {
  const folder = options.folder ?? 'INBOX';
  const uid = Number(options.uid);
  if (!Number.isFinite(uid)) throw new Error('readMessage 需要数字 uid。');
  const maxBodyChars = Number(options.maxBodyChars) || 20000;

  const raw = await withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true, envelope: true }, { uid: true });
      if (!msg) throw new Error(`在 ${folder} 里找不到 uid=${uid} 的邮件（可能已被移动或删除）。`);
      if (options.markSeen !== false) {
        try {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        } catch {
          /* non-fatal */
        }
      }
      return msg;
    } finally {
      lock.release();
    }
  });

  const { simpleParser } = await need('mailparser');
  const parsed = await simpleParser(raw.source);
  const text = String(parsed.text ?? '').trim();
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const body = text !== '' ? text : stripHtml(html);

  const attachments = (parsed.attachments ?? []).map((a, i) => ({
    index: i,
    filename: a.filename ?? `attachment-${i + 1}`,
    contentType: a.contentType ?? 'application/octet-stream',
    size: a.size ?? (a.content?.length ?? 0),
    contentId: a.contentId ?? null,
  }));

  const message = {
    uid,
    folder,
    subject: parsed.subject ?? '(无主题)',
    from: normalizeAddressObject(parsed.from),
    to: normalizeAddressObject(parsed.to),
    cc: normalizeAddressObject(parsed.cc),
    replyTo: normalizeAddressObject(parsed.replyTo),
    date: parsed.date ? new Date(parsed.date).toISOString() : null,
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references: parsed.references ? [].concat(parsed.references) : [],
    body: body.length > maxBodyChars ? `${body.slice(0, maxBodyChars)}\n…（正文已截断，共 ${body.length} 字）` : body,
    bodyTruncated: body.length > maxBodyChars,
    html: options.includeHtml ? html : undefined,
    attachments,
    attachmentCount: attachments.length,
  };
  // The parsed mailparser object (which holds every attachment buffer) is kept
  // for this process only and deliberately made non-enumerable, so no
  // formatting or serialization path can accidentally dump megabytes into the
  // conversation or into a tool result.
  Object.defineProperty(message, '_parsed', { value: parsed, enumerable: false });
  return message;
}

function normalizeAddressObject(obj) {
  if (!obj) return [];
  // mailparser hands back an address object (`{ value: [{name, address}], text }`)
  // for from/to/cc/replyTo, and a message carrying several such headers can arrive
  // as an array of those objects. Our own summaries pass plain `{name, address}`
  // arrays instead. Accept all of those shapes — mapping a `{value, text}` object
  // straight through yields `[{name: null, address: null}]` and silently loses the
  // recipients (which also breaks reply-all, since it reads message.to/cc).
  const out = [];
  for (const entry of [].concat(obj)) {
    if (!entry) continue;
    if (Array.isArray(entry)) out.push(...entry);
    else if (Array.isArray(entry.value)) out.push(...entry.value);
    else if (entry.value && typeof entry.value === 'object') out.push(entry.value);
    else out.push(entry);
  }
  return addressList(out);
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Save the attachments of an already-read message into a directory. */
export async function saveAttachments(message, directory, only) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join, resolve, sep } = await import('node:path');
  const dir = resolve(directory);
  await mkdir(dir, { recursive: true });

  const all = message._parsed?.attachments ?? [];
  const picked = only === undefined || only === null ? all : [].concat(only).map(Number).filter(Number.isFinite).map((i) => all[i]).filter(Boolean);

  const saved = [];
  for (const [i, a] of picked.entries()) {
    const name = sanitizeFilename(a.filename ?? `attachment-${i + 1}`);
    const target = join(dir, name);
    // Defense in depth: the name is already the result of sanitizeFilename, but
    // an attachment must never be able to write outside the chosen directory.
    if (!resolve(target).startsWith(resolve(dir) + sep)) {
      throw new Error(`附件文件名不安全，已拒绝写入：${a.filename ?? name}`);
    }
    await writeFile(target, a.content);
    saved.push({ file: target, name, size: a.content?.length ?? 0, contentType: a.contentType ?? null });
  }
  return { directory: dir, saved, skipped: all.length - picked.length };
}

/**
 * Keep a filename usable on Windows and inside the workspace.
 *
 * Order matters: take the basename FIRST (so `../../etc/passwd` cannot survive
 * as a name), then strip characters Windows rejects, then leading/trailing dots
 * (`.`/`..`/trailing dots are all dangerous or invalid), then bound the length.
 */
export function sanitizeFilename(name) {
  const base = String(name)
    .split(/[\\/]/)
    .filter((segment) => segment !== '')
    .pop() ?? '';
  const cleaned = base
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .slice(0, 180);
  return cleaned === '' ? 'attachment' : cleaned;
}

/** IMAP search returning full message summaries. */
export async function searchMessages(account, options = {}) {
  return listMessages(account, { ...options, limit: options.limit ?? 25 });
}

/** Mark read/unread, flag/unflag, or move/delete messages. */
export async function updateMessages(account, action, options = {}) {
  const folder = options.folder ?? 'INBOX';
  const uids = [].concat(options.uid ?? options.uids ?? []).map(String).filter(Boolean);
  if (uids.length === 0) throw new Error('需要提供 uid（或 uids 数组）。');

  return withImap(account, async (client) => {
    if (action === 'move' || action === 'delete') {
      const destination =
        action === 'delete'
          ? await resolveFolder(client, 'trash', account.trashFolder)
          : options.to;
      if (!destination) throw new Error('move 需要 to 参数（目标文件夹）。');
      // MOVE 作用于「当前选中的邮箱」。不先打开邮箱，imapflow 的 resolveRange()
      // 会返回 falsy，messageMove() 就直接 return false —— 一条命令都不发，调用方
      // 却以为移动成功了。所以这里必须取锁，并且把 false 当成失败。
      const lock = await client.getMailboxLock(folder);
      try {
        const result = await client.messageMove(uids, destination, { uid: true });
        if (!result) {
          throw new Error(
            `没有移动任何邮件：${folder} 里找不到 uid=${uids.join(',')}（可能已被移动或删除）。`,
          );
        }
        return { moved: uids.length, to: destination };
      } finally {
        lock.release();
      }
    }

    const lock = await client.getMailboxLock(folder);
    try {
      if (action === 'markRead' || action === 'markSeen') await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      else if (action === 'markUnread') await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      else if (action === 'flag') await client.messageFlagsAdd(uids, ['\\Flagged'], { uid: true });
      else if (action === 'unflag') await client.messageFlagsRemove(uids, ['\\Flagged'], { uid: true });
      else throw new Error(`不认识的 action：${action}`);
      return { updated: uids.length, action, folder };
    } finally {
      lock.release();
    }
  });
}

/**
 * Send a message. Attachments are read from local absolute paths.
 * @param {object} account
 * @param {{to: string|string[], cc?: string|string[], bcc?: string|string[], subject: string, text?: string, html?: string, attachments?: string[], replyTo?: string, inReplyTo?: string, references?: string[], senderName?: string, appendToSent?: boolean}} mail
 * @param {{transport?: object}} [options] `transport` injects a pre-built nodemailer
 *   transport instead of dialing SMTP — used by tests, and by an embedder that
 *   wants to route mail through its own transport.
 */
export async function sendMessage(account, mail, options = {}) {
  const nodemailer = await need('nodemailer');
  const { readFile, stat } = await import('node:fs/promises');
  const { basename } = await import('node:path');

  const to = normalizeRecipients(mail.to);
  if (to.length === 0) throw new Error('至少需要一个收件人（to）。');

  // nodemailer rewrites the attachment objects it is handed (jsonTransport, for
// one, replaces `content` with a base64 string), so the byte size is captured
// here and the objects passed to sendMail are throwaway wrappers. Reading
// `content.length` back after sendMail would report the encoded length instead.
  const prepared = [];
  for (const file of [].concat(mail.attachments ?? []).filter(Boolean)) {
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) throw new Error(`附件不存在或不是文件：${file}`);
    const content = await readFile(file);
    prepared.push({ filename: basename(file), content, size: content.length });
  }
  const attachments = prepared.map(({ filename, content }) => ({ filename, content }));

  const transport =
    options.transport ??
    nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      requireTLS: account.smtp.requireTLS ?? !account.smtp.secure,
      auth: { user: account.userName || account.address, pass: account._secret },
      connectionTimeout: account.timeoutMs ?? 30000,
      greetingTimeout: account.timeoutMs ?? 30000,
      socketTimeout: (account.timeoutMs ?? 30000) * 4,
      tls: { servername: account.smtp.host },
    });

  const senderName = mail.senderName ?? account.senderName;
  const from = senderName ? { name: senderName, address: account.address } : account.address;
  const text = mail.text ?? (mail.html ? stripHtml(mail.html) : '');
  const body = account.signature && !String(text).includes(account.signature) ? `${text}\n\n${account.signature}` : text;

  let info;
  const shouldAppend = mail.appendToSent ?? account.appendToSent;
  const messageOptions = {
    from,
    to,
    cc: normalizeRecipients(mail.cc),
    bcc: normalizeRecipients(mail.bcc),
    subject: mail.subject ?? '(无主题)',
    text: body,
    html: mail.html ?? undefined,
    attachments,
    replyTo: mail.replyTo ?? account.replyTo ?? undefined,
    inReplyTo: mail.inReplyTo ?? undefined,
    references: mail.references ? [].concat(mail.references) : undefined,
  };
  let rawMessage = null;
  try {
    if (shouldAppend) {
      // nodemailer 的 SMTP transport **不返回** info.message（只有 stream/json 那种
      // transport 才给），所以想在「已发送」里留副本，只能在发送前自己编译一次；
      // 然后用 raw 发送，保证磁盘上的副本与真正发出去的字节完全一致。
      // build() 直接 resolve 原始报文（Buffer），信封要自己拼：to + cc + bcc，
      // 其中 bcc 只进信封、不进信头。
      const { default: MailComposer } = await need('nodemailer/lib/mail-composer');
      const built = await new MailComposer(messageOptions).compile().build();
      rawMessage = Buffer.isBuffer(built) ? built : built.message;
      const envelope = {
        from: account.address,
        to: [...to, ...normalizeRecipients(mail.cc), ...normalizeRecipients(mail.bcc)],
      };
      info = await transport.sendMail({ envelope, raw: rawMessage });
    } else {
      info = await transport.sendMail(messageOptions);
    }
  } catch (error) {
    throw decorate(error, account, 'SMTP 发信');
  }

  let appendedTo = null;
  if (shouldAppend && rawMessage) {
    try {
      const folder = await withImap(account, async (client) => {
        const path = await resolveFolder(client, 'sent', account.sentFolder);
        await client.append(path, rawMessage, ['\\Seen']);
        return path;
      });
      appendedTo = folder;
    } catch {
      // 追加失败不该让已经发出去的信看起来像失败了
      appendedTo = null;
    }
  }

  return {
    accepted: info.accepted ?? [],
    rejected: info.rejected ?? [],
    messageId: info.messageId ?? null,
    response: info.response ?? null,
    envelope: info.envelope ?? null,
    attachmentCount: prepared.length,
    attachments: prepared.map((a) => ({ filename: a.filename, size: a.size })),
    appendedTo,
  };
}

function normalizeRecipients(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;\s]+/);
  return list.map((v) => String(v).trim()).filter((v) => v !== '');
}

/**
 * Build the reply addressing/reference headers from a read message.
 * @param {object} message a message returned by `readMessage`
 * @param {'reply'|'replyAll'} [mode]
 * @param {string[]} [ownAddresses] the replying account's own addresses, so a
 *   reply-all never copies the user back to themselves.
 */
export function replyTargets(message, mode = 'reply', ownAddresses = []) {
  const from = message.from?.[0]?.address ?? null;
  const subject = message.subject ?? '';
  const prefix = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  // `message.messageId` is appended last so References accumulates the thread.
  const references = [...(message.references ?? []), message.messageId].filter(Boolean);
  if (mode !== 'replyAll') {
    return { to: from, cc: [], subject: prefix, inReplyTo: message.messageId, references };
  }
  const fromLower = from?.toLowerCase();
  const own = new Set(
    ownAddresses.map((a) => String(a ?? '').trim().toLowerCase()).filter((a) => a !== ''),
  );
  const others = [...(message.to ?? []), ...(message.cc ?? [])]
    .map((a) => a.address)
    .filter((a) => a && a.toLowerCase() !== fromLower && !own.has(a.toLowerCase()));
  return { to: from, cc: [...new Set(others)], subject: prefix, inReplyTo: message.messageId, references };
}
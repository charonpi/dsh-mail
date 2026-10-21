/**
 * 进程内最小 SMTP 服务器，用于离线验证发信链路。
 *
 * 只实现 nodemailer 实际会用到的那部分：EHLO（广告 AUTH PLAIN/LOGIN、SIZE、8BITMIME，
 * 但**刻意不广告 STARTTLS**，于是要求测试账号设 `requireTLS: false`）、AUTH PLAIN/LOGIN、
 * MAIL FROM、RCPT TO、DATA（含 dot-unstuffing）、RSET、QUIT。
 *
 * 收到的每封报文连同信封与认证信息一起留下，测试可以断言「服务器究竟收到了什么」。
 */
import net from 'node:net';

export function createSmtpServer() {
  const messages = [];
  const commands = [];
  let auth = null;
  let sawAuth = null;

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    let envelope = { from: null, rcpt: [] };
    let authState = null; // 'user' | 'pass' | 'plain-inline'
    const pendingAuth = { user: null, pass: null };

    const say = (line) => socket.write(`${line}\r\n`);

    say('220 fake.local ESMTP dsh-mail test');

    function handle(line) {
      commands.push(line.split(' ')[0].toUpperCase());
      const upper = line.toUpperCase();

      if (authState === 'user') {
        pendingAuth.user = Buffer.from(line, 'base64').toString('utf8');
        authState = 'pass';
        say('334 UGFzc3dvcmQ6');
        return;
      }
      if (authState === 'pass') {
        pendingAuth.pass = Buffer.from(line, 'base64').toString('utf8');
        authState = null;
        auth = { ...pendingAuth };
        sawAuth = 'LOGIN';
        say('235 2.7.0 Authentication successful');
        return;
      }

      if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
        say('250-fake.local');
        say('250-AUTH PLAIN LOGIN');
        say('250-SIZE 10485760');
        say('250-8BITMIME');
        say('250 HELP');
        return;
      }
      if (upper.startsWith('AUTH PLAIN')) {
        const inline = line.split(/\s+/)[2];
        if (inline) {
          auth = { plain: Buffer.from(inline, 'base64').toString('utf8') };
          sawAuth = 'PLAIN';
          say('235 2.7.0 Authentication successful');
        } else {
          say('334 ');
          authState = 'plain-inline';
        }
        return;
      }
      if (upper.startsWith('AUTH LOGIN')) {
        authState = 'user';
        say('334 VXNlcm5hbWU6');
        return;
      }
      if (upper.startsWith('MAIL FROM')) {
        envelope.from = (line.match(/<([^>]*)>/) ?? [, ''])[1];
        say('250 2.1.0 Ok');
        return;
      }
      if (upper.startsWith('RCPT TO')) {
        envelope.rcpt.push((line.match(/<([^>]*)>/) ?? [, ''])[1]);
        say('250 2.1.5 Ok');
        return;
      }
      if (upper === 'DATA') {
        inData = true;
        data = '';
        say('354 End data with <CR><LF>.<CR><LF>');
        return;
      }
      if (upper === 'QUIT') {
        say('221 2.0.0 Bye');
        socket.end();
        return;
      }
      if (upper === 'RSET') {
        envelope = { from: null, rcpt: [] };
        say('250 2.0.0 Ok');
        return;
      }
      say('250 2.0.0 Ok');
    }

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push({ envelope: { ...envelope, rcpt: [...envelope.rcpt] }, raw: data, auth });
            envelope = { from: null, rcpt: [] };
            say('250 2.0.0 Ok: queued as TEST1');
          } else {
            // 去掉 dot-stuffing
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        if (authState === 'plain-inline') {
          auth = { plain: Buffer.from(line, 'base64').toString('utf8') };
          sawAuth = 'PLAIN';
          authState = null;
          say('235 2.7.0 Authentication successful');
          continue;
        }

        handle(line);
      }
    });

    socket.on('error', () => {});
  });

  return {
    server,
    messages,
    commands,
    get authMode() {
      return sawAuth;
    },
    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
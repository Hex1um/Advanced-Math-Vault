#!/usr/bin/env node
/**
 * 邮件通道自测：用一个本地假 SMTP 服务器验证真实发信链路
 *
 *   node tools/verify/mail-test.mjs
 *
 * 不联网、不需要任何真实凭据：起一个 net 服务器说 SMTP，检查握手、AUTH、
 * DATA 里的正文与 dot-stuffing、以及日志模式的降级行为。
 */
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const { createMailer, encodeHeader, dotStuff, buildMessage } = require(path.join(ROOT, 'lib', 'mail.js'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n[1] 头部编码与 dot-stuffing');
ok('ASCII 头部原样输出', encodeHeader('Hello World') === 'Hello World');
ok('中文头部 RFC2047 编码', /^=\?UTF-8\?B\?/.test(encodeHeader('数海晴岸')));
ok('正文以点开头的行被转义', dotStuff('..x\n.y').indexOf('...x') === 0, JSON.stringify(dotStuff('..x\n.y')));

console.log('\n[2] SMTP 发送链路（本地假服务器）');
const received = [];
const server = net.createServer((sock) => {
  sock.write('220 mock.local ESMTP\r\n');
  let buf = '';
  let inData = false;
  let data = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          received.push(data);
          data = '';
          sock.write('250 OK queued\r\n');
        } else data += line + '\n';
        continue;
      }
      if (/^EHLO/i.test(line)) sock.write('250-mock.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1048576\r\n');
      else if (/^AUTH PLAIN/i.test(line)) sock.write('235 2.7.0 Authentication successful\r\n');
      else if (/^MAIL FROM/i.test(line)) sock.write('250 2.1.0 Ok\r\n');
      else if (/^RCPT TO/i.test(line)) sock.write('250 2.1.5 Ok\r\n');
      else if (/^DATA/i.test(line)) { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.write('221 Bye\r\n'); sock.end(); }
      else sock.write('250 Ok\r\n');
    }
  });
  sock.on('error', () => {});
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

try {
  const mailer = createMailer({
    provider: 'smtp', host: '127.0.0.1', port,
    user: 'robot@example.com', pass: 'secret',
    from: '数海晴岸 <no-reply@example.com>'
  });
  const desc = mailer.describe();
  ok('smtp 通道被识别为可投递', desc.provider === 'smtp' && desc.mode === 'deliver');

  const r = await mailer.send({ to: 'user@example.com', subject: '邮箱验证码', text: '验证码：123456' });
  ok('发送返回成功', r.delivered === true, JSON.stringify(r));
  ok('服务器收到一封信', received.length === 1);
  const mail = received[0] || '';
  ok('正文含验证码', mail.includes('123456'), mail.slice(0, 80));
  ok('头部含 To 与 Message-ID', /To: user@example\.com/.test(mail) && /Message-ID: <[^>]+@example\.com>/.test(mail), mail.slice(0, 120));
  const raw = buildMessage({ from: '数海晴岸 <no-reply@example.com>', to: 'user@example.com', subject: '主题', text: '第一行\n.第二行' });
  ok('报文按 CRLF 分行（RFC 5321）', raw.indexOf('\r\n') >= 0 && raw.indexOf('\n\n') < 0);
  ok('正文里的点开头的行被 dot-stuffing', raw.includes('\r\n..第二行'));
  ok('中文主题按 RFC2047 编码', /Subject: =\?UTF-8\?B\?/.test(raw));

  const bad = await mailer.send({ to: 'not-an-email', subject: 'x', text: 'y' });
  ok('非法收件地址被提前拒绝', bad.delivered === false && /不合法/.test(bad.error || ''));
} finally {
  server.close();
}

console.log('\n[3] 日志降级');
const logMailer = createMailer({ provider: 'log' });
const lr = await logMailer.send({ to: 'user@example.com', subject: '邮箱验证码', text: '验证码：654321' });
ok('未配置通道时降级为日志且不投递', lr.delivered === false && lr.mode === 'log');
ok('日志模式不返回验证码内容给调用方', !/654321/.test(JSON.stringify(lr)));

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);

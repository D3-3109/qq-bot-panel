// 单元测试：用标准文档里的测试向量校验加密/验证码等实现
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qqpanel-unit-'));

const { hotp, base32Encode, base32Decode, verifyTotp } = await import('../server/totp.js');
const { encryptPayload } = await import('../server/webpush.js');
const { ed25519KeysFromSecret, ed25519Sign } = await import('../server/crypto.js');
const { computeNext, matchRule } = await import('../server/automation.js');
const { encode } = await import('../public/qr.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

test('TOTP 与 RFC 6238 测试向量一致', () => {
  const key = Buffer.from('12345678901234567890');
  for (const [t, exp] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) {
    assert.equal(hotp(key, Math.floor(t / 30), 8), exp);
  }
  assert.deepEqual(['755224', '287082', '359152'].map((_, i) => hotp(key, i)), ['755224', '287082', '359152']);
  assert.ok(base32Decode(base32Encode(key)).equals(key));
});

test('TOTP 验证允许 ±1 个时间步并拒绝重放', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const now = 1111111111 * 1000;
  const step = Math.floor(1111111111 / 30);
  const code = hotp(base32Decode(secret), step);
  assert.equal(verifyTotp(secret, code, { now }), step);
  assert.equal(verifyTotp(secret, code, { now: now + 30_000 }), step);
  assert.equal(verifyTotp(secret, code, { now, lastStep: step }), null);
  assert.equal(verifyTotp(secret, '000000', { now }), null);
});

test('Web Push 加密与 RFC 8291 附录 A 一致', () => {
  const strip = (s) => s.replace(/\s+/g, '');
  const out = encryptPayload(
    Buffer.from('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24', 'base64url'),
    strip('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    'BTBZMqHH6r4Tts7J_aSIgg',
    { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' },
  );
  // RFC 分别给出 86 字节的头部和密文，各自是独立的 base64url，需要先解码再拼接
  const header = Buffer.from(strip('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8'), 'base64url');
  const cipher = Buffer.from(strip('8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs bI_0LpXMuGvnzQ'), 'base64url');
  assert.equal(header.length, 86);
  assert.ok(out.equals(Buffer.concat([header, cipher])));
});

test('Webhook Ed25519 签名与 QQ 文档示例一致', () => {
  const sig = ed25519Sign(ed25519KeysFromSecret('DG5g3B4j9X2KOErG').privateKey, '1725442341Arq0D5A61EgUu4OxUvOp');
  assert.ok(sig.startsWith('87befc99c42c'));
});

test('定时消息：每天 / 每周的下一次时间', () => {
  const from = new Date(2026, 10, 1, 9, 0).getTime(); // 周日 09:00
  assert.equal(computeNext({ kind: 'daily', time_of_day: '08:30' }, from), new Date(2026, 10, 2, 8, 30).getTime());
  assert.equal(computeNext({ kind: 'daily', time_of_day: '10:00' }, from), new Date(2026, 10, 1, 10, 0).getTime());
  const fri = 1 << 5;
  assert.equal(computeNext({ kind: 'weekly', time_of_day: '08:00', weekdays: fri }, from), new Date(2026, 10, 6, 8, 0).getTime());
  assert.equal(computeNext({ kind: 'once', run_at: from - 1 }, from), 0);
});

test('自动回复匹配方式', () => {
  assert.ok(matchRule({ match_type: 'contains', pattern: '天气|下雨' }, '今天会下雨吗'));
  assert.ok(!matchRule({ match_type: 'contains', pattern: '天气' }, '你好'));
  assert.ok(matchRule({ match_type: 'exact', pattern: 'ping' }, ' PING '));
  assert.ok(matchRule({ match_type: 'prefix', pattern: '/签到' }, '/签到 今天'));
  assert.ok(matchRule({ match_type: 'regex', pattern: '^\\d{3}$' }, '123'));
  assert.ok(!matchRule({ match_type: 'regex', pattern: '([' }, '123'));
});

test('二维码：版本与容量', () => {
  assert.equal(encode('hello').version, 1);
  const uri = 'otpauth://totp/QQ%20Bot%20%E9%9D%A2%E6%9D%BF%3Aadmin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=QQ%20Bot%20%E9%9D%A2%E6%9D%BF&algorithm=SHA1&digits=6&period=30';
  const q = encode(uri);
  assert.equal(q.size, q.version * 4 + 17);
  assert.throws(() => encode('x'.repeat(600)));
});

console.log(`\n单元测试全部通过：${passed} 项`);
// Windows 下数据库文件仍被占用时删除会失败，关闭后再清理，失败也不影响结果
try {
  (await import('../server/db.js')).db.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
} catch {}
process.exit(0);

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { sealCredentials, openCredentials } from '../credential-envelope.mjs';

const repository = 'haoqu009-sketch/wechat-public-account-push';
const now = new Date('2026-10-19T01:00:00.000Z');
const runId = '39210482044';
const config = {
  appId: 'wxFAKE_APP_123', appSecret: 'FAKE_SECRET_FOR_LOCAL_TEST_ONLY',
  users: [{ openId: 'FAKE_OPENID_ONE', templateId: 'FAKE_TEMPLATE_ID' }, { openId: 'FAKE_OPENID_TWO', templateId: 'FAKE_TEMPLATE_ID' }],
};
const encoding = { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } };
const keys = generateKeyPairSync('rsa', { modulusLength: 4096, ...encoding });
const fingerprint = createHash('sha256').update(createPublicKey(keys.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
const sealing = overrides => ({ now, repository, runId, fingerprint, ...overrides });
const opening = overrides => ({ now, repository, expectedRunId: runId, ...overrides });
const seal = (value = config, options = {}) => sealCredentials(value, keys.publicKey, sealing(options));
const open = (value, options = {}) => openCredentials(value, keys.privateKey, opening(options));
const safeError = operation => assert.throws(operation, error => {
  assert.match(error.message, /凭据.*失败/);
  assert.doesNotMatch(error.message, /FAKE_|PRIVATE KEY|PUBLIC KEY|access_token|oaep|decrypt|rsa|-----BEGIN/i);
  assert.equal(error.cause, undefined);
  return true;
});

test('4096位RSA-OAEP和AES-GCM本地往返，只输出最小认证配置与运行元数据', () => {
  const envelope = seal();
  assert.deepEqual(Object.keys(envelope), ['version', 'algorithm', 'keyFingerprint', 'wrappedKey', 'iv', 'ciphertext', 'tag']);
  assert.equal(envelope.algorithm, 'RSA-OAEP-SHA256+A256GCM');
  assert.equal(envelope.keyFingerprint, fingerprint);
  assert.equal(Buffer.from(envelope.wrappedKey, 'base64').length, 512);
  assert.equal(Buffer.from(envelope.iv, 'base64').length, 12);
  assert.equal(Buffer.from(envelope.tag, 'base64').length, 16);
  assert.doesNotMatch(JSON.stringify(envelope), /FAKE_SECRET|FAKE_OPENID|FAKE_TEMPLATE|wxFAKE/);
  assert.deepEqual(open(envelope), {
    version: 1, repository, runId, createdAt: now.toISOString(), expiresAt: '2026-10-19T01:30:00.000Z', config,
  });
  assert.notDeepEqual(seal(), envelope, '每次加密必须使用新随机密钥与IV');
});

test('支持PKCS1公私钥输入，指纹始终使用相同SPKI DER', () => {
  const publicPem = createPublicKey(keys.publicKey).export({ type: 'pkcs1', format: 'pem' });
  const privatePem = createPrivateKey(keys.privateKey).export({ type: 'pkcs1', format: 'pem' });
  const envelope = sealCredentials(config, publicPem, sealing());
  assert.equal(envelope.keyFingerprint, fingerprint);
  assert.deepEqual(openCredentials(envelope, privatePem, opening()).config, config);
});

test('配置额外字段、非法用户字段、空值、非ASCII或超长字段全部拒绝且不回显', () => {
  const invalid = [
    { ...config, token: 'FAKE_PRIVATE_VALUE' },
    { ...config, users: [{ ...config.users[0], secret: 'FAKE_PRIVATE_VALUE' }] },
    { ...config, appId: '' }, { ...config, appId: 'x'.repeat(65) },
    { ...config, appSecret: 'x'.repeat(257) }, { ...config, appSecret: '包含中文' },
    { ...config, appId: 'SPACE NOT_ALLOWED' },
    { ...config, users: [] }, { ...config, users: Array.from({ length: 21 }, (_, i) => ({ openId: `user_${i}`, templateId: 'template' })) },
    { ...config, users: [{ openId: 'x'.repeat(129), templateId: 'template' }] },
    { ...config, users: [{ openId: 'user', templateId: 'x'.repeat(257) }] },
    { ...config, users: [{ openId: 'user', templateId: 'template\n' }] },
    { ...config, users: [config.users[0], config.users[0]] },
  ];
  for (const value of invalid) safeError(() => seal(value));
});

test('配置字段上限与20个用户可以安全往返，输入对象不被修改', () => {
  const value = {
    appId: 'a'.repeat(64), appSecret: 'b'.repeat(256),
    users: Array.from({ length: 20 }, (_, index) => ({ openId: `user_${index}`.padEnd(128, 'x'), templateId: 't'.repeat(256) })),
  };
  const before = JSON.stringify(value);
  assert.deepEqual(open(seal(value)).config, value);
  assert.equal(JSON.stringify(value), before);
});

test('公钥指纹必填且必须匹配，仓库与运行编号限定明确目的地', () => {
  for (const options of [{ fingerprint: undefined }, { fingerprint: '0'.repeat(64) }, { fingerprint: fingerprint.toUpperCase() }, { repository: 'other/repo' }, { runId: 'not-number' }, { runId: 123 }, { runId: '0' }]) {
    safeError(() => seal(config, options));
  }
  const envelope = seal();
  for (const options of [{ repository: 'other/repo' }, { expectedRunId: '39210482045' }, { expectedRunId: undefined }]) safeError(() => open(envelope, options));
});

test('严格30分钟期限，拒绝未来创建、过期与无效时间', () => {
  const envelope = seal();
  assert.deepEqual(open(envelope, { now: '2026-10-19T01:29:59.999Z' }).config, config);
  for (const value of ['2026-10-19T01:30:00.000Z', '2026-10-20T01:00:00.000Z', '2026-10-19T00:59:59.999Z', 'invalid']) safeError(() => open(envelope, { now: value }));
  safeError(() => seal(config, { now: 'invalid' }));
});

test('篡改密钥包、IV、密文、认证标签或元数据都被拒绝', () => {
  const envelope = seal();
  for (const field of ['wrappedKey', 'iv', 'ciphertext', 'tag']) {
    const bytes = Buffer.from(envelope[field], 'base64');
    bytes[0] ^= 1;
    safeError(() => open({ ...envelope, [field]: bytes.toString('base64') }));
  }
  for (const change of [{ version: 2 }, { algorithm: 'RSA-PKCS1' }, { keyFingerprint: '0'.repeat(64) }, { unexpected: 'FAKE_PRIVATE_VALUE' }, { ciphertext: envelope.ciphertext + '\n' }, { iv: Buffer.alloc(11).toString('base64') }, { tag: Buffer.alloc(15).toString('base64') }]) safeError(() => open({ ...envelope, ...change }));
});

test('拒绝超出2MB包体、非规范base64、无效PEM及不足4096位RSA', () => {
  const weak = generateKeyPairSync('rsa', { modulusLength: 2048, ...encoding });
  const weakFingerprint = createHash('sha256').update(createPublicKey(weak.publicKey).export({ type: 'spki', format: 'der' })).digest('hex');
  safeError(() => sealCredentials(config, weak.publicKey, sealing({ fingerprint: weakFingerprint })));
  safeError(() => openCredentials(seal(), weak.privateKey, opening()));
  safeError(() => sealCredentials(config, 'INVALID_FAKE_PUBLIC_KEY', sealing()));
  safeError(() => openCredentials(seal(), 'INVALID_FAKE_PRIVATE_KEY', opening()));
  safeError(() => sealCredentials(config, keys.privateKey, sealing()));
  const envelope = seal();
  safeError(() => open({ ...envelope, ciphertext: 'A'.repeat(2 * 1024 * 1024) }));
  safeError(() => open({ ...envelope, ciphertext: '%%%%' }));
  safeError(() => open({ ...envelope, ciphertext: 'AB==' }));
});

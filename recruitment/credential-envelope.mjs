import {
  constants, createCipheriv, createDecipheriv, createHash, createPrivateKey,
  createPublicKey, privateDecrypt, publicEncrypt, randomBytes,
} from 'node:crypto';

const repositoryName = 'haoqu009-sketch/wechat-public-account-push';
const algorithm = 'RSA-OAEP-SHA256+A256GCM';
const lifetime = 30 * 60 * 1000;
const maximumBytes = 2 * 1024 * 1024;
const sealError = '凭据加密失败，请核对配置、仓库、运行编号及公钥指纹';
const openError = '凭据解密或校验失败，请重新导出并核对仓库、运行编号及有效期';
const fail = () => { throw new Error('Invalid credential envelope'); };

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) fail();
}

function credential(value, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) fail();
  return value;
}

function normalizeConfig(config) {
  exactKeys(config, ['appId', 'appSecret', 'users']);
  if (!Array.isArray(config.users) || config.users.length < 1 || config.users.length > 20) fail();
  const seen = new Set();
  return {
    appId: credential(config.appId, 64),
    appSecret: credential(config.appSecret, 256),
    users: config.users.map(user => {
      exactKeys(user, ['openId', 'templateId']);
      const openId = credential(user.openId, 128);
      if (seen.has(openId)) fail();
      seen.add(openId);
      return { openId, templateId: credential(user.templateId, 256) };
    }),
  };
}

function instant(value) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(result)) fail();
  return result;
}

function runNumber(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,31}$/.test(value)) fail();
  return value;
}

function repository(value) {
  if (value !== repositoryName) fail();
  return value;
}

function rsaKey(pem, privatePart) {
  if (typeof pem !== 'string' || Buffer.byteLength(pem) > 64 * 1024) fail();
  const header = privatePart ? /^\s*-----BEGIN (?:RSA )?PRIVATE KEY-----/ : /^\s*-----BEGIN (?:RSA )?PUBLIC KEY-----/;
  if (!header.test(pem)) fail();
  const key = privatePart ? createPrivateKey(pem) : createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa' || !Number.isInteger(key.asymmetricKeyDetails?.modulusLength)
    || key.asymmetricKeyDetails.modulusLength < 4096) fail();
  return key;
}

function fingerprintFor(key) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  return createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
}

function aad(repo, fingerprint) {
  return Buffer.from(`${repo}|v1|${fingerprint}`, 'utf8');
}

function base64(value, expectedLength) {
  if (typeof value !== 'string' || !value.length || value.length > maximumBytes
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) fail();
  return decoded;
}

function checkSize(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumBytes) fail();
}

export function sealCredentials(config, publicPem, { now = new Date(), repository: repo, runId, fingerprint } = {}) {
  let key, plaintext;
  try {
    repository(repo);
    runNumber(runId);
    const created = instant(now);
    const rsa = rsaKey(publicPem, false);
    const keyFingerprint = fingerprintFor(rsa);
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || fingerprint !== keyFingerprint) fail();
    const payload = {
      version: 1, repository: repo, runId,
      createdAt: new Date(created).toISOString(), expiresAt: new Date(created + lifetime).toISOString(),
      config: normalizeConfig(config),
    };
    plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
    if (plaintext.length > maximumBytes) fail();
    key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad(repo, keyFingerprint));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: rsa, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
    const envelope = {
      version: 1, algorithm, keyFingerprint,
      wrappedKey: wrappedKey.toString('base64'), iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    };
    checkSize(envelope);
    return envelope;
  } catch { throw new Error(sealError); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

export function openCredentials(envelope, privatePem, { now = new Date(), repository: repo, expectedRunId } = {}) {
  let key, plaintext;
  try {
    repository(repo);
    runNumber(expectedRunId);
    const current = instant(now);
    exactKeys(envelope, ['version', 'algorithm', 'keyFingerprint', 'wrappedKey', 'iv', 'ciphertext', 'tag']);
    checkSize(envelope);
    if (envelope.version !== 1 || envelope.algorithm !== algorithm || !/^[a-f0-9]{64}$/.test(envelope.keyFingerprint)) fail();
    const rsa = rsaKey(privatePem, true);
    if (fingerprintFor(rsa) !== envelope.keyFingerprint) fail();
    const wrappedKey = base64(envelope.wrappedKey, Math.ceil(rsa.asymmetricKeyDetails.modulusLength / 8));
    const iv = base64(envelope.iv, 12), tag = base64(envelope.tag, 16), ciphertext = base64(envelope.ciphertext);
    key = privateDecrypt({ key: rsa, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, wrappedKey);
    if (key.length !== 32) fail();
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(aad(repo, envelope.keyFingerprint));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > maximumBytes) fail();
    const payload = JSON.parse(plaintext.toString('utf8'));
    exactKeys(payload, ['version', 'repository', 'runId', 'createdAt', 'expiresAt', 'config']);
    if (payload.version !== 1 || payload.repository !== repo || payload.runId !== expectedRunId) fail();
    const created = instant(payload.createdAt), expires = instant(payload.expiresAt);
    if (typeof payload.createdAt !== 'string' || typeof payload.expiresAt !== 'string'
      || new Date(created).toISOString() !== payload.createdAt || new Date(expires).toISOString() !== payload.expiresAt
      || expires - created !== lifetime || created > current || current >= expires) fail();
    return {
      version: 1, repository: repo, runId: payload.runId,
      createdAt: payload.createdAt, expiresAt: payload.expiresAt,
      config: normalizeConfig(payload.config),
    };
  } catch { throw new Error(openError); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const filename = (directory, url) => path.join(directory, hash(url) + '.json');
const formats = ['xls', 'xlsx', 'doc', 'docx', 'pdf', 'png', 'jpg', 'jpeg'];

// Operator-supplied originals remain explicitly identified. A matching hash proves
// local integrity, not that the file is still the current official attachment.
export async function saveAttachmentImport(directory, { url, format, bytes, importedAt = new Date().toISOString() }) {
  const address = new URL(url);
  if (address.protocol !== 'https:' || address.username || address.password || (address.port && address.port !== '443')
    || [...address.searchParams.keys()].some(key => /token|secret|password|credential|signature|api_key/i.test(key))
    || !formats.includes(format) || !bytes?.length || bytes.length > 5_000_000 || !Number.isFinite(Date.parse(importedAt))) throw new Error('补充附件参数无效');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('补充附件目录不能为符号链接');
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, url, format, importedAt, sha256: hash(bytes), body: bytes.toString('base64') }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, filename(directory, url));
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return { imported: true, format, sha256: hash(bytes) };
}

export async function loadAttachmentImport(directory, file, now = Date.now()) {
  if (!directory) return null;
  try {
    const target = filename(directory, file.url), stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 6_800_000) return null;
    const item = JSON.parse(await fs.readFile(target, 'utf8'));
    const age = now - Date.parse(item.importedAt);
    if (item.version !== 1 || item.url !== file.url || item.format !== file.format || !formats.includes(item.format)
      || !Number.isFinite(age) || age < 0 || age > 30 * 86_400_000 || typeof item.body !== 'string' || item.body.length > 6_700_000) return null;
    const bytes = Buffer.from(item.body, 'base64');
    if (!bytes.length || bytes.length > 5_000_000 || hash(bytes) !== item.sha256) return null;
    return { bytes, manual: true };
  } catch { return null; }
}

export async function cachedAttachmentParse(directory, key, parse) {
  if (!directory) return parse();
  const target = path.join(directory, hash(key) + '.json');
  try {
    const stat = await fs.lstat(target);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 2_000_000) {
      const data = JSON.parse(await fs.readFile(target, 'utf8'));
      if (data.key === key && data.result?.complete === true && Array.isArray(data.result.rows)
        && Array.isArray(data.result.clues) && Array.isArray(data.result.issues)) return data.result;
    }
  } catch { /* A missing/damaged parse cache only causes bounded reprocessing. */ }
  const result = await parse();
  if (!result.complete) return result; // Never freeze a missing engine / failed OCR result.
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await fs.lstat(directory)).isSymbolicLink()) return result;
    const data = JSON.stringify({ key, result });
    if (Buffer.byteLength(data) >= 2_000_000) return result;
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, target); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    const entries = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) {
      const file = path.join(directory, entry.name), stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ file, time: stat.mtimeMs, size: stat.size });
    }
    let kept = 0;
    for (const [index, entry] of entries.sort((a, b) => b.time - a.time).entries()) {
      kept += entry.size;
      if (index >= 100 || kept > 50_000_000) await fs.unlink(entry.file);
    }
  } catch { /* Cache is not authoritative job/delivery state. */ }
  return result;
}

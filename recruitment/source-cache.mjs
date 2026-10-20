import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Conditional requests only. A 403/timeout never turns an old cached page into a fresh success.
export function cachedDownload(directory, download, fetcher = fetch) {
  let writes = 0;
  const fileFor = url => path.join(directory, `${createHash('sha256').update(url).digest('hex')}.json`);
  return async (url, hosts) => {
    const validators = new Map();
    const conditional = async (address, options) => {
      let cached;
      try {
        const file = fileFor(address), stat = await fs.lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 7_000_000) {
          const entry = JSON.parse(await fs.readFile(file, 'utf8'));
          if (entry.url === address && typeof entry.body === 'string' && entry.body.length < 6_700_000
            && typeof entry.type === 'string' && (entry.etag || entry.modified)) cached = entry;
        }
      } catch { /* Missing/damaged HTTP cache must not corrupt authoritative job state. */ }
      const headers = { ...options.headers };
      if (cached?.etag) headers['If-None-Match'] = cached.etag;
      if (cached?.modified) headers['If-Modified-Since'] = cached.modified;
      const response = await fetcher(address, { ...options, headers });
      if (response.status === 304 && cached) {
        validators.set(address, cached);
        return new Response(Buffer.from(cached.body, 'base64'), { status: 200, headers: { 'content-type': cached.type } });
      }
      if (response.ok) validators.set(address, { etag: response.headers.get('etag'), modified: response.headers.get('last-modified') });
      return response;
    };
    const result = await download(url, hosts, conditional), metadata = validators.get(result.url);
    if (metadata && (metadata.etag || metadata.modified)) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify({ url: result.url, body: result.bytes.toString('base64'), type: result.type, etag: metadata.etag, modified: metadata.modified }), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, fileFor(result.url));
      } finally { await fs.unlink(temporary).catch(() => {}); }
      if (++writes % 20 === 0) {
        const entries = [];
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) {
          const file = path.join(directory, entry.name), stat = await fs.lstat(file);
          if (stat.isFile() && !stat.isSymbolicLink()) entries.push({ file, time: stat.mtimeMs });
        }
        entries.sort((a, b) => b.time - a.time);
        for (const entry of entries.slice(100)) await fs.unlink(entry.file);
      }
    }
    return result;
  };
}

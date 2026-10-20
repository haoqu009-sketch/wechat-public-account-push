import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 2 * 1024 * 1024;
const ROOT_KEYS = ['schemaVersion', 'reportId', 'reportDate', 'generatedAt', 'summary', 'jobs', 'sources'];
const SUMMARY_KEYS = ['newCount', 'activeCount', 'physicianCount', 'technicianCount', 'reminderCount', 'sourceSuccessCount', 'sourceTotalCount', 'limitations'];
const JOB_KEYS = ['id', 'title', 'organization', 'sourceName', 'province', 'role', 'status', 'priorityLabel', 'focusMatch', 'directionLabel', 'qualityReasons', 'degreeRequirement', 'specialtyRequirement', 'headcount', 'conditionExcerpt', 'announcementTitle', 'announcementText', 'matches', 'requirements', 'structured', 'url', 'published', 'deadline', 'collectedAt', 'sourceHealthy', 'stale', 'isNew', 'isReminder'];
const SOURCE_KEYS = ['id', 'name', 'province', 'url', 'ok', 'articles', 'warnings', 'error'];
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const invalid = () => { throw failure(400, 'INVALID_SCHEMA'); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => {
  if (!plain(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
};
const string = (value, maximum, required = false) => {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) invalid();
};
const boolean = value => { if (typeof value !== 'boolean') invalid(); };
const integer = value => { if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) invalid(); };
const stringList = (value, maximum = 12, itemLength = 240) => {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  value.forEach(item => string(item, itemLength, true));
};
const validDate = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const nullableDate = value => { if (value !== null && !validDate(value)) invalid(); };
const publicUrl = (value, nullable = false) => {
  if (nullable && value === null) return;
  string(value, 4096, true);
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) invalid();
  if ([...url.searchParams.keys()].some(key => /^(?:access_token|token|secret|key|api_key|signature|authorization|password|passwd|credential)$/i.test(key))) invalid();
};

// Matches the public-report.mjs export contract, including each nested public-field allowlist.
// reportId is the trusted publisher's 24-hex identifier. We do not recompute its hash:
// immutable-file equality enforces ID reuse without coupling to JSON object-key order.
export function validatePublicReport(report) {
  // Optional v1 extension: legacy immutable snapshots remain valid without leads.
  exactKeys(report, Object.hasOwn(report || {}, 'leads') ? [...ROOT_KEYS, 'leads'] : ROOT_KEYS);
  string(report.reportId, 24, true);
  if (report.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(report.reportId || '') || !validDate(report.reportDate)) invalid();
  string(report.generatedAt, 24, true);
  const instant = new Date(report.generatedAt);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== report.generatedAt) invalid();
  const chinaDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
  if (chinaDate !== report.reportDate) invalid();
  exactKeys(report.summary, SUMMARY_KEYS);
  for (const key of SUMMARY_KEYS.filter(key => key !== 'limitations')) integer(report.summary[key]);
  stringList(report.summary.limitations, 30, 600);
  if (!Array.isArray(report.jobs) || report.jobs.length > 5000 || !Array.isArray(report.sources) || report.sources.length > 100) invalid();
  if (report.leads !== undefined && (!Array.isArray(report.leads) || report.leads.length > 300)) invalid();
  const ids = new Set();
  for (const job of [...report.jobs, ...(report.leads || [])]) {
    exactKeys(job, Object.hasOwn(job, 'verification') ? [...JOB_KEYS, 'verification'] : JOB_KEYS);
    string(job.id, 100, true);
    if (ids.has(job.id)) invalid();
    ids.add(job.id);
    for (const key of ['title', 'organization']) string(job[key], 160, true);
    string(job.sourceName, 140, true);
    string(job.province, 40);
    const isLead = (report.leads || []).includes(job);
    if (!(isLead ? job.role === 'clue' && job.status === 'review' && !job.isNew && !job.isReminder : ['physician', 'technician'].includes(job.role)) || !['priority', 'review'].includes(job.status)
      || !['ct', 'mixed', 'other', 'unknown'].includes(job.focusMatch)) invalid();
    for (const key of ['priorityLabel', 'directionLabel', 'degreeRequirement', 'specialtyRequirement']) string(job[key], 240);
    string(job.headcount, 80);
    string(job.conditionExcerpt, 800);
    string(job.announcementTitle, 200);
    string(job.announcementText, 1200);
    for (const key of ['qualityReasons', 'matches', 'requirements']) stringList(job[key]);
    for (const key of ['structured', 'sourceHealthy', 'stale', 'isNew', 'isReminder']) boolean(job[key]);
    publicUrl(job.url);
    for (const key of ['published', 'deadline', 'collectedAt']) nullableDate(job[key]);
    if (job.verification !== undefined) {
      const verification = job.verification;
      exactKeys(verification, ['version', 'checkedAt', 'state', 'summary', 'officialUrl', 'issues', 'evidence', 'attempts']);
      if (verification.version !== 1 || !['matched', 'partial', 'blocked', 'mismatch'].includes(verification.state)) invalid();
      string(verification.checkedAt, 24, true);
      if (!Number.isFinite(Date.parse(verification.checkedAt)) || new Date(verification.checkedAt).toISOString() !== verification.checkedAt) invalid();
      string(verification.summary, 600, true); publicUrl(verification.officialUrl, true); stringList(verification.issues);
      if (!Array.isArray(verification.evidence) || verification.evidence.length > 12 || !Array.isArray(verification.attempts) || verification.attempts.length > 8) invalid();
      for (const item of verification.evidence) {
        exactKeys(item, ['field', 'value', 'quote', 'url', 'locator']);
        string(item.field, 40, true); string(item.value, 240, true); string(item.quote, 600, true); string(item.locator, 100, true); publicUrl(item.url);
      }
      for (const item of verification.attempts) {
        exactKeys(item, ['url', 'result', 'reason']); publicUrl(item.url); string(item.reason, 240, true);
        if (!['read', 'blocked', 'no_match', 'mismatch'].includes(item.result)) invalid();
      }
      if (verification.state === 'matched' && (!verification.officialUrl || verification.issues.length || !['cohort', 'degree', 'role', 'specialty', 'application'].every(field => verification.evidence.some(item => item.field === field)))) invalid();
      if (['mismatch', 'blocked'].includes(verification.state) && !isLead) invalid();
    }
  }
  const sourceIds = new Set();
  for (const source of report.sources) {
    exactKeys(source, SOURCE_KEYS);
    string(source.id, 80, true);
    if (sourceIds.has(source.id)) invalid();
    sourceIds.add(source.id);
    string(source.name, 140, true);
    string(source.province, 40);
    publicUrl(source.url, true);
    boolean(source.ok);
    integer(source.articles);
    stringList(source.warnings, 30, 240);
    if (source.error !== null) string(source.error, 240, true);
  }
  const expected = {
    newCount: report.jobs.filter(job => job.isNew).length,
    activeCount: report.jobs.length,
    physicianCount: report.jobs.filter(job => job.role === 'physician').length,
    technicianCount: report.jobs.filter(job => job.role === 'technician').length,
    reminderCount: report.jobs.filter(job => job.isReminder).length,
    sourceSuccessCount: report.sources.filter(source => source.ok).length,
    sourceTotalCount: report.sources.length,
  };
  if (Object.entries(expected).some(([key, value]) => report.summary[key] !== value)) invalid();
  return report;
}

const canonicalJson = value => JSON.stringify(value, function (key, item) {
  if (!plain(item)) return item;
  return Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]));
});

async function storedReport(file) {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('INVALID_STORED_REPORT');
    return validatePublicReport(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw failure(503, 'STORAGE_UNAVAILABLE');
  }
}

async function atomicJson(directory, name, content) {
  const temporary = path.join(directory, `.sync-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: 'wx', mode: 0o644 });
    await fs.rename(temporary, path.join(directory, name));
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw failure(503, 'STORAGE_UNAVAILABLE'); });
  }
}

function configuredDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error('SYNC_DATA_DIRECTORY_REQUIRED');
  const directory = path.resolve(value);
  if (directory === path.parse(directory).root) throw new Error('SYNC_DATA_DIRECTORY_REQUIRED');
  return directory;
}

export function createSyncHandler({ token, dataDir, logger = () => {} } = {}) {
  if (typeof token !== 'string' || Array.from(token).length < 32 || token.length > 512 || /\s|\0/.test(token)) throw new Error('SYNC_TOKEN_REQUIRED');
  const directory = configuredDirectory(dataDir);
  const expectedToken = createHash('sha256').update(token).digest();
  let queue = Promise.resolve();
  const enqueue = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const authorized = request => {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/i.test(authorization)) return false;
    const provided = authorization.slice(7);
    if (provided.length > 512) return false;
    return timingSafeEqual(expectedToken, createHash('sha256').update(provided).digest());
  };
  const reply = (response, status, body, headers = {}) => {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(body));
  };
  const persist = report => enqueue(async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o755 });
    const snapshotName = `${report.reportId}.json`;
    const existing = await storedReport(path.join(directory, snapshotName));
    const content = canonicalJson(report);
    if (existing && (existing.reportId !== report.reportId || canonicalJson(existing) !== content)) throw failure(409, 'REPORT_ID_CONFLICT');
    const latest = await storedReport(path.join(directory, 'public.json'));
    if (latest?.reportId === report.reportId && canonicalJson(latest) !== content) throw failure(409, 'REPORT_ID_CONFLICT');
    if (latest && latest.generatedAt > report.generatedAt) {
      if (existing) return; // Successful old deliveries remain idempotent; the latest file stays untouched.
      throw failure(409, 'STALE_REPORT');
    }
    if (latest && latest.generatedAt === report.generatedAt && latest.reportId !== report.reportId) throw failure(409, 'GENERATION_CONFLICT');
    if (!existing) await atomicJson(directory, snapshotName, content);
    if (!latest || latest.reportId !== report.reportId) await atomicJson(directory, 'public.json', content);
  });
  return async function handleSync(request, response) {
    try {
      if (request.url !== '/api/sync') { request.resume(); reply(response, 404, { ok: false, error: 'NOT_FOUND' }); return; }
      if (request.method !== 'POST') { request.resume(); reply(response, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' }, { Allow: 'POST' }); return; }
      if (!authorized(request)) { request.resume(); reply(response, 401, { ok: false, error: 'UNAUTHORIZED' }); return; }
      const contentType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') { request.resume(); reply(response, 415, { ok: false, error: 'JSON_REQUIRED' }); return; }
      if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') { request.resume(); reply(response, 415, { ok: false, error: 'ENCODING_UNSUPPORTED' }); return; }
      const declared = request.headers['content-length'];
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) {
        request.resume(); reply(response, 413, { ok: false, error: 'PAYLOAD_TOO_LARGE' }); return;
      }
      let length = 0;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > MAX_BYTES) {
          request.resume(); reply(response, 413, { ok: false, error: 'PAYLOAD_TOO_LARGE' }); return;
        }
        chunks.push(chunk);
      }
      let report;
      try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw failure(400, 'INVALID_JSON'); }
      validatePublicReport(report);
      await persist(report);
      reply(response, 200, { reportId: report.reportId, ok: true });
    } catch (error) {
      const status = error.status || 503;
      if (status >= 500) logger('Recruitment site sync storage/request failure.');
      reply(response, status, { ok: false, error: error.code && error.status ? error.code : 'SYNC_UNAVAILABLE' });
    }
  };
}

export function createSyncServer(options) {
  return http.createServer({ requestTimeout: 30_000, headersTimeout: 10_000, maxHeaderSize: 16 * 1024, keepAliveTimeout: 5_000 }, createSyncHandler(options));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.RECRUITMENT_SITE_SYNC_PORT || 8769);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SYNC_PORT_INVALID');
    const server = createSyncServer({ token: process.env.RECRUITMENT_SITE_SYNC_TOKEN, dataDir: process.env.RECRUITMENT_SITE_DATA_DIR, logger: message => console.error(message) });
    server.on('error', () => { console.error('Recruitment site sync server could not start.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Recruitment site sync listening on 127.0.0.1:${port}.`));
  } catch {
    console.error('Recruitment site sync requires a valid token, dedicated absolute data directory and port.');
    process.exitCode = 1;
  }
}

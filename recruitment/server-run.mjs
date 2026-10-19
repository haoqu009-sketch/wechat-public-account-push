import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './run.mjs';
import { publishWeb } from './publish-web.mjs';
import { readWechatConfig, recipientKey, getAccessToken, validateRecruitmentTemplates } from './wechat.mjs';

// Production systemd units must invoke every mode under the SAME external flock.
// This local queue also serializes calls made in one Node process; it is not a cross-process lock.
const queues = new Map();
const safeError = () => new Error('服务器招聘任务未完成，请检查受保护配置、状态、采集与网站发布结果。');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const dateValid = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
};

function clockParts(now) {
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw safeError();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).map(part => [part.type, part.value]));
  return { instant, today: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function directory(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw safeError();
  const result = path.resolve(value);
  if (result === path.parse(result).root) throw safeError();
  return result;
}

async function serial(key, action) {
  const previous = queues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

async function readJson(file, fileSystem, optional = false) {
  try { return JSON.parse(await fileSystem.readFile(file, 'utf8')); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw safeError(); }
}

function validState(state) {
  if (!object(state) || state.version !== 1 || !object(state.jobs) || !object(state.recipients)) throw safeError();
  for (const bucket of Object.values(state.recipients)) {
    if (!object(bucket) || !object(bucket.sent) || !object(bucket.reminded)) throw safeError();
  }
  return state;
}

async function stateSnapshot(file, fileSystem) {
  const stat = await fileSystem.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw safeError();
  const raw = await fileSystem.readFile(file);
  validState(JSON.parse(raw.toString('utf8')));
  return raw;
}

const backupName = /^state-\d{8}T\d{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;

async function backupState(stateFile, stateDir, instant, fileSystem) {
  // Validate before touching backups, so a damaged state cannot replace a valid snapshot.
  const raw = await stateSnapshot(stateFile, fileSystem);
  const backupDir = path.join(stateDir, 'backups');
  await fileSystem.mkdir(backupDir, { recursive: true, mode: 0o700 });
  const stat = await fileSystem.lstat(backupDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError();
  await fileSystem.chmod(backupDir, 0o700);
  const name = `state-${instant.toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.json`;
  const destination = path.join(backupDir, name), temporary = path.join(backupDir, `.${name}.tmp`);
  try {
    await fileSystem.writeFile(temporary, raw, { flag: 'wx', mode: 0o600 });
    await fileSystem.rename(temporary, destination);
  } finally {
    await fileSystem.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw safeError(); });
  }
  // Only our own regular snapshot files are eligible for retention cleanup.
  const previous = [];
  for (const entry of await fileSystem.readdir(backupDir, { withFileTypes: true })) {
    if (entry.name === name || !entry.isFile() || !backupName.test(entry.name)) continue;
    const details = await fileSystem.lstat(path.join(backupDir, entry.name));
    if (details.isFile() && !details.isSymbolicLink()) previous.push({ name: entry.name, time: details.mtimeMs });
  }
  previous.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name));
  for (const entry of previous.slice(29)) await fileSystem.unlink(path.join(backupDir, entry.name));
}

async function writeMarker(file, marker, fileSystem) {
  const temporary = path.join(path.dirname(file), `.server-control-${randomUUID()}.tmp`);
  try {
    await fileSystem.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fileSystem.writeFile(temporary, JSON.stringify(marker, null, 2), { flag: 'wx', mode: 0o600 });
    await fileSystem.rename(temporary, file);
  } finally {
    await fileSystem.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw safeError(); });
  }
}

function siteConfiguration(env) {
  const base = env.RECRUITMENT_PUBLIC_BASE_URL;
  if (typeof base !== 'string' || typeof env.RECRUITMENT_SITE_SYNC_TOKEN !== 'string'
    || env.RECRUITMENT_SITE_SYNC_TOKEN.length < 32 || /\s/.test(env.RECRUITMENT_SITE_SYNC_TOKEN)) throw safeError();
  let url;
  try { url = new URL(base); } catch { throw safeError(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw safeError();
  return url.href.replace(/\/+$/, '');
}

function publishedReport(result, expectedBase) {
  if (result?.published !== true || !/^[a-f0-9]{24}$/.test(result.reportId || '') || typeof result.reportUrl !== 'string') throw safeError();
  if (result.reportUrl !== `${expectedBase}/?report=${result.reportId}`) throw safeError();
  return result;
}

/**
 * refresh: run --refresh-only persists observations but leaves recipients/pending untouched.
 * daily: recollect -> publish and verify the public JSON -> send -> successful-day marker.
 * verify: read protected state/config and check the WeChat token/template API; NEVER send.
 * All modes use one local state directory; GitHub restore/publish is deliberately absent.
 */
export async function serverRun(mode, env = process.env, services = {}) {
  const logger = services.log || console.log;
  try {
    if (!['refresh', 'daily', 'verify'].includes(mode)) throw safeError();
    const stateDir = directory(env.RECRUITMENT_STATE_DIR || '/var/lib/recruitment-collector/state');
    const reportDir = directory(env.RECRUITMENT_REPORT_DIR || path.join(stateDir, 'reports'));
    const fileSystem = services.fs || fs;
    const now = services.now || (() => new Date());
    const invokeRun = services.run || run;
    const publish = services.publishWeb || publishWeb;
    // Server operation cannot silently fall back to GitHub links, output files or Git credentials.
    const localEnv = { ...env, RECRUITMENT_STATE_DIR: stateDir, RECRUITMENT_REPORT_DIR: reportDir };
    for (const key of ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_OUTPUT']) delete localEnv[key];
    const locked = services.withLock || (action => serial(stateDir, action));
    return await locked(async () => {
      const stateFile = path.join(stateDir, 'state.json');
      const markerFile = path.join(stateDir, 'server-control.json');
      if (mode === 'verify') {
        const state = validState(await readJson(stateFile, fileSystem));
        const settings = (services.readWechatConfig || readWechatConfig)(localEnv);
        if (!settings?.users?.length) throw safeError();
        const userKeys = settings.users.map(recipientKey);
        if (new Set(userKeys).size !== userKeys.length) throw safeError();
        const existing = Object.keys(state.recipients), expected = new Set(userKeys);
        // A newly added recipient can have no bucket yet; an unexpected old bucket needs review.
        if (existing.some(key => !expected.has(key))) throw safeError();
        const token = await (services.getAccessToken || getAccessToken)(settings);
        const validation = await (services.validateTemplates || validateRecruitmentTemplates)(settings, token);
        if (!validation || validation.recipientCount !== settings.users.length || !Number.isInteger(validation.templateCount) || validation.templateCount < 1) throw safeError();
        logger(`服务器只读校验通过：接收人${settings.users.length}位，已有状态${existing.length}位；未发送消息。`);
        return { mode, verified: true, recipientCount: settings.users.length, stateRecipientCount: existing.length };
      }
      const base = siteConfiguration(localEnv);
      if (mode === 'refresh') {
        await backupState(stateFile, stateDir, clockParts(now()).instant, fileSystem);
        await invokeRun(['--refresh-only'], localEnv, services.runServices || {});
        const result = publishedReport(await publish(localEnv, services.publishServices || {}), base);
        logger('服务器采集刷新及网页回读核验完成，未发送微信。');
        return { mode, refreshed: true, reportId: result.reportId };
      }
      if (localEnv.RECRUITMENT_SENDER_OWNER !== 'server') throw safeError();
      const ttl = Number(localEnv.RECRUITMENT_DAILY_CATCHUP_MINUTES || 120);
      if (!Number.isInteger(ttl) || ttl < 0 || ttl > 120) throw safeError();
      const clock = clockParts(now());
      const start = 7 * 60 + 30, end = start + ttl;
      if (clock.minute < start || clock.minute > end) {
        logger('当前不在北京时间晨报允许窗口，本次不发送。');
        return { mode, skipped: 'outside-daily-window', today: clock.today };
      }
      const marker = await readJson(markerFile, fileSystem, true);
      if (marker && (!object(marker) || marker.version !== 1 || !dateValid(marker.dailyDate)
        || !/^[a-f0-9]{24}$/.test(marker.reportId || '') || typeof marker.completedAt !== 'string' || !Number.isFinite(Date.parse(marker.completedAt)))) throw safeError();
      if (marker?.dailyDate === clock.today) {
        logger('今天的服务器晨报已完成，本次不重复发送。');
        return { mode, skipped: 'daily-already-complete', today: clock.today };
      }
      if (marker?.dailyDate > clock.today) throw safeError();
      await backupState(stateFile, stateDir, clock.instant, fileSystem);
      await invokeRun(['--collect-only'], localEnv, services.runServices || {});
      const result = publishedReport(await publish(localEnv, services.publishServices || {}), base);
      // Long collection or lock waits must not result in an unexpected late-night catch-up send.
      const beforeSend = clockParts(now());
      if (beforeSend.today !== clock.today || beforeSend.minute < start || beforeSend.minute > end) {
        logger('采集发布完成时已超过晨报允许窗口，网页已更新，本次不发送。');
        return { mode, skipped: 'daily-window-ended', today: clock.today, reportId: result.reportId };
      }
      // Revalidate after collection as well: run must never fall back to a fresh empty state.
      await stateSnapshot(stateFile, fileSystem);
      let completedAt;
      try {
        await invokeRun(['--send-only'], { ...localEnv, RECRUITMENT_REPORT_URL: result.reportUrl }, services.runServices || {});
      } finally {
        const finalizedAt = clockParts(now()).instant;
        await backupState(stateFile, stateDir, finalizedAt, fileSystem);
        completedAt = finalizedAt.toISOString();
      }
      await writeMarker(markerFile, { version: 1, dailyDate: clock.today, reportId: result.reportId, completedAt }, fileSystem);
      logger('服务器晨报处理完成，成功接收人的去重状态已保留。');
      return { mode, complete: true, today: clock.today, reportId: result.reportId };
    });
  } catch { throw safeError(); }
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('服务器招聘任务需指定 refresh、daily 或 verify 模式。');
    process.exitCode = 1;
  } else {
    serverRun(process.argv[2]).catch(() => {
      console.error('服务器招聘任务未完成，请检查受保护配置、状态、采集与网站发布结果。');
      process.exitCode = 1;
    });
  }
}

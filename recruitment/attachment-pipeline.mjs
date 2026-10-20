import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { imaging } from './core.mjs';
import { spreadsheetRecords, pdfText, gridRecords } from './attachments.mjs';
import fs from 'node:fs/promises';
import { loadAttachmentImport, cachedAttachmentParse } from './attachment-store.mjs';
export { gridRecords } from './attachments.mjs';

const workerFile = fileURLToPath(new URL('./document-worker.py', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const parserRevision = Promise.all(['./attachment-pipeline.mjs', './attachments.mjs', './document-worker.py'].map(file => fs.readFile(new URL(file, import.meta.url))))
  .then(parts => digest(Buffer.concat(parts)));
let workerTail = Promise.resolve();
export function documentWorker(bytes, format, options = {}) {
  // One child process at a time, even when two distinct source hosts collect concurrently.
  const execute = () => new Promise((resolve, reject) => {
    const executable = options.python || process.env.RECRUITMENT_DOCUMENT_PYTHON || (process.platform === 'win32' ? null : '/usr/bin/python3');
    if (!executable) { reject(new Error('本机文档引擎未配置')); return; }
    const environment = Object.fromEntries(['PATH', 'Path', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const child = spawn(executable, [workerFile], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...environment, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', OMP_THREAD_LIMIT: '1', OPENBLAS_NUM_THREADS: '1' } });
    const chunks = []; let length = 0, settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('附件文档引擎处理超时')); }, 90_000);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.on('error', () => finish(new Error('本机文档引擎不可用')));
    child.stdin.on('error', () => {});
    child.stderr.resume(); // Untrusted document text / subprocess paths never become public errors.
    child.stdout.on('data', chunk => { length += chunk.length; if (length > 4_000_000) { child.kill('SIGKILL'); finish(new Error('文档解析输出超过上限')); } else chunks.push(chunk); });
    child.on('close', code => {
      if (code !== 0) { finish(new Error('附件文档引擎未完成解析')); return; }
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (result.error || !Array.isArray(result.tables) || !Array.isArray(result.pages) || !Array.isArray(result.issues)) throw new Error();
        finish(null, result);
      } catch { finish(new Error('附件文档引擎返回无效结果')); }
    });
    child.stdin.end(JSON.stringify({ data: bytes.toString('base64'), format, ocr: options.ocr === true }));
  });
  const result = workerTail.then(execute, execute);
  workerTail = result.catch(() => {});
  return result;
}

export function attachmentPurpose(file) {
  if (/岗位|计划|需求|职位|条件|资格|招聘简章|招聘公告/.test(file.title) && !/报名表|登记表|承诺|专业参考目录/.test(file.title)) return 'required';
  if (/报名表|登记表|承诺书|诚信|同意报考|推荐表|专业参考目录/.test(file.title)) return 'optional';
  return 'unknown';
}

export async function parseAttachment(bytes, file, options = {}) {
  if (!bytes?.length || bytes.length > 5_000_000) throw new Error('附件大小无效或超过上限');
  if (/^\s*(?:<!doctype html|<html)/i.test(bytes.subarray(0, 100).toString('utf8'))) throw new Error('附件返回网页或下载验证页');
  if (['xls', 'xlsx'].includes(file.format)) return spreadsheetRecords(bytes);
  let document;
  // Legacy test/embedding text providers remain clues, not proof of table columns.
  if (file.format === 'pdf' && options.pdfText) document = { tables: [], pages: (await options.pdfText(bytes)).map((text, index) => ({ text, number: index + 1 })), issues: [], method: 'pdf-text' };
  else {
    try { document = await (options.documentWorker || documentWorker)(bytes, file.format, options); }
    catch (error) {
      if (file.format !== 'pdf') throw error;
      document = { tables: [], pages: (await pdfText(bytes)).map((text, index) => ({ text, number: index + 1 })), issues: [error.message], method: 'pdf-text' };
    }
    if (file.format === 'pdf' && document.method === 'needs-engine') {
      document.pages = (await pdfText(bytes)).map((text, index) => ({ text, number: index + 1 }));
    }
  }
  const rows = [], issues = [...document.issues]; let complete = true;
  for (const table of document.tables) {
    const parsed = gridRecords(table.grid, table.locator);
    rows.push(...parsed.rows); if (!parsed.complete) { complete = false; issues.push(...parsed.issues); }
  }
  const clues = document.pages.filter(page => imaging.test(page.text)).map(page => ({ text: page.text, locator: `第${page.number}页${page.ocr ? '（OCR，未复核）' : ''}`, method: page.ocr ? 'ocr' : 'text' }));
  if (!document.tables.length && clues.length) { complete = false; issues.push(`${file.format.toUpperCase()}仅提取文字，尚未可靠重建岗位列关系`); }
  if (document.pages.some(page => page.ocr) || document.method === 'needs-engine') complete = false;
  // Native PDF text outside table boundaries / Word paragraphs may carry qualifications.
  // Do not silently interpret footnotes as if they belonged to every position.
  if (issues.length) complete = false;
  const notes = document.pages.map(page => page.notes || '').filter(text => /报考|应聘|须|必须|不得|仅限|截止|取得|注[：:]/.test(text));
  return { rows, clues, notes, complete, method: document.method, issues: [...new Set(issues)] };
}

// Download failures, parsing failures and queued files remain separate ledger states.
// Optional application forms do not block the job table's coverage.
export async function processAttachments(page, request, hosts, options = {}) {
  const entries = [...new Map(page.attachments.map(file => [file.url, file])).values()].map(file => ({ ...file,
    pageUrl: page.url, purpose: attachmentPurpose(file), status: 'queued', reason: '等待本轮附件处理预算',
    checkedAt: options.checkedAt || new Date().toISOString(), sha256: null, rows: 0, method: null,
  }));
  const candidates = entries.filter(entry => entry.purpose !== 'optional');
  const cycle = options.cycle ?? Math.floor(Date.now() / 14_400_000);
  const limit = Math.min(8, Math.max(0, Math.floor(options.maxFiles ?? 8)));
  const required = candidates.filter(entry => entry.purpose === 'required'), unknown = candidates.filter(entry => entry.purpose === 'unknown');
  const unknownQuota = unknown.length && limit && (!required.length || limit > 1) ? 1 : 0, requiredQuota = required.length ? limit - unknownQuota : 0;
  const rotate = (group, stride) => { const offset = group.length ? (cycle * Math.max(1, stride)) % group.length : 0; return group.slice(offset).concat(group.slice(0, offset)); };
  const req = rotate(required, requiredQuota), other = rotate(unknown, required.length ? unknownQuota : limit);
  // A small unknown-file quota prevents an ambiguously named real plan from starvation.
  const order = [...req.slice(0, requiredQuota), ...other.slice(0, limit - Math.min(req.length, requiredQuota)), ...req.slice(requiredQuota), ...other.slice(limit - Math.min(req.length, requiredQuota))];
  const rows = [], clues = [];
  const selected = order.slice(0, limit);
  for (const entry of entries.filter(item => item.purpose === 'optional')) { entry.status = 'optional'; entry.reason = '报名等辅助材料，不影响岗位表解析状态'; }
  let hostBlocked = false;
  for (const entry of selected) {
    const supplement = hostBlocked ? await loadAttachmentImport(options.importDir, entry) : null;
    if (!supplement && options.budget?.remaining <= 0) { entry.reason = '本来源本轮附件预算用尽，排队下轮处理'; continue; }
    if (hostBlocked && !supplement) { entry.reason = '该来源本轮已受限，保留排队，未绕过验证'; continue; }
    if (!supplement && options.budget) options.budget.remaining--;
    try {
      let file;
      try { file = supplement || await request(entry.url, hosts); }
      catch (error) {
        file = await loadAttachmentImport(options.importDir, entry);
        if (!file) throw error;
        if (/HTTP (403|429)/.test(error.message)) hostBlocked = true;
      }
      entry.sha256 = digest(file.bytes);
      // Download still occurs first: a local cache is never substituted for current HTTP success.
      const key = `${await parserRevision}:${entry.sha256}:${entry.format}:${options.ocr === true}`;
      const parsed = structuredClone(await cachedAttachmentParse(options.parseCacheDir, key, () => parseAttachment(file.bytes, entry, options)));
      if (file.manual) { parsed.complete = false; parsed.issues.push('官方附件本轮未能下载，使用手动补充原件，尚未与官网当前文件比对'); }
      entry.rows = parsed.rows.length; entry.method = parsed.method;
      entry.status = parsed.complete ? 'parsed' : parsed.rows.length ? 'partial' : parsed.clues.some(clue => clue.method === 'ocr') ? 'ocr_review' : 'review';
      entry.reason = parsed.complete ? `已读取原生单元格，提取影像岗位${entry.rows}行` : parsed.issues.join('；') || '未取得可确认的岗位表格，需要检查原件';
      rows.push(...parsed.rows.map(row => ({ ...row, url: entry.url, title: entry.title, notes: (parsed.notes || []).join('；').slice(0, 1200), incomplete: !parsed.complete })));
      clues.push(...parsed.clues.map(clue => ({ ...clue, url: entry.url, title: entry.title })));
    } catch (error) {
      entry.status = 'failed';
      entry.reason = /HTTP (\d+)/.test(error.message) ? `附件下载失败（${error.message.match(/HTTP \d+/)[0]}）`
        : /CERT_HAS_EXPIRED/.test(error.message) ? '附件站点证书过期，未跳过证书校验'
          : /网页|验证页/.test(error.message) ? '附件返回下载验证页，未绕过验证'
            : /本机|文档引擎/.test(error.message) ? '本机文档引擎不可用或未完成解析'
              : '附件格式损坏、超限或未完成解析，需检查原件';
      if (/HTTP (403|429)/.test(error.message)) hostBlocked = true;
    }
    await options.pause?.(400);
  }
  const incomplete = entries.filter(entry => !['parsed', 'optional'].includes(entry.status));
  return { entries, rows, clues, complete: !incomplete.length, issues: incomplete.map(entry => `${entry.title}：${entry.reason}`) };
}

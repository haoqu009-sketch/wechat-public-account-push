import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { gridRecords, documentWorker, parseAttachment, processAttachments } from '../attachment-pipeline.mjs';
import { pageData, jobFrom, chinaDate } from '../core.mjs';
import { verifyJobs } from '../verification.mjs';
import { createPublicReport } from '../public-report.mjs';
import { validatePublicReport } from '../site-server.mjs';
import { loadAttachmentImport, saveAttachmentImport, cachedAttachmentParse } from '../attachment-store.mjs';
import { importAttachment } from '../import-attachment.mjs';

const python = process.env.RECRUITMENT_DOCUMENT_PYTHON || (process.platform === 'win32' ? null : '/usr/bin/python3');
const source = { id: 'original', name: '甲医院', url: 'https://hospital.example/jobs', allowedHosts: ['hospital.example'], sourceKind: 'official-employer' };
const rows = [['岗位名称', '学历要求', '专业要求', '岗位代码'], ['放射科医师', '硕士', '医学影像学', '108'], ['超声科医师', '博士', '临床医学', '109']];
const page = { url: source.url, attachments: [] };
const xlsx = async () => { const book = new ExcelJS.Workbook(); book.addWorksheet('岗位计划').addRows(rows); return Buffer.from(await book.xlsx.writeBuffer()); };
async function docx(note = '') {
  const zip = new JSZip();
  const cell = value => `<w:tc><w:p><w:r><w:t>${value}</w:t></w:r></w:p></w:tc>`;
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${note}</w:t></w:r></w:p><w:tbl>${rows.map(row => `<w:tr>${row.map(cell).join('')}</w:tr>`).join('')}</w:tbl></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// A real PDF byte stream with a Chinese CID font and drawn cell boundaries.
function tablePdf(mergedDegree = false) {
  const commands = ['0.5 w'];
  for (const x of [20, 170, 270, 400, 480]) commands.push(`${x} 100 m ${x} 220 l S`);
  for (const y of [100, 140, 180, 220]) commands.push(mergedDegree && y === 140 ? '20 140 m 170 140 l S 270 140 m 480 140 l S' : `20 ${y} m 480 ${y} l S`);
  rows.forEach((row, r) => row.forEach((text, c) => { if (!(mergedDegree && r === 2 && c === 1)) commands.push(`BT /F1 10 Tf ${[25, 175, 275, 405][c]} ${200 - r * 40} Td <${Buffer.from(text, 'utf16le').swap16().toString('hex')}> Tj ET`); }));
  const content = commands.join('\n');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 260] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>', '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>', '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

test('原生表格要求独立关键列，缺格、串列或无表头不会伪装已完整解析', () => {
  const result = gridRecords(rows, '表1');
  assert.equal(result.rows.length, 2); assert.equal(result.complete, true);
  assert.match(result.rows[1].text, /学历要求：博士/); assert.equal(result.rows[0].locator, '表1第2行');
  assert.equal(gridRecords([rows[0], ['放射科医师', '', '医学影像学', '108']], '表1').complete, false);
  assert.equal(gridRecords([['放射科医师 硕士 医学影像学']], '表1').rows.length, 0);
});

test('Excel工作表与真实物理行号保留，不以第几条提取结果冒充原始行', async () => {
  const result = await parseAttachment(await xlsx(), { format: 'xlsx' });
  assert.equal(result.complete, true); assert.match(result.rows[0].locator, /岗位计划.*第2行/);
  assert.match(result.rows[1].text, /博士/);
});

test('超过3份的岗位表全部进入清单，轮转处理而非静默丢弃；报名表不制造解析缺口', async () => {
  const bytes = await xlsx(), calls = [];
  const attachments = Array.from({ length: 10 }, (_, index) => ({ title: `岗位计划${index}.xlsx`, url: `https://hospital.example/${index}.xlsx`, format: 'xlsx' }));
  attachments.unshift({ title: '报名表.doc', url: 'https://hospital.example/apply.doc', format: 'doc' });
  const request = async url => { calls.push(url); return { bytes }; };
  const first = await processAttachments({ ...page, attachments }, request, source.allowedHosts, { cycle: 0 });
  const second = await processAttachments({ ...page, attachments }, request, source.allowedHosts, { cycle: 1 });
  assert.equal(first.entries.length, 11); assert.equal(first.entries.filter(item => item.status === 'parsed').length, 8);
  assert.equal(first.entries[0].status, 'optional'); assert.equal(first.entries.filter(item => item.status === 'queued').length, 2);
  assert.equal(new Set(calls).size, 10); assert.equal(first.complete, false);
  assert.equal(second.entries.find(item => item.url.endsWith('/9.xlsx')).status, 'parsed');
});

test('岗位材料很多时仍给用途未定附件留预算，不会永远只检查前几份', async () => {
  const bytes = await xlsx();
  const attachments = Array.from({ length: 12 }, (_, index) => ({ title: `岗位计划${index}.xlsx`, url: `https://hospital.example/${index}.xlsx`, format: 'xlsx' }));
  attachments.push({ title: '附件B.xlsx', url: 'https://hospital.example/B.xlsx', format: 'xlsx' });
  const result = await processAttachments({ ...page, attachments }, async () => ({ bytes }), source.allowedHosts, { cycle: 0 });
  assert.equal(result.entries.find(item => item.title === '附件B.xlsx').status, 'parsed');
  assert.equal(result.entries.filter(item => item.status === 'parsed').length, 8);
});

test('下载403停止同主机后续附件，失败和排队状态不同，辅助附件不下载', async () => {
  let count = 0;
  const result = await processAttachments({ ...page, attachments: [0, 1].map(index => ({ url: `https://hospital.example/${index}.xlsx`, format: 'xlsx', title: `岗位${index}.xlsx` })) }, async () => { count++; throw new Error('HTTP 403'); }, source.allowedHosts);
  assert.equal(count, 1); assert.equal(result.entries[0].status, 'failed'); assert.equal(result.entries[1].status, 'queued');
  assert.match(result.entries[0].reason, /403/);
});

test('OCR、纯文字和缺列PDF一律不能升级为已核验的岗位行', async () => {
  const result = await parseAttachment(Buffer.from('%PDF-1.7'), { format: 'pdf' }, { documentWorker: async () => ({ method: 'ocr-review', tables: [], issues: ['OCR待核对'], pages: [{ number: 1, text: '放射科医师 硕士 医学影像学', ocr: true }] }) });
  assert.equal(result.complete, false); assert.equal(result.rows.length, 0); assert.equal(result.clues[0].method, 'ocr');
});

test('文章岗位图片进入清单，导航/装饰小图与未批准图床不抓取', () => {
  const data = pageData('<body><article>招聘公告岗位需求见下方图片，报名及具体条件以官方原文为准。<img src="/jobs.png" alt="招聘岗位计划"><img src="/logo.jpg" width="40" height="40"><img src="https://evil.example/jobs.png" alt="岗位表"></article></body>', page.url, source);
  assert.deepEqual(data.attachments.map(item => item.url), ['https://hospital.example/jobs.png']);
});

test('Word真实DOCX按单元格提取，保留硕博差异与表外补充条件', { skip: !python }, async () => {
  const bytes = await docx('注：应聘人员须于2026年8月31日前取得学历学位。');
  const result = await parseAttachment(bytes, { format: 'docx' }, { python });
  assert.equal(result.rows.length, 2); assert.match(result.rows[0].locator, /Word表1第2行/);
  assert.match(result.rows[1].text, /博士/); assert.match(result.notes[0], /8月31日/);
});

test('中文原生PDF真实引擎依据表格线重建行列，定位到页/表/行', { skip: !python }, async t => {
  try { execFileSync(python, ['-c', 'import pdfplumber'], { stdio: 'pipe' }); }
  catch { t.skip('未安装PDF表格引擎'); return; }
  const result = await parseAttachment(tablePdf(), { format: 'pdf' }, { python });
  assert.equal(result.complete, true, JSON.stringify(result)); assert.equal(result.rows.length, 2);
  assert.match(result.rows[0].locator, /PDF第1页表1第2行/); assert.match(result.rows[1].text, /学历要求：博士/);
  const merged = await parseAttachment(tablePdf(true), { format: 'pdf' }, { python });
  assert.equal(merged.rows.length, 2); assert.match(merged.rows[1].text, /学历要求：硕士/);
  assert.doesNotMatch(merged.rows[1].text, /博士/);
});

test('Word纵向合并只沿明确vMerge关系恢复，不填充普通空白单元格', { skip: !python }, async () => {
  const zip = await JSZip.loadAsync(await docx());
  let xml = await zip.file('word/document.xml').async('string');
  xml = xml.replace('<w:tc><w:p><w:r><w:t>硕士', '<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>硕士')
    .replace('<w:tc><w:p><w:r><w:t>博士</w:t></w:r></w:p></w:tc>', '<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>');
  zip.file('word/document.xml', xml);
  const result = await parseAttachment(await zip.generateAsync({ type: 'nodebuffer' }), { format: 'docx' }, { python });
  assert.equal(result.rows.length, 2); assert.match(result.rows[1].text, /学历要求：硕士/);
});

test('Word附件真实贯通原文核验，保留旧岗位ID和指纹；辅助报名表不会让matched降级', { skip: !python }, async () => {
  const today = chinaDate(), profile = { graduationYear: 2027, specialty: '医学影像学' };
  const config = { profile, sources: [source], verification: { enabled: true } };
  const base = jobFrom('岗位代码：108；岗位名称：放射科医师；学历：硕士；专业：医学影像学', { ...page, title: '甲医院招聘', text: '' }, source, profile, 1);
  const bytes = await docx(), calls = [];
  const [result] = await verifyJobs([{ ...base, fingerprint: 'existing', id: 'existing-id' }], config, today, { python, request: async url => {
    calls.push(url);
    return url.endsWith('docx') ? { url, type: 'application/octet-stream', bytes } : { url, type: 'text/html', bytes: Buffer.from('<body><h1>甲医院2027年应届招聘公告</h1><article>招聘对象：2027年度应届毕业生。报名安排：自本公告发布之日起接受报名，各岗位招满即止。岗位见附件。<a href="/jobs.docx">岗位计划.docx</a><a href="/apply.doc">报名表.doc</a></article></body>') };
  } });
  assert.equal(result.id, 'existing-id'); assert.equal(result.fingerprint, 'existing');
  assert.equal(result.verification.state, 'matched', JSON.stringify(result.verification));
  assert.equal(calls.length, 2); assert.equal(result.verification.attachments[1].status, 'optional');
});

test('附件表外硬条件保留证据和具体疑点，不能在仅表格符合时判matched', { skip: !python }, async () => {
  const today = chinaDate(), profile = { graduationYear: 2027, specialty: '医学影像学' };
  const config = { profile, sources: [source], verification: { enabled: true } };
  const base = jobFrom('岗位代码：108；岗位名称：放射科医师；学历：硕士；专业：医学影像学', { ...page, title: '甲医院招聘', text: '' }, source, profile, 1);
  const bytes = await docx('注：应聘人员须于2026年8月31日前取得相应学历学位。');
  const [result] = await verifyJobs([base], config, today, { python, request: async url => url.endsWith('docx') ? { url, bytes } : { url, type: 'text/html', bytes: Buffer.from('<body><h1>甲医院2027年应届招聘公告</h1><article>招聘对象：2027年度应届毕业生。自本公告发布之日起接受报名，各岗位招满即止。岗位及条件见附件。<a href="/jobs.docx">岗位计划.docx</a></article></body>') } });
  assert.equal(result.verification.state, 'partial');
  assert.match(result.verification.evidence.find(item => item.field === 'attachmentNotes').quote, /8月31日/);
  assert.match(result.verification.issues.join('；'), /表外补充条件/);
});

test('附件公共契约保留具体失败原因，不导出内部哈希和任意诊断；老快照兼容', async () => {
  const today = chinaDate(), generatedAt = new Date().toISOString();
  const result = await processAttachments({ ...page, attachments: [{ title: '岗位.xlsx', url: 'https://hospital.example/jobs.xlsx', format: 'xlsx' }] }, async () => { throw new Error('HTTP 412 PRIVATE_VALUE'); }, source.allowedHosts, { checkedAt: generatedAt });
  const config = { profile: { graduationYear: 2027 }, sources: [source] };
  const report = createPublicReport({ jobs: [], digest: { today, physicians: [], technicians: [], reminders: [] }, config, generatedAt, coverage: [{ name: source.name, ok: true, articles: 1, warnings: [], attachments: result.entries }] });
  assert.doesNotThrow(() => validatePublicReport(report));
  assert.match(report.sources[0].attachments[0].reason, /412/); assert.doesNotMatch(JSON.stringify(report), /PRIVATE_VALUE|sha256/);
  const bad = structuredClone(report); bad.sources[0].attachments[0].secret = 'x'; assert.throws(() => validatePublicReport(bad));
  const old = structuredClone(report); delete old.sources[0].attachments; assert.doesNotThrow(() => validatePublicReport(old));
});

test('损坏Word及HTML伪附件安全失败，不执行宏或外部关系', { skip: !python }, async () => {
  await assert.rejects(parseAttachment(Buffer.from('<html>login</html>'), { format: 'docx' }, { python }), /验证页/);
  await assert.rejects(documentWorker(Buffer.from('PKbroken'), 'docx', { python }), /未完成解析/);
});

test('手动补充原件校验哈希与有效期，自动回放但不冒充本轮官网下载成功', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = { title: '招聘岗位.xlsx', format: 'xlsx', url: 'https://hospital.example/jobs.xlsx' };
  await saveAttachmentImport(directory, { ...file, bytes: await xlsx() });
  const result = await processAttachments({ ...page, attachments: [file] }, async () => { throw new Error('HTTP 403'); }, source.allowedHosts, { importDir: directory });
  assert.equal(result.rows.length, 2); assert.equal(result.entries[0].status, 'partial'); assert.match(result.entries[0].reason, /手动补充原件/);
  assert.equal(await loadAttachmentImport(directory, file, Date.now() + 31 * 86400000), null);
  const target = path.join(directory, (await fs.readdir(directory))[0]);
  const data = JSON.parse(await fs.readFile(target)); data.body = Buffer.from('tampered').toString('base64');
  await fs.writeFile(target, JSON.stringify(data)); assert.equal(await loadAttachmentImport(directory, file), null);
});

test('补充附件CLI拒绝未批准原始网址，不能作为任意域名信任入口', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json'), file = path.join(directory, 'jobs.xlsx');
  await fs.writeFile(configFile, JSON.stringify({ sources: [source] })); await fs.writeFile(file, await xlsx());
  const env = { RECRUITMENT_CONFIG: configFile, RECRUITMENT_ATTACHMENT_IMPORT_DIR: path.join(directory, 'imports') };
  await assert.rejects(importAttachment(['--url', 'https://evil.example/jobs.xlsx', '--file', file, '--format', 'xlsx'], env), /批准官方域名/);
  await assert.rejects(importAttachment(['--url', 'http://hospital.example/jobs.xlsx', '--file', file, '--format', 'xlsx'], env), /HTTPS/);
  await assert.rejects(saveAttachmentImport(directory, { url: 'https://hospital.example/a?token=secret', format: 'xlsx', bytes: await xlsx() }), /无效/);
  const result = await importAttachment(['--url', 'https://hospital.example/jobs.xlsx', '--file', file, '--format', 'xlsx'], env);
  assert.equal(result.imported, true);
});

test('解析缓存只复用相同内容和版本的完整结果，不缓存失败或使403变成成功', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let called = 0;
  const parse = async () => { called++; return { rows: [], clues: [], issues: [], complete: true }; };
  await cachedAttachmentParse(directory, 'version-a:hash-1', parse); await cachedAttachmentParse(directory, 'version-a:hash-1', parse);
  assert.equal(called, 1);
  await cachedAttachmentParse(directory, 'version-b:hash-1', parse); assert.equal(called, 2);
  let failedCalls = 0;
  const incomplete = async () => { failedCalls++; return { rows: [], clues: [], issues: ['engine missing'], complete: false }; };
  await cachedAttachmentParse(directory, 'incomplete', incomplete); await cachedAttachmentParse(directory, 'incomplete', incomplete); assert.equal(failedCalls, 2);
  const file = { title: '岗位.xlsx', format: 'xlsx', url: 'https://hospital.example/jobs.xlsx' }, bytes = await xlsx();
  await processAttachments({ ...page, attachments: [file] }, async () => ({ bytes }), source.allowedHosts, { parseCacheDir: directory });
  const failed = await processAttachments({ ...page, attachments: [file] }, async () => { throw new Error('HTTP 403'); }, source.allowedHosts, { parseCacheDir: directory });
  assert.equal(failed.entries[0].status, 'failed'); assert.equal(failed.rows.length, 0);
});

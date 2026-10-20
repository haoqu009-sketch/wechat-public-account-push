import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { spreadsheetRows, pdfText } from '../attachments.mjs';
import { collectSource } from '../collector.mjs';

test('真实XLS与XLSX多层合并表头分别保留学历、学位、专业和单位', async () => {
  const grid = [['招聘岗位', '招聘岗位', '招聘条件', '招聘条件', '招聘条件'], ['招聘单位', '岗位名称', '学历', '学位', '专业'], ['测试医院', '放射科医师', '研究生', '硕士', '放射影像学']];
  const sheet = XLSX.utils.aoa_to_sheet(grid);
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }, { s: { r: 0, c: 2 }, e: { r: 0, c: 4 } }];
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '岗位表');
  for (const bookType of ['xls', 'xlsx']) {
    const rows = await spreadsheetRows(XLSX.write(book, { type: 'buffer', bookType }));
    assert.equal(rows.length, 1);
    assert.match(rows[0], /招聘岗位\/岗位名称：放射科医师/);
    assert.match(rows[0], /招聘条件\/学历：研究生/);
    assert.match(rows[0], /招聘条件\/学位：硕士/);
    assert.match(rows[0], /招聘条件\/专业：放射影像学/);
  }
});

test('HTML假下载、异常格式及超大附件不能当作岗位表', async () => {
  await assert.rejects(spreadsheetRows(Buffer.from('<html>download verification</html>')), /不是有效/);
  await assert.rejects(spreadsheetRows(Buffer.alloc(5_000_001)), /大小/);
  await assert.rejects(pdfText(Buffer.from('<html>not pdf</html>')), /不是有效PDF/);
});

test('PDF扫描件/页数/文字量限额安全失败，不宣称解析成功', async () => {
  let destroyed = false;
  const library = { getDocument: options => {
    assert.equal(options.isEvalSupported, false);
    return { promise: Promise.resolve({ numPages: 1, getPage: async () => ({ getTextContent: async () => ({ items: [] }), cleanup() {} }), destroy: async () => { destroyed = true; } }) };
  } };
  await assert.rejects(pdfText(Buffer.from('%PDF-1.7 fake-only-for-mocked-library'), { library }), /扫描PDF/);
  assert.equal(destroyed, true);
});

test('Mozilla实际PDF解析器提取文字，不需要外部OCR或付费API', async () => {
  const content = 'BT /F1 12 Tf 20 100 Td (CT radiology physician recruitment 2027) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pages = await pdfText(Buffer.from(pdf));
  assert.equal(pages.length, 1); assert.match(pages[0], /radiology physician recruitment 2027/);
});

test('PDF正文线索进入待核实通道，不能因医师字样伪造结构化岗位', async () => {
  const source = { name: '测试医院', url: 'https://hospital.example/recruit', isListing: true, allowedHosts: ['hospital.example'] };
  const config = { lookbackDays: 90, profile: { graduationYear: 2027 } };
  const request = async url => ({ url, type: url.endsWith('.pdf') ? 'application/pdf' : 'text/html', bytes: Buffer.from(url.endsWith('.pdf') ? '%PDF-1.7 mocked' : url.endsWith('/recruit') ? '<html><a href="/notice">2027年招聘公告</a></html>' : '<html><h1>2027年招聘公告</h1><article>发布日期：2026-10-19。具体岗位要求及报名方式请见岗位计划附件，全部资格以正式公告为准。</article><a href="/jobs.pdf">岗位表.pdf</a></html>') });
  const result = await collectSource(source, config, '2026-10-20', { request, pause: async () => {}, pdfText: async () => ['放射科医师，硕士，2027届，报名截止日期：2026年11月1日。'] });
  assert.equal(result.jobs.length, 1); assert.equal(result.jobs[0].role, 'clue');
  assert.match(result.coverage.warnings.join('；'), /PDF.*线索/);
});

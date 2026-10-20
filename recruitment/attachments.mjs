import * as XLSX from 'xlsx';
import { clean, imaging } from './core.mjs';

const headerLike = row => row.some(cell => /^(?:招聘|用人)?(?:岗位|职位|专业|科室|单位)(?:名称|类别|要求|代码)?$/.test(clean(cell)))
  && row.some(cell => /^(?:招聘)?(?:学历|学位|人数|条件|岗位名称)(?:要求)?$/.test(clean(cell)));

export function rowsFromGrid(grid) {
  const first = grid.findIndex(headerLike);
  if (first < 0) return grid.filter(row => imaging.test(row.join(' '))).map(row => row.join('；'));
  let last = first;
  while (last < first + 2 && grid[last + 1] && headerLike(grid[last + 1]) && /学历|学位|专业|岗位名称/.test(grid[last + 1].join(' '))) last++;
  const width = Math.max(...grid.slice(first, last + 1).map(row => row.length));
  const header = Array.from({ length: width }, (_, column) => [...new Set(grid.slice(first, last + 1).map(row => clean(row[column])).filter(Boolean))].join('/'));
  return grid.slice(last + 1).filter(row => !headerLike(row) && imaging.test(row.join(' ')))
    .map(row => row.map((cell, column) => cell ? `${header[column] || `列${column + 1}`}：${cell}` : '').filter(Boolean).join('；'));
}

export async function spreadsheetRows(bytes) {
  if (!bytes?.length || bytes.length > 5_000_000) throw new Error('岗位表大小无效');
  const ole = bytes.subarray(0, 8).toString('hex') === 'd0cf11e0a1b11ae1';
  if (!ole && bytes.subarray(0, 2).toString() !== 'PK') throw new Error('附件不是有效XLS/XLSX岗位表');
  const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, sheetRows: 10002 });
  if (workbook.SheetNames.length > 40) throw new Error('岗位表工作表数量超过上限');
  const result = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r >= 10000 || range.e.c >= 200 || (range.e.r + 1) * (range.e.c + 1) > 500000) throw new Error('岗位表超过行列上限');
    const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: true, raw: false }).map(row => row.map(clean));
    // Preserve parent labels across merged cells, then combine at most 3 header rows.
    for (const merge of sheet['!merges'] || []) {
      if (merge.e.r > range.e.r || merge.e.c > range.e.c) throw new Error('岗位表合并范围无效');
      const value = grid[merge.s.r]?.[merge.s.c] || '';
      for (let row = merge.s.r; row <= merge.e.r; row++) {
        grid[row] ||= [];
        for (let column = merge.s.c; column <= merge.e.c; column++) grid[row][column] = value;
      }
    }
    result.push(...rowsFromGrid(grid));
  }
  return result;
}

export async function pdfText(bytes, services = {}) {
  if (!bytes?.length || bytes.length > 5_000_000 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('附件不是有效PDF');
  const library = services.library || await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = library.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true, verbosity: 0 });
  let document;
  try {
    document = await task.promise;
    if (document.numPages > 60) throw new Error('PDF超过60页上限，需人工核验');
    const pages = []; let total = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index), content = await page.getTextContent();
      const lines = []; let y;
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        if (y !== undefined && Math.abs(item.transform[5] - y) > 3) lines.push('\n');
        lines.push(item.str, ' '); y = item.transform[5];
      }
      const text = lines.join(''); total += text.length;
      if (total > 250000) throw new Error('PDF文本超过上限，需人工核验');
      pages.push(text); page.cleanup();
    }
    if (clean(pages.join('')).length < 20) throw new Error('扫描PDF无可提取文字，需OCR或人工核验');
    return pages;
  } finally { if (typeof task.destroy === 'function') await task.destroy(); else await document?.destroy?.(); }
}

import ExcelJS from 'exceljs';
import { clean, imaging, linksFrom, classifyLink, pageData, jobFrom, safeUrl, daysBetween } from './core.mjs';
import { collectPumchSource } from './pumch.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function download(url, hosts, fetcher = fetch, limit = 5_000_000) {
  let current = safeUrl(url, url, hosts);
  if (!current) throw new Error('链接不在配置的HTTPS来源范围内');
  for (let redirects = 0; redirects <= 4; redirects++) {
    let response;
    try {
      response = await fetcher(current, {
        redirect: 'manual', signal: AbortSignal.timeout(20_000),
        headers: { 'User-Agent': 'MedicalImagingRecruitmentDigest/1.0', Accept: 'text/html,application/xhtml+xml,application/json,application/octet-stream;q=0.8,*/*;q=0.5' },
      });
    } catch (error) {
      const code = error.cause?.code || error.code || error.name;
      throw new Error(`来源连接失败（${String(code || 'NETWORK_ERROR').replace(/[^\w-]/g, '')}）`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = safeUrl(response.headers.get('location'), current, hosts);
      await response.body?.cancel();
      if (!next) throw new Error('跳转到未配置的域名或非HTTPS地址，请核对来源');
      current = next;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) throw new Error('页面或附件超过大小上限');
      chunks.push(chunk);
    }
    return { bytes: Buffer.concat(chunks), url: current, type: response.headers.get('content-type') || '' };
  }
  throw new Error('重定向次数过多');
}

export function decodeHtml(bytes, contentType = '') {
  const ascii = bytes.subarray(0, 4096).toString('ascii');
  const charset = contentType.match(/charset\s*=\s*([\w-]+)/i)?.[1]
    || ascii.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  return new TextDecoder(charset).decode(bytes);
}

export async function spreadsheetRows(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const result = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > 10000 || sheet.columnCount > 200) throw new Error('岗位表超过行列上限');
    const rows = [];
    sheet.eachRow(row => rows.push(row.values.slice(1).map(value => {
      if (value && typeof value === 'object') return clean(value.text || value.result || value.richText?.map(item => item.text).join(''));
      return clean(value);
    })));
    const headerIndex = rows.findIndex(row => /岗位|专业/.test(row.join(' ')) && /学历|学位|人数|条件/.test(row.join(' ')));
    const header = rows[headerIndex] || [];
    for (const [index, row] of rows.entries()) {
      if (index === headerIndex || !imaging.test(row.join(' '))) continue;
      result.push(header.length ? row.map((cell, i) => `${header[i] || `列${i + 1}`}：${cell}`).join('；') : row.join('；'));
    }
  }
  return result;
}

export async function collectSource(source, config, today, options = {}) {
  const request = options.request || download;
  if (source.type === 'pumch-api') return collectPumchSource(source, config, today, { ...options, request });
  const pause = options.pause || wait;
  const hosts = source.allowedHosts || [new URL(source.url).hostname];
  const coverage = { name: source.name, ok: false, articles: 0, warnings: [] };
  const jobs = [];
  const observedPages = [];
  const visited = new Set();
  const articles = new Map();
  const indexes = [source.url];
  let discoveredIndex = Boolean(source.isListing);
  try {
    // Bounded discovery: home page and up to three recruitment listing pages.
    for (let i = 0; i < indexes.length && i < 4; i++) {
      const url = indexes[i];
      if (visited.has(url)) continue;
      visited.add(url);
      const response = await request(url, hosts);
      const html = decodeHtml(response.bytes, response.type);
      if (!/<(?:html|a|body)\b/i.test(html)) throw new Error('来源返回的不是可解析网页');
      if (i === 0 && source.verifyName) {
        const identity = pageData(html, response.url, source);
        if (!`${identity.title} ${identity.text} ${html}`.includes(source.verifyName)) throw new Error('官网名称未通过核验，请人工核对地址');
      }
      for (const link of linksFrom(html, response.url, hosts)) {
        const kind = classifyLink(link);
        if (kind === 'article') articles.set(link.url, link);
        if (kind === 'index' && !indexes.includes(link.url) && indexes.length < 4) { indexes.push(link.url); discoveredIndex = true; }
      }
      await pause(400);
    }
    if (!discoveredIndex && !articles.size) throw new Error('未找到可解析的招聘入口；请核对栏目地址或是否需要脚本渲染');
    let attempted = 0;
    for (const link of [...articles.values()].slice(0, 12)) {
      attempted++;
      try {
        const response = await request(link.url, hosts);
        const html = decodeHtml(response.bytes, response.type);
        const page = pageData(html, response.url, source);
        coverage.articles++;
        if (page.published && daysBetween(today, page.published) > config.lookbackDays) { observedPages.push(page.url); continue; }
        if (!page.published) coverage.warnings.push(`有公告未识别发布日期：${clean(link.title).slice(0, 40)}`);
        const rows = [...page.rows];
        let attachmentFailure = false;
        for (const attachment of page.attachments.slice(0, 3)) {
          if (attachment.format !== 'xlsx') {
            coverage.warnings.push('有PDF或旧版XLS附件需人工核对');
            continue;
          }
          try {
            const file = await request(attachment.url, hosts);
            if (/html/i.test(file.type) || /^\s*(?:<!doctype html|<html)/i.test(file.bytes.subarray(0, 100).toString('utf8'))) {
              throw new Error('附件返回网页或下载验证页，需人工核实');
            }
            rows.push(...await spreadsheetRows(file.bytes));
          } catch (error) { attachmentFailure = true; coverage.warnings.push(`岗位表附件未完成：${error.message}`); }
          await pause(400);
        }
        if (rows.length) {
          rows.forEach((row, index) => { const job = jobFrom(row, page, source, config.profile, index + 1); if (job) jobs.push(job); });
        } else if (imaging.test(page.text)) {
          const job = jobFrom(page.text, page, source, config.profile);
          if (job) jobs.push(job);
        } else if (page.attachments.length) {
          coverage.warnings.push(`公告附件尚不能确认有无影像岗位：${clean(page.title).slice(0, 40)} ${page.url}`);
        }
        if (!attachmentFailure) observedPages.push(page.url);
      } catch (error) { coverage.warnings.push(`有公告读取失败：${error.message}`); }
      await pause(400);
    }
    if (attempted && !coverage.articles) throw new Error('招聘公告均读取失败');
    coverage.ok = true;
  } catch (error) { coverage.error = error.message; }
  coverage.warnings = [...new Set(coverage.warnings)];
  return { jobs, coverage, observedPages };
}

export async function collect(config, today, options) {
  const results = [];
  // Serial sources keep load low and bound memory used by spreadsheets.
  for (const source of config.sources.filter(item => item.enabled !== false)) {
    results.push(await collectSource(source, config, today, options));
  }
  return { jobs: results.flatMap(item => item.jobs), coverage: results.map(item => item.coverage), observedPages: results.flatMap(item => item.observedPages) };
}

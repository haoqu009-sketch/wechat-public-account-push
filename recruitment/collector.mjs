import { clean, imaging, linksFrom, classifyLink, pageData, jobFrom, safeUrl, daysBetween, extractDeadline } from './core.mjs';
import { collectPumchSource } from './pumch.mjs';
import { collectDiscovery } from './discovery.mjs';
import { processAttachments } from './attachment-pipeline.mjs';
import { cachedDownload } from './source-cache.mjs';
export { spreadsheetRows } from './attachments.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function download(url, hosts, fetcher = fetch, limit = 5_000_000) {
  let current = safeUrl(url, url, hosts);
  if (!current) throw new Error('链接不在配置的HTTPS来源范围内');
  const transient = new Set(['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'TimeoutError']);
  let retried = false;
  for (let redirects = 0; redirects <= 4; redirects++) {
    let response, bytes;
    while (true) {
      try {
        response = await fetcher(current, {
          method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000),
          headers: { 'User-Agent': 'MedicalImagingRecruitmentDigest/1.0', Accept: 'text/html,application/xhtml+xml,application/json,application/octet-stream;q=0.8,*/*;q=0.5' },
        });
        // HTTP failures and redirects are handled below; only a transport failure retries.
        if (!response.ok) break;
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
          length += chunk.length;
          if (length > limit) throw Object.assign(new Error('页面或附件超过大小上限'), { code: 'DOWNLOAD_TOO_LARGE' });
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
        break;
      } catch (error) {
        try { await response?.body?.cancel(); } catch { /* The failed stream may already be closed or locked. */ }
        const code = error.cause?.code || error.code || error.name;
        if (code === 'DOWNLOAD_TOO_LARGE') throw new Error('页面或附件超过大小上限');
        if (!retried && transient.has(code)) {
          retried = true;
          await wait(500);
          response = undefined;
          continue;
        }
        const safeCode = /^(?:[A-Z][A-Z0-9_]{0,63}|TimeoutError|AbortError|TypeError|Error)$/.test(String(code)) ? code : 'NETWORK_ERROR';
        throw new Error(`来源连接失败（${safeCode}）`);
      }
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = safeUrl(response.headers.get('location'), current, hosts);
      await response.body?.cancel();
      if (!next) throw new Error('跳转到未配置的域名或非HTTPS地址，请核对来源');
      current = next;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    return { bytes, url: current, type: response.headers.get('content-type') || '' };
  }
  throw new Error('重定向次数过多');
}

export function decodeHtml(bytes, contentType = '') {
  const ascii = bytes.subarray(0, 4096).toString('ascii');
  const charset = contentType.match(/charset\s*=\s*([\w-]+)/i)?.[1]
    || ascii.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  return new TextDecoder(charset).decode(bytes);
}

export async function collectSource(source, config, today, options = {}) {
  const request = options.request || download;
  if (source.type === 'discovery') return collectDiscovery(source, config, today, { ...options, request });
  if (source.type === 'pumch-api') return collectPumchSource(source, config, today, { ...options, request });
  const pause = options.pause || wait;
  const hosts = source.allowedHosts || [new URL(source.url).hostname];
  const coverage = { name: source.name, ok: false, articles: 0, warnings: [], attachments: [] };
  const attachmentBudget = { remaining: 24 };
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
      const links = linksFrom(html, response.url, hosts);
      const next = source.isListing && links.find(link => /^(?:下一页|下页|Next)(?:\s*[>›»])?$/i.test(link.title)
        && new URL(link.url).hostname === new URL(response.url).hostname);
      if (next && !indexes.includes(next.url) && indexes.length < 4) indexes.push(next.url);
      for (const link of links) {
        const kind = classifyLink(link);
        if (kind === 'article') articles.set(link.url, link);
        if (kind === 'index' && !indexes.includes(link.url) && indexes.length < 4) { indexes.push(link.url); discoveredIndex = true; }
      }
      await pause(400);
    }
    if (!discoveredIndex && !articles.size) throw new Error('未找到可解析的招聘入口；请核对栏目地址或是否需要脚本渲染');
    let attempted = 0;
    const articleLinks = [...articles.values()].slice(0, 12);
    const articleOffset = articleLinks.length ? (Math.floor(Date.now() / 14_400_000) * 3) % articleLinks.length : 0;
    // Rotate attachment-budget ownership across notices, not only within a notice.
    for (const link of articleLinks.slice(articleOffset).concat(articleLinks.slice(0, articleOffset))) {
      attempted++;
      try {
        const response = await request(link.url, hosts);
        const html = decodeHtml(response.bytes, response.type);
        const page = pageData(html, response.url, source);
        coverage.articles++;
        // Long-running notices can remain open beyond the publication lookback.
        // Retain only an explicitly parsed future/current application deadline;
        // an undated or vague "long-term" notice does not gain fresh-date evidence.
        const deadlineYear = Number((page.published || today).slice(0, 4));
        const stillOpen = [page.text, ...page.rows].some(text => {
          const deadline = extractDeadline(text, deadlineYear);
          return deadline && deadline >= today;
        });
        if (page.published && daysBetween(today, page.published) > config.lookbackDays && !stillOpen) { observedPages.push(page.url); continue; }
        if (!page.published) coverage.warnings.push(`有公告未识别发布日期：${clean(link.title).slice(0, 40)}`);
        const rows = [...page.rows];
        const parsed = await processAttachments(page, request, hosts, { ...options, pause, budget: attachmentBudget });
        coverage.attachments.push(...parsed.entries);
        if (!parsed.complete) coverage.warnings.push('岗位附件有待处理项目，详见附件清单；PDF纯文字和OCR仅作为线索');
        for (const entry of parsed.entries.filter(item => item.status === 'failed')) {
          const http = entry.reason.match(/HTTP \d+/)?.[0];
          coverage.warnings.push(http ? `岗位表附件未完成：${http}` : entry.reason);
        }
        if (rows.length) {
          rows.forEach((row, index) => { const job = jobFrom(row, page, source, config.profile, index + 1); if (job) jobs.push(job); });
        } else if (!parsed.rows.length && imaging.test(page.text)) {
          const job = jobFrom(page.text, page, source, config.profile);
          if (job) jobs.push(job);
        } else if (parsed.entries.some(entry => entry.purpose !== 'optional') && !parsed.rows.length) {
          coverage.warnings.push(`公告附件尚不能确认有无影像岗位：${clean(page.title).slice(0, 40)} ${page.url}`);
        }
        for (const [index, row] of parsed.rows.entries()) {
          const job = jobFrom(row.text, page, source, config.profile, rows.length + index + 1);
          if (job) jobs.push({ ...job, evidenceUrl: row.url, evidenceLocator: row.locator, attachmentNotes: row.notes, attachmentIncomplete: row.incomplete });
        }
        for (const clue of parsed.clues.slice(0, 8).filter(clue => !parsed.rows.some(row => row.url === clue.url))) {
          const job = jobFrom(clue.text, { ...page, title: `${page.title}｜${clue.locator}`, text: clue.text }, source, config.profile);
          if (job) jobs.push(job);
        }
        if (parsed.complete) observedPages.push(page.url);
      } catch (error) { coverage.warnings.push(`有公告读取失败：${error.message}`); }
      await pause(400);
    }
    if (attempted && !coverage.articles) throw new Error('招聘公告均读取失败');
    coverage.ok = true;
  } catch (error) { coverage.error = error.message; }
  coverage.warnings = [...new Set(coverage.warnings)];
  return { jobs, coverage, observedPages };
}

export async function collect(config, today, options = {}) {
  if (options.cacheDir && !options.request) options = { ...options, request: cachedDownload(options.cacheDir, download) };
  const { collectSource: collectOne = collectSource, onSourceComplete, ...sourceOptions } = options;
  const sources = config.sources.filter(item => item.enabled !== false);
  const results = new Array(sources.length);
  const hostsFor = source => {
    const hosts = new Set();
    try { hosts.add(new URL(source.url).hostname.toLowerCase()); }
    catch { hosts.add('__invalid_source_host__'); }
    for (const host of source.allowedHosts || []) if (typeof host === 'string') hosts.add(host.toLowerCase());
    return hosts;
  };
  const pending = sources.map((source, index) => ({ source, index, hosts: hostsFor(source) }));
  const active = new Map(), busyHosts = new Set();
  let completed = 0, callbackFailed = false;
  const collectEntry = async ({ source, index }) => {
    let result;
    try {
      result = await collectOne(source, config, today, sourceOptions);
      if (!result || !Array.isArray(result.jobs) || !Array.isArray(result.observedPages)
        || !result.coverage || typeof result.coverage.ok !== 'boolean') throw new Error('Invalid source result');
    } catch {
      result = {
        jobs: [], observedPages: [],
        coverage: { name: source.name, ok: false, articles: 0, warnings: [], error: '来源采集未完成（异常详情已隐藏）' },
      };
    }
    results[index] = result;
    completed++;
    if (typeof onSourceComplete === 'function') {
      try {
        await onSourceComplete({
          name: source.name, index, completed, total: sources.length, ok: result.coverage.ok,
          jobCount: result.jobs.length,
          articleCount: Number.isInteger(result.coverage.articles) && result.coverage.articles >= 0 ? result.coverage.articles : 0,
        });
      } catch { callbackFailed = true; }
    }
  };
  // Only distinct declared source hosts may overlap. Internal pages, attachments
  // and their existing polite delays remain sequential inside collectSource.
  while (pending.length || active.size) {
    while (active.size < 2) {
      const next = pending.findIndex(entry => [...entry.hosts].every(host => !busyHosts.has(host)));
      if (next < 0) break;
      const entry = pending.splice(next, 1)[0];
      for (const host of entry.hosts) busyHosts.add(host);
      const task = collectEntry(entry).finally(() => {
        for (const host of entry.hosts) busyHosts.delete(host);
        active.delete(entry.index);
      });
      active.set(entry.index, task);
    }
    // Every task stays in active until completion; no hard timeout abandons work.
    if (active.size) await Promise.race(active.values());
  }
  if (callbackFailed) throw new Error('来源进度回调失败；全部采集任务已结束，异常详情已隐藏');
  return { jobs: results.flatMap(item => item.jobs), coverage: results.map(item => item.coverage), observedPages: results.flatMap(item => item.observedPages) };
}

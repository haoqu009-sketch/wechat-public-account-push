import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const directory = path.dirname(fileURLToPath(import.meta.url));
const bodyLimit = 2_000_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function publicBase(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const labels = url.hostname.split('.');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.search || url.hash) return null;
    if (url.hostname.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
    if (!/[a-z]/i.test(labels.at(-1)) || /(?:^|\.)localhost$/i.test(url.hostname)) return null;
    // Reject ambiguous path separators/traversal rather than silently changing a base.
    const rawPath = value.replace(/^https:\/\/[^/]+/i, '');
    if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname) || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(rawPath)) return null;
    return url.href.replace(/\/+$/, '');
  } catch { return null; }
}

async function responseJson(response, requestedUrl, limit) {
  if (response.redirected || (response.url && response.url !== requestedUrl)) throw Object.assign(new Error('响应地址未通过核验'), { permanent: true });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* The response may already be closed. */ }
    throw Object.assign(new Error('网站响应未成功'), { permanent: response.status >= 300 && response.status < 500 });
  }
  const advertised = response.headers.get('content-length');
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) {
    try { await response.body?.cancel(); } catch { /* A closed response is already bounded. */ }
    throw new Error('网站响应超过上限');
  }
  const chunks = [];
  let length = 0;
  if (!response.body) throw new Error('网站响应为空');
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > limit) throw new Error('网站响应超过上限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validReport(report) {
  return report && typeof report === 'object' && !Array.isArray(report)
    && report.schemaVersion === 1 && /^[a-f0-9]{24}$/.test(report.reportId || '')
    && /^20\d{2}-\d{2}-\d{2}$/.test(report.reportDate || '') && typeof report.generatedAt === 'string'
    && report.summary && typeof report.summary === 'object' && !Array.isArray(report.summary)
    && Array.isArray(report.jobs) && Array.isArray(report.sources);
}

export async function publishWeb(env = process.env, services = {}) {
  const readFile = services.readFile || fs.readFile;
  const fetcher = services.fetch || fetch;
  const wait = services.pause || pause;
  const warnings = [];
  const warn = message => { warnings.push(message); (services.warn || console.warn)(message); };
  const stateDir = env.RECRUITMENT_STATE_DIR || path.join(directory, '../.recruitment-state');
  const reportDir = env.RECRUITMENT_REPORT_DIR || path.join(stateDir, 'reports');
  const output = services.output || (async (name, value) => {
    if (env.GITHUB_OUTPUT) await fs.appendFile(env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
  });

  let fallback = null;
  const repository = env.GITHUB_REPOSITORY;
  const parts = typeof repository === 'string' ? repository.split('/') : [];
  if (parts.length === 2 && /^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(parts[0])
    && /^[a-z0-9_.-]{1,100}$/i.test(parts[1]) && !['.', '..'].includes(parts[1])) {
    let revision = 'recruitment-state';
    try {
      const metadata = JSON.parse(await readFile(path.join(stateDir, '.sync.json'), 'utf8'));
      if (!/^[a-f0-9]{40}$/i.test(metadata?.sha || '')) throw new Error('缺少提交标识');
      revision = metadata.sha;
    } catch { warn('GitHub报告提交标识不可用，备用详情将使用状态分支链接。'); }
    fallback = `https://github.com/${repository}/blob/${revision}/reports/latest.md`;
  } else warn('GitHub仓库标识未配置或无效，无法生成安全的备用详情链接。');

  let reportUrl = fallback, published = false, reportId = null;
  const configuredBase = env.RECRUITMENT_PUBLIC_BASE_URL;
  const token = env.RECRUITMENT_SITE_SYNC_TOKEN;
  if (!configuredBase && !token) warn('招聘网站同步未配置，详情将继续使用GitHub备用报告；未访问网站。');
  else if (!configuredBase || !token) warn('招聘网站同步配置不完整，详情将继续使用GitHub备用报告；未访问网站。');
  else {
    const base = publicBase(configuredBase);
    if (!base || typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token)) {
      warn('招聘网站地址或同步凭据格式无效，详情将使用GitHub备用报告；未访问网站。');
    } else {
      try {
        const body = await readFile(path.join(reportDir, 'public.json'), 'utf8');
        if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > bodyLimit) throw new Error('公共报告大小无效');
        const report = JSON.parse(body);
        if (!validReport(report)) throw new Error('公共报告结构无效');
        const endpoint = `${base}/api/sync`;
        const response = await fetcher(endpoint, {
          method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000), cache: 'no-store',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Cache-Control': 'no-store' },
          body,
        });
        const acknowledgment = await responseJson(response, endpoint, 64 * 1024);
        if (acknowledgment?.reportId !== report.reportId) throw new Error('同步标识未匹配');
        const dataUrl = `${base}/data/public.json?report=${report.reportId}`;
        let verified = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const readback = await fetcher(dataUrl, {
              method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000), cache: 'no-store',
              headers: { Accept: 'application/json', 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache' },
            });
            const visible = await responseJson(readback, dataUrl, bodyLimit);
            if (isDeepStrictEqual(visible, report)) { verified = true; break; }
          } catch (error) { if (error?.permanent) break; }
          if (attempt < 2) await wait(500);
        }
        if (!verified) throw new Error('公开数据回读未匹配');
        reportUrl = `${base}/?report=${report.reportId}`;
        reportId = report.reportId;
        published = true;
      } catch {
        // A response or exception may contain credentials and request URLs. Never log it.
        warn('招聘网站同步或公开数据回读核验失败，详情已回退GitHub报告；不会使用网站旧数据。');
      }
    }
  }
  if (reportUrl) {
    try { await output('report_url', reportUrl); }
    catch { throw new Error('详情链接写入工作流输出失败'); }
  }
  return { reportUrl, reportId, published, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishWeb().then(result => {
    if (!result.reportUrl) process.exitCode = 1;
    else console.log(result.published ? '网站公共报告已同步并完成回读核验。' : '详情已使用GitHub备用报告。');
  }).catch(() => { console.error('招聘详情发布未完成，停止以免使用错误链接。'); process.exitCode = 1; });
}

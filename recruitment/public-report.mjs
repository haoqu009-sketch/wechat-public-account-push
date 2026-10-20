import { chinaDate, hash, planDigest, rankJobs, daysBetween, publicationDateFromText } from './core.mjs';

const text = (value, limit = 240) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const strings = (value, limit = 12) => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, limit).map(item => text(item)).filter(Boolean) : [];
function date(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function publicUrl(value, hosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hosts.has(url.hostname)) return null;
    if ([...url.searchParams.keys()].some(key => /^(?:access_token|token|secret|key|api_key|signature|authorization)$/i.test(key))) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(?:utm_.+|from|spm|source)$/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

// Never export a raw error, request URL or arbitrary diagnostic object.
function publicWarning(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (/附件|PDF|XLS/i.test(value)) return '部分附件尚未完整解析，请核对官方公告附件';
  if (/发布日期/.test(value)) return '部分公告的发布日期尚未识别';
  if (/历史|有界|最多|未检查|未覆盖/.test(value)) return '本次只检查部分公告，尚未覆盖全部历史信息';
  if (/读取失败|HTTP|网络|连接|超时/i.test(value)) return '部分公告或附件读取失败，请核对官方页面';
  return '存在尚待人工核实的采集内容';
}

export function createPublicReport({ jobs, digest, coverage, config, generatedAt = new Date().toISOString() }) {
  const instant = new Date(generatedAt);
  if (!Number.isFinite(instant.getTime())) throw new Error('公共报告生成时间无效');
  const reportDate = date(digest?.today);
  if (!reportDate || reportDate !== chinaDate(instant)) throw new Error('公共报告必须使用当天采集日期');
  if (!Array.isArray(jobs) || !Array.isArray(coverage) || !Array.isArray(config?.sources)) throw new Error('公共报告需要岗位、来源及配置数据');
  const generated = instant.toISOString();
  const configuredSources = config.sources.filter(source => source.enabled !== false);
  const hosts = new Set();
  for (const source of configuredSources) {
    try {
      const url = new URL(source.url);
      if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')) hosts.add(url.hostname);
    } catch { /* Invalid source URLs cannot become public official links. */ }
    for (const host of source.allowedHosts || []) if (typeof host === 'string') hosts.add(host);
  }
  for (const authority of config.verification?.authorities || []) for (const host of authority.hosts || []) hosts.add(host);
  const sources = configuredSources.map(source => {
    const result = coverage.find(item => item?.name === source.name);
    const ok = result?.ok === true;
    return {
      id: text(source.id, 80), name: text(source.name, 140), province: text(source.province, 40),
      url: publicUrl(source.url, hosts), ok,
      articles: Number.isInteger(result?.articles) && result.articles >= 0 ? result.articles : 0,
      warnings: [...new Set((Array.isArray(result?.warnings) ? result.warnings : []).map(publicWarning).filter(Boolean))],
      error: ok ? null : result ? '本次来源检查未完成，请核对官方页面' : '本次尚未检查该来源',
    };
  });
  const sourceHealth = new Map(sources.map(source => [source.name, source.ok]));
  const lookbackDays = Number.isInteger(config.lookbackDays) && config.lookbackDays >= 0 ? config.lookbackDays : 90;
  const candidates = jobs.map(job => {
    if (!job || typeof job !== 'object') return job;
    const published = date(job.published) || publicationDateFromText(job.announcementText || '');
    return published ? { ...job, published } : job;
  }).filter(job => job && typeof job === 'object' && typeof job.id === 'string'
    && typeof job.title === 'string' && typeof job.organization === 'string'
    && ['physician', 'technician', 'clue'].includes(job.role) && publicUrl(job.url, hosts)
    && (job.deadline == null || date(job.deadline))
    && (!date(job.published) || (daysBetween(reportDate, job.published) >= 0
      && (daysBetween(reportDate, job.published) <= lookbackDays || (date(job.deadline) && job.deadline >= reportDate)))));
  // Use an empty delivery history and no notification caps: the website is an active-job
  // catalogue, independent of whether a recipient already received each job.
  const complete = planDigest(candidates, { sent: {}, reminded: {} }, {
    ...config, maxPhysicians: Number.MAX_SAFE_INTEGER, maxTechnicians: Number.MAX_SAFE_INTEGER, maxReminders: Number.MAX_SAFE_INTEGER,
  }, reportDate);
  const newIds = new Set([...(digest.physicians || []), ...(digest.technicians || [])].map(job => job.id));
  const reminderIds = new Set((digest.reminders || []).map(job => job.id));
  const project = job => {
    const sourceName = text(job.sourceName || job.organization, 140);
    const collectedAt = date(job.collectedAt);
    const verifiedToday = job.verification?.officialUrl && job.verification?.checkedAt?.slice(0, 10) === generated.slice(0, 10)
      && ['matched', 'partial', 'mismatch'].includes(job.verification.state);
    const sourceHealthy = verifiedToday || sourceHealth.get(sourceName) === true;
    const verification = job.verification && {
      version: 1, checkedAt: job.verification.checkedAt, state: job.verification.state,
      summary: text(job.verification.summary, 600), officialUrl: publicUrl(job.verification.officialUrl, hosts),
      issues: strings(job.verification.issues, 12),
      evidence: (job.verification.evidence || []).slice(0, 12).flatMap(item => {
        const url = publicUrl(item.url, hosts);
        return url ? [{ field: text(item.field, 40), value: text(item.value), quote: text(item.quote, 600), url, locator: text(item.locator, 100) }] : [];
      }),
      attempts: (job.verification.attempts || []).slice(0, 8).flatMap(item => {
        const url = publicUrl(item.url, hosts);
        return url ? [{ url, result: item.result, reason: text(item.reason) }] : [];
      }),
    };
    return {
      id: text(job.id, 100), title: text(job.title, 160), organization: text(job.organization, 160),
      sourceName, province: text(job.province, 40), role: job.role, status: job.status === 'priority' ? 'priority' : 'review',
      priorityLabel: text(job.priorityLabel), focusMatch: ['ct', 'mixed', 'other', 'unknown'].includes(job.focusMatch) ? job.focusMatch : 'unknown',
      directionLabel: text(job.directionLabel), qualityReasons: strings(job.qualityReasons),
      degreeRequirement: text(job.degreeRequirement), specialtyRequirement: text(job.specialtyRequirement), headcount: text(job.headcount, 80),
      conditionExcerpt: text(job.conditionExcerpt, 800), announcementTitle: text(job.announcementTitle, 200), announcementText: text(job.announcementText, 1200),
      matches: strings(job.matches), requirements: strings(job.requirements), structured: job.structured === true,
      url: publicUrl(job.url, hosts), published: date(job.published), deadline: date(job.deadline), collectedAt,
      sourceHealthy: Boolean(sourceHealthy), stale: !sourceHealthy || (!verifiedToday && collectedAt !== reportDate),
      isNew: job.role !== 'clue' && newIds.has(job.id), isReminder: job.role !== 'clue' && reminderIds.has(job.id),
      ...(verification ? { verification } : {}),
    };
  };
  const publicJobs = rankJobs([...complete.physicians, ...complete.technicians], config, reportDate).map(project);
  const audit = candidates.filter(job => ['blocked', 'mismatch'].includes(job.verification?.state));
  const leads = [...rankJobs(candidates.filter(job => job.role === 'clue' || job.sourceKind === 'aggregator'), config, reportDate)
    .filter(job => job.role === 'clue'), ...audit].filter((job, index, values) => values.findIndex(item => item.id === job.id) === index)
    .slice(0, 300).map(job => project({ ...job, role: 'clue', status: 'review' }));
  const sourceSuccessCount = sources.filter(source => source.ok).length;
  const limitations = ['仅覆盖已配置且可读取的官方及聚合来源，未收录不代表没有招聘；具体资格与报名状态以官方公告为准。'];
  if (leads.length) limitations.push(`另列${leads.length}条待核实招聘线索，不计入医师或技师岗位；平台转载不代表官方已核验或确认可报名。`);
  if (sourceSuccessCount < sources.length) limitations.push(`${sources.length - sourceSuccessCount}个来源本次未完成检查，来源覆盖不完整。`);
  if (sources.some(source => source.warnings.length)) limitations.push('部分公告或附件尚待核实，请查看来源状态并核对原文。');
  if (publicJobs.some(job => job.stale)) limitations.push('部分岗位来自此前采集记录或本次不可用来源，请核对采集日期及最新公告。');
  if (publicJobs.some(job => !job.deadline)) limitations.push('部分岗位未识别明确截止日期，仅作为待核实线索，不能据此确认仍可报名。');
  const summary = {
    newCount: publicJobs.filter(job => job.isNew).length, activeCount: publicJobs.length,
    physicianCount: publicJobs.filter(job => job.role === 'physician').length,
    technicianCount: publicJobs.filter(job => job.role === 'technician').length,
    reminderCount: publicJobs.filter(job => job.isReminder).length,
    sourceSuccessCount, sourceTotalCount: sources.length, limitations,
  };
  const content = { schemaVersion: 1, reportDate, generatedAt: generated, summary, jobs: publicJobs, sources, leads };
  return { schemaVersion: 1, reportId: hash(JSON.stringify(content)), reportDate, generatedAt: generated, summary, jobs: publicJobs, sources, leads };
}

import { clean, imaging, pageData, jobFrom, daysBetween, hash, extractDeadline } from './core.mjs';

// These routes and pageNum/pageSize are used by the hospital's public Vue pages.
// app.fdfab2c7.js: PositionList -> /page/search-detail?jobId=... (history mode).
const API = '/prod-api/api/v1/job/';
const bounded = (value, fallback, ceiling) => Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateOf = value => {
  const date = typeof value === 'string' ? value.slice(0, 10) : '';
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().startsWith(date) ? date : null;
};
const schemaError = message => Object.assign(new Error(message), { schema: true });

export async function collectPumchSource(source, config, today, options = {}) {
  const jobs = [], observedPages = [];
  const coverage = { name: source.name, ok: false, articles: 0, warnings: [] };
  const hosts = source.allowedHosts || [new URL(source.url).hostname];
  const request = options.request;
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxPages = bounded(source.maxApiPages, 3, 3);
  const maxDetails = bounded(source.maxApiDetails, 12, 12);
  let structureFailure = false, detailFailures = 0;
  const publicUrl = id => new URL(`/page/search-detail?${new URLSearchParams({ jobId: id })}`, source.url).href;
  const json = async url => {
    const response = await request(url, hosts);
    let payload;
    try { payload = JSON.parse(response.bytes.toString('utf8')); }
    catch { throw schemaError('公开招聘接口未返回有效JSON'); }
    if (!payload || payload.code !== 200) throw schemaError('公开招聘接口业务状态异常');
    return payload;
  };
  try {
    if (typeof request !== 'function') throw new Error('公开接口采集缺少受限下载函数');
    if (new URL(source.url).origin !== 'https://jobs.pumch.cn') throw new Error('协和公开接口仅支持已核验的官方HTTPS地址');
    const notices = new Map();
    let total = 0, read = 0, complete = false;
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const url = new URL(`${API}list`, source.url);
      url.search = new URLSearchParams({ pageNum: String(pageNum), pageSize: '10' }).toString();
      const payload = await json(url.href);
      if (!Array.isArray(payload.rows) || !Number.isInteger(payload.total) || payload.total < 0) throw schemaError('公开招聘列表缺少rows数组或有效total');
      if (payload.rows.some(row => !row || typeof row.jobId !== 'string' || !row.jobId.trim() || typeof row.jobName !== 'string' || !row.jobName.trim())) throw schemaError('公开招聘列表包含无法识别的公告');
      total = payload.total;
      if (!payload.rows.length && read < total) throw schemaError('公开招聘列表分页提前返回空结果');
      const previous = notices.size;
      for (const row of payload.rows) notices.set(row.jobId, row);
      read += payload.rows.length;
      if (payload.rows.length && notices.size === previous) throw schemaError('公开招聘接口未正确返回不同分页');
      if (read >= total) { complete = true; break; }
      await pause(400);
    }
    if (!complete) coverage.warnings.push(`公开接口共有${total}篇公告，本次有界检查前${notices.size}篇，未覆盖全部历史公告`);
    const recent = [...notices.values()].filter(info => {
      const published = dateOf(info.upTime) || dateOf(info.timeCreated) || dateOf(info.createTime);
      const deadline = dateOf(info.timeEnd);
      return !published || daysBetween(today, published) <= config.lookbackDays || (deadline && deadline >= today);
    });
    if (recent.length > maxDetails) coverage.warnings.push(`近期公告${recent.length}篇，本次最多读取${maxDetails}篇详情，其余尚未检查`);
    for (const notice of recent.slice(0, maxDetails)) {
      try {
        const endpoint = new URL(`${API}getJobInfo`, source.url);
        endpoint.search = new URLSearchParams({ jobId: notice.jobId, type: '' }).toString();
        const payload = await json(endpoint.href);
        const info = payload.data?.thrJobinfo;
        const positions = payload.data?.thrJobpositionList;
        if (!info || info.jobId !== notice.jobId || typeof info.jobName !== 'string' || typeof info.require !== 'string' || !Array.isArray(positions)) throw schemaError('公开招聘详情缺少公告正文或岗位数组');
        if (positions.some(row => !row || typeof row !== 'object' || typeof row.jobPosition !== 'string' || typeof row.positionId !== 'string' || !row.positionId.trim())) throw schemaError('公开岗位数组包含无法识别的岗位');
        const published = dateOf(info.upTime) || dateOf(info.timeCreated) || dateOf(info.createTime);
        const url = publicUrl(info.jobId);
        const page = pageData(`<html><head><title>${escapeHtml(info.jobName)}</title></head><body><h1>${escapeHtml(info.jobName)}</h1><article>${info.require}</article></body></html>`, url, source);
        page.published = published;
        coverage.articles++;
        if (!published) coverage.warnings.push(`公告未提供可识别发布日期：${clean(info.jobName).slice(0, 40)}`);
        if (info.fileName) coverage.warnings.push(`公告含附件需人工核对：${clean(info.fileContent || info.jobName).slice(0, 60)} ${url}`);
        for (const [index, position] of positions.entries()) {
          // Scope eligibility to the actual position, never the whole hospital's other openings.
          const role = clean([position.department, position.jobPosition, position.specialtyNorm].filter(Boolean).join('｜'));
          if (!imaging.test(role)) continue;
          const degree = clean(position.educationNorm);
          const readableDegree = /博士|硕士|本科|学士|专科|中专|高中|不限/.test(degree) ? degree : '';
          const text = [
            `岗位代码：${clean(position.positionId)}`, `岗位名称：${role}`,
            `专业：${clean(position.specialtyNorm)}`, `学历/学位：${readableDegree}`,
            `人数：${position.number == null ? '' : clean(position.number)}`,
            `条件：${clean([position.otherNorm, position.workDesc, position.specialRequirement, position.workYear].filter(Boolean).join('；'))}`,
          ].join('；');
          const job = jobFrom(text, page, source, config.profile, index + 1);
          if (!job) continue;
          const deadlineYear = Number((published || today).slice(0, 4));
          // A position may explicitly close before the overall announcement.
          job.deadline = extractDeadline(text, deadlineYear)
            || dateOf(info.timeEnd)
            || extractDeadline(page.text, deadlineYear);
          job.fingerprint = hash(JSON.stringify({ text, deadline: job.deadline, title: page.title, announcement: page.text }));
          job.announcementTitle = info.jobName;
          job.announcementText = page.text;
          job.requirements.push('另需核对整篇公告中的统一报名资格与届别限制');
          if (degree && !readableDegree) job.requirements.push('官网学历字段为代码，具体学历要求需打开岗位详情核对');
          jobs.push(job);
        }
        if (!positions.length && imaging.test(`${info.jobName} ${page.text}`)) {
          const job = jobFrom(page.text, page, source, config.profile);
          if (job) {
            job.deadline = dateOf(info.timeEnd) || job.deadline;
            job.fingerprint = hash(JSON.stringify({ text: page.text, deadline: job.deadline, title: page.title }));
            jobs.push(job);
          }
        }
        observedPages.push(url);
      } catch (error) {
        structureFailure ||= Boolean(error.schema);
        detailFailures++;
        coverage.warnings.push(`有公告读取失败：${error.message}`);
      }
      await pause(400);
    }
    if (structureFailure) throw new Error('部分公开招聘详情结构异常，来源检查未完整通过');
    if (detailFailures && !coverage.articles) throw new Error('公开招聘详情均读取失败');
    coverage.ok = true;
  } catch (error) { coverage.error = error.message; }
  coverage.warnings = [...new Set(coverage.warnings)];
  return { jobs, coverage, observedPages };
}

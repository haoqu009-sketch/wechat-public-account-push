import { load } from 'cheerio';
import { clean, safeUrl, pageData, jobFrom, datesIn } from './core.mjs';
import { commonConditions } from './conditions.mjs';
import { spreadsheetRows, pdfText } from './attachments.mjs';

const unique = values => [...new Set(values.filter(Boolean))];
const normal = value => clean(value).replace(/\s|[｜|（）()、，,；;：:]/g, '');
const position = value => normal(value).replace(/医学影像|放射医学影像|放射影像/g, '影像').replace(/(?:科|中心|岗位|工作人员|医技医辅系统各科室|如)/g, '').replace(/医生/g, '医师');
const unsupported = /^(?:localhost|.*\.localhost)$|^\d+\.|:/;

export function verificationAuthorities(config) {
  const authorities = (config.sources || []).filter(source => source.sourceKind !== 'aggregator' && source.type !== 'discovery')
    .map(source => ({ ...source, hosts: source.allowedHosts || [new URL(source.url).hostname], original: !source.isRepost && source.sourceKind !== 'university-repost' }));
  for (const source of config.verification?.authorities || []) authorities.push({ ...source, hosts: source.hosts || [], original: true });
  return authorities.filter(source => source.hosts.length && source.hosts.every(host => /^[a-z0-9.-]+$/i.test(host) && !unsupported.test(host)));
}

export function officialReferences(html, base, authorities) {
  const hosts = authorities.filter(item => item.original).flatMap(item => item.hosts);
  const $ = load(html), urls = [];
  $('a[href]').each((_, node) => {
    const anchor = $(node), label = clean(anchor.text());
    const url = safeUrl(anchor.attr('href'), base, hosts);
    if (url && /来源|原文|公告|招聘|详情|https?:/i.test(label) && !/\.(?:docx?|xlsx?|pdf|png|jpg)(?:\?|$)/i.test(url)) urls.push(url);
  });
  const text = clean($('body').text());
  for (const match of text.matchAll(/(?:来源(?:链接)?|原文(?:链接)?)[：:\s]*(https:\/\/[^\s<>"'，。；]+)/g)) {
    const url = safeUrl(match[1], base, hosts); if (url) urls.push(url);
  }
  return unique(urls).slice(0, 4);
}

// Matching never accepts "mentions CT" as a position. Employer, role, code and
// specialty discrepancies reject the candidate; ties require review rather than guessing.
export function matchOfficialRows(original, candidates) {
  const roleHint = /技师|技术岗/.test(original.title) ? 'technician' : /医师|医生/.test(original.title) ? 'physician' : null;
  const distinct = [...new Map(candidates.map(candidate => [JSON.stringify([candidate.title, candidate.conditionExcerpt, candidate.positionCode]), candidate])).values()];
  const scored = distinct.map(candidate => {
    if (roleHint && candidate.role !== roleHint) return null;
    if (original.positionCode && candidate.positionCode && original.positionCode !== candidate.positionCode) return null;
    if (original.employerExplicit && candidate.employerExplicit && normal(original.employerExplicit) !== normal(candidate.employerExplicit)) return null;
    const knownEmployer = normal((original.organization || '').split(/[（(]/)[0]).replace(/^(?:黑龙江省|广东省|四川省|湖北省|陕西省|湖南省)/, '');
    if (/医院$/.test(knownEmployer) && candidate.employerExplicit && !normal(candidate.employerExplicit).includes(knownEmployer)) return null;
    if (original.focusMatch === 'other' && candidate.focusMatch !== 'other') return null;
    if (/超声/.test(original.title) !== /超声/.test(candidate.title) && /超声/.test(original.title + candidate.title)) return null;
    const a = position(original.title), b = position(candidate.title);
    let score = original.positionCode && original.positionCode === candidate.positionCode ? 30 : 0;
    if (a === b) score += 10;
    else if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) score += 7;
    if (original.specialtyRequirement && candidate.specialtyRequirement && normal(original.specialtyRequirement) === normal(candidate.specialtyRequirement)) score += 5;
    if (roleHint && candidate.role === roleHint) score += 1;
    return score >= 7 ? { candidate, score } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score);
  if (!scored.length) return { job: null, reason: '已读取公告，但尚未定位到与这条线索唯一对应的具体岗位行' };
  if (scored.length > 1 && scored[0].score === scored[1].score) return { job: null, reason: '存在多个相近岗位，不能唯一对应；需要岗位代码或更明确的科室条件' };
  return { job: scored[0].candidate, reason: '' };
}

function evidence(field, value, quote, url, locator) {
  return { field, value: clean(value).slice(0, 240), quote: clean(quote).slice(0, 600), url, locator: clean(locator).slice(0, 100) };
}

export function evaluateOfficialJob(job, page, profile, today, { checkedAt = new Date().toISOString(), original = true, locator = '官方网页岗位表' } = {}) {
  const common = commonConditions(page, profile), proofs = [], issues = [], mismatches = [];
  const row = job.conditionExcerpt || '', rowUrl = job.evidenceUrl || page.url;
  const add = (field, value, quote, scope = locator, url = rowUrl) => { if (quote) proofs.push(evidence(field, value, quote, url, scope)); };
  const scoped = job.commonEvidence?.cohort;
  if (job.qualificationEvidence?.graduationYear === profile.graduationYear) add('cohort', `${profile.graduationYear}届在招聘范围内`, scoped?.quote || row, scoped?.scope || locator, scoped?.scope === '公告统一条件' ? page.url : rowUrl);
  else issues.push(`原文尚未明确${profile.graduationYear}届是否可报；已取得学历的往届人员可报不等于未毕业人员可报`);
  if (job.qualificationEvidence?.masters) add('degree', '学历层级包含硕士', job.degreeRequirement, job.commonEvidence?.degree === job.degreeRequirement ? '公告统一条件' : locator);
  else issues.push(job.degreeRequirement ? `学历原文为“${clean(job.degreeRequirement).slice(0, 70)}”，尚不能确认硕士符合` : '未取得该岗位明确学历要求');
  if (['physician', 'technician'].includes(job.role)) add('role', job.role === 'physician' ? '医师岗位' : '技师岗位', row);
  else issues.push('原文仅写专技或科室名称，尚未明确医师/技师职业类别');
  if (job.specialtyRequirement) {
    add('specialty', job.specialtyRequirement, job.specialtyRequirement);
    if (profile.specialty && !job.specialtyRequirement.includes(profile.specialty) && /医学类|专业类|研究生.*专业/.test(job.specialtyRequirement)) issues.push('专业按宽口径医学类别列示，需用本人研究生专业名称或代码确认归属');
  }
  else issues.push('未取得该岗位专业或专业代码要求');
  const degreeTypeText = [job.degreeRequirement, ...row.split('；').filter(value => /^(?:学位类型|学位要求|培养类型|培养方式)[：:]/.test(value))].filter(Boolean).join('；');
  const professionalOnly = /专硕|专业型|专业学位/.test(degreeTypeText) && !/学硕|学术|或|优先/.test(degreeTypeText);
  const academicOnly = /学硕|学术型|学术学位/.test(degreeTypeText) && !/专硕|专业型|专业学位|或|优先/.test(degreeTypeText);
  if (professionalOnly || academicOnly) {
    add('degreeType', professionalOnly ? '原文要求专业学位硕士' : '原文要求学术学位硕士', degreeTypeText);
    if (!profile.degreeType) issues.push('原文限制硕士学位类型，个人学硕/专硕信息尚未提供');
    else if ((professionalOnly && profile.degreeType === '学硕') || (academicOnly && profile.degreeType === '专硕')) mismatches.push('原文硕士学位类型要求与已提供的学位类型不符');
  }
  if (/全日制/.test(row)) issues.push('原文有全日制要求，个人培养方式尚未提供');
  if (/本科(?:阶段|所学)?专业|本科(?:学历|院校).{0,8}(?:须|需|要求)|本科.{0,15}(?:须|需|要求).{0,10}专业/.test(row)) issues.push('原文限制本科专业或学历，个人本科条件尚未提供');
  if (/专业代码|[AB]\d{5}|10\d{4}/.test(job.specialtyRequirement || '')) issues.push('岗位有专业代码要求，需与本人毕业证专业及代码逐项比对');
  const residency = row.match(/[^；。;]{0,50}(?:规培|规范化培训)[^；。;]{0,90}/)?.[0];
  if (residency) { add('residency', /优先/.test(residency) ? '规培完成者优先，非直接排除条件' : '原文有规培要求', residency); if (!/优先/.test(residency) && /规培专业|培训专业|培训.{0,12}(?:方向|专业须|专业需|专业应)/.test(residency)) issues.push('规培要求涉及专业方向，需与本人合格证专业一致'); }
  const certificate = row.match(/[^；。;]{0,35}(?:执业医师|医师资格|医师执业)[^；。;]{0,80}/)?.[0];
  if (certificate) { add('certificate', '原文有医师资格或执业要求', certificate); if (/执业注册|执业证/.test(certificate)) issues.push('已有医师资格证不等于已完成执业注册，需核对注册要求'); }
  const age = row.match(/[^；。;]{0,25}(?:周岁|年龄)[^；。;]{0,65}/)?.[0]
    || clean(page.commonText).match(/(?:年龄(?:要求|条件)?[：:]?|年龄应|年龄为)[^。；;]{0,90}(?:周岁|岁)[^。；;]{0,30}/)?.[0];
  if (age) {
    const ageText = age.replace(/[（(]含[）)]/g, '');
    const maximum = Number(ageText.match(/(?:不超过|未满|≤)(\d{2})\s*(?:周)?岁/)?.[1] || ageText.match(/(\d{2})\s*周岁\s*(?:以下|以内|及以下)/)?.[1] || 0);
    const cutoffYear = Number(age.match(/(19\d{2}|20\d{2})\s*年.{0,15}(?:以后|之后|及以后|及之后)出生/)?.[1] || 0);
    const largestAge = Number(today.slice(0, 4)) - profile.birthYear, smallestAge = largestAge - 1;
    if (profile.birthYear && ((maximum && largestAge < maximum) || (cutoffYear && profile.birthYear > cutoffYear))) add('age', '按已提供的出生年份，可确认符合原文基础年龄上限', age);
    else if (profile.birthYear && maximum && smallestAge > maximum) { add('age', '按出生年份已超过原文基础年龄上限，例外放宽另核', age); mismatches.push('按已提供的出生年份，超过原文基础年龄上限；尚无适用放宽条件的证据'); }
    else { add('age', '原文有年龄限制，尚不能确定个人是否符合', age); issues.push(profile.birthYear ? '年龄处于界限附近或条件不够明确，需要完整生日及公告计算口径' : '个人年龄未提供，需对照年龄条件'); }
  }
  const experience = row.match(/[^；。;]{0,35}(?:\d+年|[三五十]年).{0,15}(?:工作|经历)|[^；。;]{0,25}(?:工作经验|工作经历)[^；。;]{0,50}/)?.[0];
  if (experience) { add('experience', '有工作经历要求', experience); issues.push('工作年限尚未提供，需对照原文；规培经历不自动计作工作年限'); }
  if (job.deadline) {
    const quote = [...(common.registration || []), ...page.text.split(/[。；;]/)].find(value => /报名|截止|发送/.test(value) && datesIn(value, Number(today.slice(0, 4))).includes(job.deadline));
    if (quote) add('application', `已识别截止日期 ${job.deadline}`, quote, '公告报名安排', page.url);
    else issues.push('截止日期有解析结果，但尚未定位可展示的原文证据');
    if (job.deadline < today) mismatches.push(`报名已于${job.deadline}截止`);
  }
  else if (common.application) add('application', '招满即止；不代表当前仍有空缺', common.application, '公告报名安排', page.url);
  else issues.push('未取得明确报名截止或持续招聘安排');
  if (common.certificateDeadline) {
    add('graduationDeadline', `取得毕业证的期限：${common.certificateDeadline.date}`, common.certificateDeadline.quote, '公告统一条件', page.url);
    if (Number(common.certificateDeadline.date.slice(0, 4)) < profile.graduationYear) mismatches.push(`公告要求${common.certificateDeadline.date}前取得毕业证，与${profile.graduationYear}届尚未毕业的情况冲突`);
  }
  if (common.studentExclusion && common.studentExclusion.year < profile.graduationYear) {
    const reason = `原文不接收在读非${common.studentExclusion.year}届毕业生，与${profile.graduationYear}届在读情况冲突`;
    mismatches.push(reason); add('cohort', reason, common.studentExclusion.quote, '公告不得报考情形', page.url);
  }
  if (common.currentCertificate && !job.qualificationEvidence?.graduationYear) { add('graduationDeadline', '报名须提供毕业证，未明确允许应届生替代材料', common.currentCertificate, '公告报名材料', page.url); issues.push('报名要求提供毕业证；未看到允许2027届使用学籍材料替代的依据'); }
  if (job.excluded) mismatches.push(job.excluded);
  if (!original) issues.unshift('当前为高校等转载页，尚未取得用人单位或主管部门原始公告');
  const result = mismatches.length ? 'mismatch' : !original || !job.structured ? 'blocked' : issues.length ? 'partial' : 'matched';
  return {
    version: 1, checkedAt, state: result, officialUrl: original ? page.url : null,
    summary: result === 'mismatch' ? mismatches[0] : result === 'matched' ? '已知关键条件有原文依据，值得关注；最终资格仍由招聘方审核' : result === 'partial' ? `已核对原文，剩余${unique(issues).length}项具体问题` : '已读取相关内容，但尚未完成原始岗位核验',
    issues: unique([...mismatches, ...issues]).slice(0, 12), evidence: proofs.slice(0, 12), attempts: [],
  };
}

function decode(response) {
  const hint = response.type?.match(/charset\s*=\s*([\w-]+)/i)?.[1] || response.bytes.subarray(0, 4096).toString('ascii').match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  return new TextDecoder(hint).decode(response.bytes);
}

export async function verifyJobs(jobs, config, today, options = {}) {
  const authorities = verificationAuthorities(config), allHosts = unique(authorities.flatMap(authority => authority.hosts));
  const request = options.request, cache = new Map(), documents = new Map(), blockedHosts = new Set();
  const settings = config.verification || {}, checkedAt = options.checkedAt || new Date().toISOString();
  let fetched = 0;
  const fetchOne = (url, hosts) => {
    if (!cache.has(url)) cache.set(url, (async () => {
      if (blockedHosts.has(new URL(url).hostname)) throw new Error('该来源本轮已返回403/429，停止后续请求');
      if (++fetched > (settings.maxRequests || 60)) throw new Error('本轮核验请求预算已用尽，排队下轮处理');
      try { return await request(url, hosts); }
      catch (error) { if (/HTTP (403|429)/.test(error.message)) blockedHosts.add(new URL(url).hostname); throw error; }
    })());
    return cache.get(url);
  };
  const loadOfficial = async (url, authority) => {
    if (!documents.has(url)) documents.set(url, (async () => {
      const response = await fetchOne(url, authority.hosts), html = decode(response);
      const page = pageData(html, response.url, { ...authority, url, allowedHosts: authority.hosts });
      if ((page.text.length < 80 && !page.rows.length && !page.attachments.length) || /人机验证|安全验证|页面不存在|开启JavaScript/.test(page.title)) throw new Error('原始公告返回验证页或无有效正文');
      const source = { ...authority, name: authority.name, province: authority.province || '', sourceKind: 'official-publisher', isRepost: !authority.original };
      const rows = page.rows.map((row, index) => jobFrom(row, page, source, config.profile, index + 1)).filter(Boolean);
      // A single explicit narrative vacancy can be structured without inventing a table.
      // General hospital introductions and bare specialty mentions do not qualify.
      const narrative = [...page.text.matchAll(/((?:小儿)?超声科|医学影像科|放射科|影像诊断科)[^。；;]{0,35}?(?:拟|现)?招聘(?:\d+名)?(医生|医师|技师)/g)];
      if (!rows.length && narrative.length === 1 && page.title.includes(narrative[0][1]) && /招聘/.test(page.title)) {
        const common = commonConditions(page, config.profile);
        const conditions = page.text.slice(narrative[0].index, narrative[0].index + 1200).split(/二、待遇|三、报名|报名办法/)[0];
        const specialty = conditions.match(/[^。；;，,]{0,30}(?:医学影像|影像或临床医学|临床医学)[^。；;，,]{0,15}专业/)?.[0] || '';
        const job = jobFrom(`岗位名称：${narrative[0][1]}${narrative[0][2]}；学历要求：${common.degree}；专业要求：${specialty}；其他条件：${conditions}`, page, source, config.profile, 1);
        if (job) rows.push({ ...job, evidenceLocator: '官方正文明确招聘语句及聘用条件（非表格）' });
      }
      const errors = [];
      for (const attachment of page.attachments.filter(file => /岗位|计划|需求|目录|招聘/.test(file.title) && !/报名表|登记表|承诺|专业参考目录/.test(file.title)).slice(0, 3)) {
        try {
          if (!['xls', 'xlsx', 'pdf'].includes(attachment.format)) throw new Error('岗位附件为图片或Word，当前解析器尚不支持');
          const file = await fetchOne(attachment.url, authority.hosts);
          if (['xls', 'xlsx'].includes(attachment.format)) {
            (await spreadsheetRows(file.bytes)).forEach((row, index) => {
              const job = jobFrom(row, page, source, config.profile, index + 1);
              if (job) rows.push({ ...job, evidenceUrl: attachment.url, evidenceLocator: `${attachment.title} · ${job.positionCode ? `岗位代码${job.positionCode}` : `第${index + 1}条提取记录`}` });
            });
          } else {
            const pages = await (options.pdfText || pdfText)(file.bytes);
            // PDF text is not a reconstructed table. Keep page evidence without inventing column relationships.
            errors.push(`PDF已提取${pages.length}页文字，但尚未可靠重建岗位列关系：${attachment.title}`);
          }
        } catch (error) { errors.push(/HTTP \d+/.exec(error.message)?.[0] ? `岗位附件访问受限（${error.message.match(/HTTP \d+/)[0]}）` : clean(error.message).slice(0, 150)); }
      }
      return { page, rows, errors, html };
    })());
    return documents.get(url);
  };
  const output = [];
  for (const [index, job] of jobs.entries()) {
    if (index >= (settings.maxJobs || 60)) { output.push({ ...job, verification: { version: 1, checkedAt, state: 'blocked', summary: '本轮核验数量达到上限，尚未处理', officialUrl: null, issues: ['排队等待下一轮，不能视为已核验'], evidence: [], attempts: [] } }); continue; }
    const attempts = [], candidates = [], proofs = [];
    const authorityFor = url => { try { const host = new URL(url).hostname; return authorities.find(item => item.hosts.includes(host)); } catch { return null; } };
    const own = authorityFor(job.url);
    if (own?.original) candidates.push(job.url);
    const references = (settings.references || []).filter(reference => reference.from === job.url);
    for (const reference of references) if (safeUrl(reference.url, job.url, allHosts)) candidates.push(reference.url);
    if (own && !own.original) candidates.push(job.url);
    if (!own && !references.length) {
      const source = config.sources.find(source => source.name === job.sourceName);
      const hosts = source?.allowedHosts || [];
      const platform = safeUrl(job.url, job.url, hosts);
      if (platform) try {
        const response = await fetchOne(platform, hosts);
        candidates.push(...officialReferences(decode(response), response.url, authorities));
        attempts.push({ url: platform, result: 'read', reason: '已读取发现来源并查找原始公告链接' });
      } catch (error) { attempts.push({ url: platform, result: 'blocked', reason: /HTTP (403|429)/.test(error.message) ? '发现来源访问受限，未绕过验证' : '发现来源未完成读取' }); }
    }
    let selected = null;
    for (const url of unique(candidates).slice(0, 3)) {
      const authority = authorityFor(url);
      if (!authority) continue;
      try {
        const document = await loadOfficial(url, authority), { page, rows, errors } = document;
        const expectedUnit = normal((job.organization || '').split('发布')[0].split(/[（(]/)[0]).replace(/^(?:黑龙江省|广东省|四川省|湖北省|陕西省|湖南省)/, '');
        const materialText = normal(page.title + page.text + rows.map(row => row.employerExplicit + row.conditionExcerpt).join(' '));
        const aliasConfirmed = (authority.employerAliases || []).some(alias => normal(alias) === expectedUnit)
          && (authority.employerAliases || []).some(alias => materialText.includes(normal(alias)));
        if (/医院$/.test(expectedUnit) && !materialText.includes(expectedUnit) && !aliasConfirmed) throw new Error('公告用人单位与线索不一致，拒绝合并');
        // A reviewed URL mapping is a lead, not proof that two announcements are identical.
        const originalYears = unique((job.announcementTitle || '').match(/20\d{2}/g) || []), pageYears = unique(page.title.match(/20\d{2}/g) || []);
        if (originalYears.length === 1 && pageYears.length === 1 && originalYears[0] !== pageYears[0]) throw new Error('原始公告年份与发现线索不一致，拒绝合并');
        const match = matchOfficialRows(job, rows);
        const current = match.job;
        const general = commonConditions(page, config.profile);
        if (!current) {
          const deadlineConflict = general.certificateDeadline && Number(general.certificateDeadline.date.slice(0, 4)) < config.profile.graduationYear;
          const studentConflict = general.studentExclusion && general.studentExclusion.year < config.profile.graduationYear;
          const mismatch = deadlineConflict || studentConflict;
          const reason = deadlineConflict ? `公告要求${general.certificateDeadline.date}前取得毕业证，与${config.profile.graduationYear}届尚未毕业冲突`
            : studentConflict ? `原文不接收在读非${general.studentExclusion.year}届毕业生，与${config.profile.graduationYear}届在读情况冲突` : match.reason;
          if (mismatch) proofs.push(evidence('graduationDeadline', reason, deadlineConflict ? general.certificateDeadline.quote : general.studentExclusion.quote, page.url, '公告统一条件'));
          attempts.push({ url, result: mismatch ? 'mismatch' : 'no_match', reason: [reason, ...errors].join('；').slice(0, 240) });
          if (mismatch && authority.original) selected = { ...job, verification: { version: 1, checkedAt, state: 'mismatch', officialUrl: page.url, summary: reason, issues: [reason], evidence: proofs, attempts: [] } };
          continue;
        }
        const verified = evaluateOfficialJob(current, page, config.profile, today, { checkedAt, original: authority.original, locator: current.evidenceLocator || '官方网页岗位表' });
        if (errors.length) { verified.issues.push(...errors.slice(0, 3)); if (verified.state === 'matched') verified.state = 'partial'; }
        attempts.push({ url, result: 'read', reason: '已读取公告并唯一定位对应岗位行' });
        // Keep the discovered record's identity and delivery fingerprint. Better parsing alone
        // must not silently resend a position already delivered to a recipient.
        selected = { ...job, ...current, id: job.id, fingerprint: job.fingerprint, deliveryVersion: job.deliveryVersion, legacyIds: job.legacyIds, collectedAt: job.collectedAt,
          sourceName: job.sourceName, discoveryUrl: job.url, sourceKind: authority.original ? 'official-verified' : 'university-repost', isRepost: !authority.original, verification: verified };
        if (authority.original) break;
      } catch (error) { attempts.push({ url, result: 'blocked', reason: /HTTP \d+/.test(error.message) ? `原始公告访问失败（${error.message.match(/HTTP \d+/)[0]}）`
        : /^(?:来源连接失败（[A-Z_]+）|原始公告返回验证页或无有效正文|原始公告年份与发现线索不一致，拒绝合并|公告用人单位与线索不一致，拒绝合并|本轮核验请求预算已用尽，排队下轮处理|该来源本轮已返回403\/429，停止后续请求)$/.test(error.message) ? error.message : '原始公告未完成读取或解析，未用缓存冒充核验成功' }); }
    }
    const fallback = { version: 1, checkedAt, state: 'blocked', officialUrl: null,
      summary: attempts.some(attempt => attempt.result === 'no_match') ? '已找到原始公告，但尚未取得可唯一对应的岗位条件' : '尚未取得可核验的原始岗位材料',
      issues: unique(attempts.map(attempt => attempt.reason).concat(!candidates.length ? ['未找到已批准官方域名内的原始公告链接，需补充来源定位'] : [])).slice(0, 12), evidence: proofs, attempts: [] };
    const result = selected || { ...job, verification: fallback };
    if (result.verification.state === 'blocked') result.verification.issues.push(...attempts.filter(attempt => attempt.result === 'blocked').map(attempt => attempt.reason));
    result.verification.attempts = attempts.slice(0, 8);
    result.verification.issues = unique(result.verification.issues).slice(0, 12);
    if (result.verification.state === 'partial') result.verification.summary = `已核对原文，剩余${result.verification.issues.length}项具体问题`;
    output.push(result);
    options.onProgress?.({ completed: index + 1, total: jobs.length, state: result.verification.state });
  }
  return output;
}

import crypto from 'node:crypto';
import { load } from 'cheerio';
import { commonConditions, rowCohortConditions } from './conditions.mjs';

export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
export const chinaDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const dayNumber = value => Date.parse(`${value}T00:00:00+08:00`) / 86400000;
export const daysBetween = (a, b) => Math.round(dayNumber(a) - dayNumber(b));
export const imaging = /医学影像|影像医学|放射(?:科|诊断|影像)|影像(?:科|中心|诊断|医师|技师)|\b(?:CT|MRI|MR)\b|磁共振|核磁|超声|B超/i;
const recruitment = /招聘|招录|人才引进|校园引才|人才周|诚聘|招贤/;
const procedural = /拟聘|拟录|公示|面试(?:名单|成绩|通知)|笔试(?:成绩|通知)|体检|递补|资格(?:复审|审查结果)|考试\s*(?:的\s*)?通知$/;
const genericHeading = value => /^(?:新闻中心|院务公开|医院新闻|医院公告|信息公开|人才招聘|校园招聘|招聘信息|招聘公告|通知公告)(?:\s*[-_｜|].*)?$/.test(clean(value));

export function safeUrl(value, base, hosts) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!hosts.includes(url.hostname)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|from|spm|source)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch { return null; }
}

export function linksFrom(html, url, hosts) {
  const $ = load(html);
  const result = new Map();
  $('a[href]').each((_, node) => {
    const anchor = $(node);
    const href = safeUrl(anchor.attr('href'), url, hosts);
    const title = clean(anchor.attr('title') || anchor.text());
    if (href && title && href !== url) result.set(href, { url: href, title });
  });
  return [...result.values()];
}

export function classifyLink(link) {
  if (procedural.test(link.title)) return null;
  // Exact menu labels are listing pages; a longer dated recruitment notice is still an article.
  if (/^(?:人才招聘|招聘信息|招聘公告|招贤纳士|人事处|人事招聘|通知公告)$/.test(clean(link.title))) return 'index';
  if (recruitment.test(link.title) && /公告|简章|通知|20\d{2}|需求|岗位/.test(link.title)) return 'article';
  if (/人才招聘|招聘信息|招聘公告|招贤纳士|人事处|人事招聘|通知公告/.test(link.title)) return 'index';
  return null;
}

export function datesIn(text, year) {
  text = text.replace(/\b(20)\s*(\d)\s+(\d)(?=\s*年|[-./])/g, '$1$2$3').replace(/(\d)\s+(\d)(?=\s*日)/g, '$1$2');
  const result = [];
  const expression = /(?:(20\d{2})\s*[年./-]\s*)?(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?/g;
  for (const match of text.matchAll(expression)) {
    const y = Number(match[1] || year), m = Number(match[2]), d = Number(match[3]);
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (parsed.getUTCFullYear() === y && parsed.getUTCMonth() + 1 === m && parsed.getUTCDate() === d) result.push(date);
  }
  return result;
}

function publicationHint(value) {
  const candidate = clean(value).replace(/^(?:发布时间|发布日期|发表时间|来源时间|Published(?:\s+(?:at|on|date))?|Publication\s+date)\s*[:：]?\s*/i, '');
  const numericText = candidate.match(/^20\d{2}\s*[年./-]\s*\d{1,2}\s*[月./-]\s*\d{1,2}\s*日?/)?.[0];
  const numeric = numericText ? datesIn(numericText, 2000)[0] : null;
  if (numeric) return numeric;
  const english = candidate.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!english) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(english[1].slice(0, 3).toLowerCase()) + 1;
  return datesIn(`${english[3]}-${month}-${english[2]}`, 2000)[0] || null;
}

export function publicationDateFromText(text) {
  if (typeof text !== 'string') return null;
  const labeled = clean(text).match(/(?:发布时间|发布日期|发表时间|来源时间|Published(?:\s+(?:at|on|date))?|Publication\s+date)\s*[:：]?\s*([^；。]{1,65})/i)?.[1];
  return labeled ? publicationHint(labeled) : null;
}

export function extractDeadline(text, year) {
  // Only dates explicitly associated with registration; never infer from graduation/exam dates.
  const labels = [...text.matchAll(/报名\s*(?:截止(?:时间|日期)?|时间|日期)|截止(?:报名|时间|日期)|报名.{0,8}?截至/g)];
  for (const match of labels) {
    const span = text.slice(match.index, match.index + 100).split(/。|；|;/)[0];
    const dates = datesIn(span, year);
    if (dates.length) return dates.at(-1);
  }
  return null;
}

export function pageData(html, url, source) {
  const $ = load(html);
  $('script,style,nav,footer,header,noscript').remove();
  let content = $('body');
  for (const selector of ['.v_news_content', '#vsb_content', '.TRS_Editor', '.article-content', '.article_content', '.article_cont', '#zoom', '#article', 'article', 'main']) {
    const node = $(selector).first();
    if (clean(node.text()).length > 50) { content = node; break; }
  }
  const headingTexts = selector => $(selector).toArray().map(node => clean($(node).text())).filter(Boolean);
  // Some official sites put a left-navigation <h1> before the actual article <h1>.
  const articleHeadings = headingTexts('.article_title,.article-title,.Article_Title,.arti_title,article h1,main h1');
  const titleCandidates = [...articleHeadings, clean($('meta[property="og:title"]').attr('content')), ...headingTexts('h1'), clean($('title').text())].filter(Boolean);
  const title = articleHeadings.find(value => !genericHeading(value))
    || titleCandidates.find(value => !genericHeading(value) && recruitment.test(value))
    || titleCandidates.find(value => !genericHeading(value)) || titleCandidates[0] || '';
  const text = clean(content.text());
  const dateHints = [
    ...$('meta[property="article:published_time"],meta[name="PubDate"],meta[name="pubdate"],meta[name="DC.date.issued"],meta[name="publishdate"]').toArray().map(node => $(node).attr('content') || ''),
    ...headingTexts('time,.publish-time,.pubtime,.article-time,.Article_PublishDate,.arti-time,.article-meta .date'),
    publicationDateFromText(clean($('body').text())) || '',
    title.match(/20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}/)?.[0] || '',
  ];
  const published = dateHints.map(publicationHint).find(Boolean) || null;
  const rows = [];
  content.find('table').each((_, table) => {
    const spans = new Map();
    const allRows = $(table).find('tr').toArray().map(row => {
      const values = [];
      for (const [column, span] of spans) {
        values[column] = span.value;
        if (--span.remaining <= 0) spans.delete(column);
      }
      let column = 0;
      for (const cell of $(row).children('th,td').toArray()) {
        while (values[column] !== undefined) column++;
        const value = clean($(cell).text());
        const width = Math.min(200, Math.max(1, Number($(cell).attr('colspan')) || 1));
        const height = Math.min(10000, Math.max(1, Number($(cell).attr('rowspan')) || 1));
        for (let i = 0; i < width; i++) {
          values[column + i] = value;
          if (height > 1) spans.set(column + i, { value, remaining: height - 1 });
        }
        column += width;
      }
      return Array.from(values, value => value || '');
    });
    const headerIndex = allRows.findIndex(cells => /岗位|专业/.test(cells.join(' ')) && /学历|学位|人数|条件/.test(cells.join(' ')));
    const header = headerIndex >= 0 ? allRows[headerIndex] : [];
    for (const [index, cells] of allRows.entries()) {
      if (index === headerIndex || !cells.some(cell => imaging.test(cell))) continue;
      rows.push(header.length ? cells.map((cell, i) => `${header[i] || `列${i + 1}`}：${cell}`).join('；') : cells.join('；'));
    }
  });
  const hosts = source.allowedHosts || [new URL(source.url).hostname];
  const attachments = linksFrom(html, url, hosts).flatMap(link => {
    // University CMS downloads often use download.jsp while the anchor retains the file name.
    const format = (link.url.match(/\.(xlsx?|pdf|docx?|png|jpe?g)(?:\?|$)/i)?.[1]
      || link.title.match(/\.(xlsx?|pdf|docx?|png|jpe?g)$/i)?.[1])?.toLowerCase();
    return format ? [{ ...link, format }] : [];
  });
  // Job plans are sometimes embedded as an image instead of linked as a download.
  // Restrict discovery to article content and substantial / explicitly labelled images.
  content.find('img').each((_, node) => {
    const image = $(node), title = clean(image.attr('alt') || image.attr('title'));
    if (!/岗位|招聘|计划|需求/.test(title) && !(Number(image.attr('width')) >= 400 && Number(image.attr('height')) >= 150)) return;
    const address = safeUrl(image.attr('data-src') || image.attr('src'), url, hosts);
    const format = address?.match(/\.(png|jpe?g)(?:\?|$)/i)?.[1]?.toLowerCase();
    if (format && !attachments.some(file => file.url === address)) attachments.push({ url: address, title: title || '正文图片（用途待识别）', format });
  });
  const commonContent = content.clone();
  commonContent.find('table').remove();
  return { title, text, commonText: clean(commonContent.text()), published, rows, attachments, url };
}

function excerpt(text, pattern) {
  const index = text.search(pattern);
  return index < 0 ? '' : text.slice(Math.max(0, index - 10), index + 100);
}

function canonicalJobUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|from|spm|source)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.href;
  } catch { return clean(value); }
}

function positionDirection(text, structured) {
  // This broad academic specialty is not evidence of a nuclear-medicine job assignment.
  const scopedText = text.replace(/影像医学与核医学/g, '医学影像');
  const ct = /\bCT\b|计算机(?:断层|体层)/i.test(scopedText);
  const others = [
    [/超声|B超/i, '超声'], [/\b(?:MRI|MR)\b|磁共振|核磁/i, 'MR'], [/核医学|\b(?:PET|SPECT)\b/i, '核医学'],
  ].filter(([pattern]) => pattern.test(scopedText)).map(([, label]) => label);
  if (!structured) return { focusMatch: 'unknown', directionLabel: ct ? '公告提及CT，具体岗位方向待核对' : '具体岗位方向待核对' };
  if (ct && !others.length) return { focusMatch: 'ct', directionLabel: 'CT方向' };
  if (ct) return { focusMatch: 'mixed', directionLabel: `CT及${others.join('、')}多方向` };
  if (others.length) return { focusMatch: 'other', directionLabel: `${others.join('、')}方向（非CT明确岗位）` };
  return { focusMatch: 'unknown', directionLabel: '综合影像，具体方向待核对' };
}

function mastersConstraint(value) {
  if (!value) return null;
  const negated = /不(?:接受|接收|招收|招录|招)?\s*硕士|硕士(?:不符合|不可|不能|不予|不得)/.test(value);
  const includesMasters = !negated && (/硕士/.test(value)
    || /(?:本科|学士|专科)(?:学历|学位)?(?:及以上|以上)/.test(value)
    || (/研究生/.test(value) && !/博士/.test(value)));
  const doctorateOnly = /博士/.test(value) && !includesMasters && !/不限|优先|不要求|不需要|非博士/.test(value);
  return { allows: includesMasters, doctorateOnly };
}

function degreeConstraints(values) {
  const hasMasters = values.some(value => mastersConstraint(value)?.allows);
  return values.map(value => /(?:相应|相对应|对应).{0,6}学位/.test(value) && !/博士|学士|仅限/.test(value) && hasMasters
    ? { allows: true, doctorateOnly: false } : mastersConstraint(value));
}

function negatesCohort(text, year) {
  const target = `${year}\\s*(?:届|年(?:应届)?毕业生)`;
  return new RegExp(`(?:不(?:接受|接收|招收|招录|招聘|招|含|包括)?|拒绝|排除|不面向|暂不(?:接受|接收|招收|招录|招)?)\\s*${target}|${target}(?:毕业生)?\\s*(?:不得|不可|不能|不予|不符合|不接收|不接受|不招收|暂不|除外)|除\\s*${target}(?:毕业生)?\\s*以?外`).test(text);
}

function includesCohortRange(text, year) {
  for (const match of text.matchAll(/(20\d{2})\s*届\s*(?:及|和)?\s*(以后|之后|以上|以前|之前|以下)/g)) {
    const start = Number(match[1]);
    if (/以后|之后|以上/.test(match[2]) ? year >= start : year <= start) return true;
  }
  for (const match of text.matchAll(/(20\d{2})\s*(?:届|年)?\s*[-—~～至到]\s*(20\d{2})\s*(?:届|年)/g)) {
    if (year >= Number(match[1]) && year <= Number(match[2])) return true;
  }
  return false;
}

const onlyDoctorate = text => /(?:仅限|仅招|只招|限招)\s*博士/.test(text);

function rowFields(text) {
  return text.split('；').map(part => {
    const separator = part.indexOf('：');
    return separator < 0 ? ['', ''] : [clean(part.slice(0, separator)), clean(part.slice(separator + 1))];
  }).filter(([key]) => key);
}

function fallbackDegree(fields) {
  return fields.filter(([key, value]) => /^(?:要求|任职要求|招聘条件|资格条件|条件)$/.test(key)
    && /学历|学位|硕士|博士|本科|学士/.test(value)).map(([, value]) => value).join('；');
}

function clinicalRole(text, title, structured) {
  const entries = rowFields(text);
  const values = pattern => entries.filter(([key]) => pattern.test(key)).map(([, value]) => value).join('；');
  const position = values(/岗位名称|招聘岗位|职位名称|招聘职位.*职位$|^职位$|^岗位$|部门岗位/);
  const department = values(/科室|^部门$/);
  const type = values(/岗位类型|岗位类别|职位类别|招聘类别/);
  const doctor = /医师|医生/.test(position);
  const technician = /技师|放射师|影像技术人员/.test(position) || /^(?:影像|放射|医学影像)?技术岗(?:\d+)?$/.test(position);
  const clinicalMedical = /医疗岗|专技岗位|专业技术岗|卫生专业技术人员/.test(position)
    && imaging.test(`${department} ${values(/专业/)}`) && /(?:执业医师|医师(?:资格|执业))/.test(text);
  if (/科研|研究助理|博士后|教师|实验员|行政|工程师|研究员/.test(`${position} ${type}`)) return null;
  if (entries.some(([key]) => /导师|研究方向/.test(key)) && !doctor && !technician) return null;
  if (!structured && /科研|博士后|研究助理|教师|研究员/.test(title)) return null;
  if (position && /护士|护理|药师|财务|会计|秘书|文员|收费|后勤|司机/.test(position) && !doctor && !technician) return null;
  if (genericHeading(title) && (!structured || (!doctor && !technician && !clinicalMedical))) return null;
  // Unstructured text remains a clue, never an inferred doctor vacancy.
  if (!structured) return 'clue';
  if (doctor && technician) return 'clue';
  if (technician) return 'technician';
  if (doctor) return 'physician';
  if (clinicalMedical) return 'physician';
  return 'clue';
}

function datedUrlIsOld(job, today, lookbackDays = 90) {
  if (job.published || (job.deadline && daysBetween(job.deadline, today) >= 0)) return false;
  let pathname;
  try { pathname = new URL(job.url).pathname; } catch { return false; }
  const hint = pathname.match(/\/(20\d{2})\/(\d{2})(\d{2})\//);
  if (!hint) return false;
  const date = `${hint[1]}-${hint[2]}-${hint[3]}`;
  const instant = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) return false;
  // This is an exclusion hint only; never write an inferred publication date.
  return daysBetween(today, date) > lookbackDays;
}

const publicExcerpt = (value, maximum) => clean(value)
  .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [已隐藏]')
  .replace(/\b(access_token|api[_-]?key|appsecret|authorization|password)\s*[:=：]\s*[^\s；，,。]+/gi, '$1：[已隐藏]')
  .slice(0, maximum);

function repostEmployer(title, source) {
  if (!source.isRepost && source.sourceKind !== 'university-repost') return '';
  let heading = clean(title);
  for (let i = 0; i < 3; i++) heading = heading.replace(/^(?:【[^】]{1,40}】|〖[^〗]{1,40}〗|\[[^\]]{1,40}\]|转发\s*[:：])\s*/, '');
  heading = heading.replace(/\s+/g, '');
  const employer = heading.match(/^([\p{Script=Han}A-Za-z0-9·（）()]{2,100}?医院(?:[（(][^）)]{2,60}[）)])?)(?=20\d{2}(?:年度|年|届)|公开招聘|校园招聘|招聘|人才招聘|引进|诚聘)/u)?.[1] || '';
  return /汇总|多家|各家|名单|关于|转发|平台|^高校医院$|^某|^相关|^有关/.test(employer) ? '' : employer;
}

function recruitmentCycle(title) {
  const years = [...new Set(title.match(/20\d{2}/g) || [])].sort();
  const rounds = [...new Set(title.match(/第\s*[一二三四五六七八九十百\d]+\s*(?:批|轮|次)|上半年|下半年|春季|秋季|人才周/g) || [])]
    .map(value => value.replace(/\s+/g, '')).sort();
  return JSON.stringify({ years, rounds });
}

export function assessJobQuality(job, config, today = chinaDate()) {
  const reasons = [], targetYear = config.profile.graduationYear;
  const role = job.sourceKind === 'aggregator' ? 'clue' : clinicalRole(job.conditionExcerpt || '', job.announcementTitle || job.title, job.structured);
  // Recheck explicit contradictions in cached records as well as newly parsed rows.
  // This only removes confidence; it never invents new qualification evidence.
  const rowConditions = job.structured ? job.conditionExcerpt || '' : '';
  const degreeRequirement = job.degreeRequirement || fallbackDegree(rowFields(rowConditions));
  const constraints = job.structured && degreeRequirement ? degreeConstraints(degreeRequirement.split('；')) : [];
  const doctorateOnly = constraints.some(constraint => constraint?.doctorateOnly) || onlyDoctorate(rowConditions);
  const wrongCohort = negatesCohort(rowConditions, targetYear);
  const evidence = {
    ...(job.qualificationEvidence || {}),
    masters: job.qualificationEvidence?.masters === true && constraints.length > 0
      && constraints.every(constraint => constraint?.allows === true) && !doctorateOnly,
    graduationYear: wrongCohort ? null : job.qualificationEvidence?.graduationYear ?? null,
  };
  const excluded = job.excluded || (role === null ? '非明确临床招聘岗位或栏目导航内容' : doctorateOnly ? '该岗位仅列博士学历'
    : wrongCohort ? '届别不符' : datedUrlIsOld(job, today, config.lookbackDays) ? '未识别发布日期且URL日期明显过旧，需重新核验公告' : null);
  let score = role === 'physician' ? 1000 : role === 'technician' ? 0 : -500;
  reasons.push(role === 'physician' ? '影像医师优先' : role === 'technician' ? '影像技师候补' : '仅公告线索，未确认临床职业类型');
  if (job.structured) { score += job.sourceKind === 'aggregator' ? 10 : 40; reasons.push(job.sourceKind === 'aggregator' ? '已读取平台列示字段，官方岗位表尚未核验' : '已解析官方具体岗位行'); }
  else reasons.push('仅公告线索，具体岗位条件待核实');
  if (evidence.masters) { score += 90; reasons.push(job.sourceKind === 'aggregator' ? '平台列示学历包含硕士层级，需核对原始岗位表' : '该岗位学历要求明确包含硕士层级'); }
  else reasons.push('是否接受硕士尚待核实');
  const cohortConfirmed = evidence.graduationYear === targetYear;
  if (cohortConfirmed) { score += 90; reasons.push(`该岗位明确列出${targetYear}届毕业生`); }
  else reasons.push(`是否接受${targetYear}届尚待核实`);
  const knownPublished = job.published && Number.isFinite(daysBetween(today, job.published)) && daysBetween(today, job.published) >= 0;
  const priority = Boolean(role && role !== 'clue' && job.structured && knownPublished && evidence.masters && cohortConfirmed && !excluded);
  if (priority) score += 300;
  if (job.focusMatch === 'ct') { score += 180; reasons.push('具体岗位明确涉及CT'); }
  else if (job.focusMatch === 'mixed') { score += 60; reasons.push('岗位包含CT及其他影像方向，需核对具体分工'); }
  else if (job.focusMatch === 'other') { score -= 40; reasons.push(job.directionLabel || '明确为其他影像方向，非CT优先项'); }
  else reasons.push(job.directionLabel || '岗位方向待核对');
  if (job.province === config.profile.preferredProvince) { score += 80; reasons.push(`${job.province}地区优先`); }
  const remaining = job.deadline ? daysBetween(job.deadline, today) : null;
  if (remaining !== null && remaining >= 0) {
    score += 35;
    if (remaining <= 30) score += 10;
    reasons.push(`已识别报名截止日期${job.deadline}，尚未截止（报名是否开始需核对）`);
  } else if (remaining !== null && remaining < 0) reasons.push('已截止，不进入推送候选');
  else reasons.push('报名截止日期待核实');
  const age = job.published ? daysBetween(today, job.published) : null;
  if (age !== null && age >= 0 && age <= 30) { score += 20; reasons.push('近30天发布'); }
  else if (age !== null && age >= 0 && age <= 90) { score += 5; reasons.push('近90天发布'); }
  else if (age === null || age < 0) reasons.push('发布日期尚待核实');
  if (excluded) reasons.push(`已排除：${excluded}`);
  return {
    ...job, role: role || job.role, degreeRequirement, excluded, qualificationEvidence: evidence, status: priority ? 'priority' : 'review', qualityScore: score, qualityReasons: reasons,
    priorityLabel: job.sourceKind === 'aggregator' ? '平台转载·待核实' : priority ? (job.focusMatch === 'ct' ? '优先关注·CT岗位' : '岗位条件较明确·仍需核对资格') : '待核实线索',
  };
}

export function jobFrom(text, page, source, profile, rowNumber = 0) {
  if (!imaging.test(text)) return null;
  const structured = rowNumber > 0;
  const fields = rowFields(text);
  const position = fields.filter(([key]) => /岗位名称|招聘岗位|职位名称|招聘职位.*职位$|^职位$|^岗位$|^科室$|招聘科室|^部门$|用人部门|招聘部门/.test(key)).map(([, value]) => value).filter(Boolean).join('｜');
  const field = pattern => fields.filter(([key]) => pattern.test(key)).map(([, value]) => value).filter(Boolean).join('；');
  const degreeFallback = fallbackDegree(fields);
  const common = commonConditions(page, profile);
  const degreeRequirement = field(/学历|学位/) || degreeFallback || common.degree;
  const employer = field(/招聘单位|单位名称|用人单位|引进单位|引才单位|^单位$|^医院$/);
  const role = clinicalRole(text, page.title, structured);
  if (role === null) return null;
  const title = clean(position || excerpt(text, imaging)).slice(0, 100);
  const conditions = structured ? text : '';
  // A hospital-wide PhD requirement must not reject a separate master's opening.
  // Education and degree are separate constraints. A broad education field cannot
  // override a doctorate-only degree field (or vice versa).
  const explicitDegrees = fields.filter(([key]) => /学历|学位/.test(key)).map(([, value]) => value);
  const constraints = degreeConstraints(explicitDegrees.length ? explicitDegrees : (degreeFallback || common.degree) ? (degreeFallback || common.degree).split('；') : []);
  const masters = structured && constraints.length > 0 && constraints.every(constraint => constraint?.allows === true) && !onlyDoctorate(conditions);
  const doctorateOnly = structured && (constraints.some(constraint => constraint?.doctorateOnly)
    || onlyDoctorate(conditions));
  const cohorts = [...conditions.matchAll(/(20\d{2})\s*(?:届|年(?:应届)?毕业生)/g)].map(m => Number(m[1]));
  const rangeCohort = includesCohortRange(conditions, profile.graduationYear);
  const unrestrictedCohort = rangeCohort || /届别不限|毕业(?:年份|年度|届别|年限)不限|不限(?:毕业)?(?:年份|届别)|应往届|往届(?:毕业生)?(?:均可|可报|不限)|(?:接受|含)往届/.test(conditions);
  const targetCohort = `${profile.graduationYear}\\s*(?:届|年(?:应届)?毕业生)`;
  const targetNegated = negatesCohort(conditions, profile.graduationYear);
  const wrongCohort = targetNegated || (cohorts.length > 0 && !cohorts.includes(profile.graduationYear) && !unrestrictedCohort);
  const doctorateScopedCohort = new RegExp(`${targetCohort}(?:毕业生)?\\s*(?:的)?\\s*博士`).test(conditions);
  const scopedCohort = rowCohortConditions(conditions, common, profile.graduationYear);
  const cohortConfirmed = structured && scopedCohort.confirmed && !targetNegated && !doctorateScopedCohort;
  const directionText = structured ? fields.filter(([key]) => key && !/代码|编号|单位|医院|人数|计划数|招聘数量|学历|学位/.test(key)).map(([, value]) => value).join(' ') || text : text;
  const direction = positionDirection(directionText, structured);
  const requirements = [];
  if (!structured) requirements.push('公告线索：具体岗位条件需核对原文或附件');
  if (role === 'clue') requirements.push('职业类型未确认，仅为公告线索，不计入医师或技师招聘');
  if (!masters) requirements.push('是否接受硕士待确认');
  if (!cohortConfirmed) requirements.push(`是否接受${profile.graduationYear}届待确认`);
  if (/报名时|报名前/.test(text) && /毕业证|学位证/.test(text)) requirements.push('注意报名时取得学历学位证的要求');
  if (/执业(?:医师)?证|执业注册|医师执业/.test(text)) requirements.push('医师执业注册情况待核对');
  if (/规培|规范化培训/.test(text)) requirements.push('核对规培专业及证书要求');
  if (/工作经验|工作经历|从业经验/.test(text)) requirements.push('核对工作经历要求');
  if (role === 'technician') requirements.push('核对是否接受医学影像学及技师资格要求');
  requirements.push('核对学硕/专硕、专业代码及其他资格条件');
  const deadlineYear = Number((page.published || chinaDate()).slice(0, 4));
  // A global date is inherited only when all labeled registration deadlines agree.
  // Multiple batches with different dates require a row-specific date or human review.
  const pageDeadlines = [...(page.text || '').matchAll(/报名\s*(?:截止(?:时间|日期)?|时间|日期)|截止(?:报名|时间|日期)|报名.{0,8}?截至/g)]
    .map(match => extractDeadline(page.text.slice(match.index), deadlineYear)).filter(Boolean);
  const commonDates = common.registration.map(value => datesIn(value, deadlineYear).at(-1)).filter(Boolean);
  const deadline = extractDeadline(text, deadlineYear)
    || (new Set(pageDeadlines).size === 1 ? pageDeadlines[0] : null)
    || (new Set(pageDeadlines).size <= 1 && new Set(commonDates).size === 1 ? commonDates[0] : null);
  if (!deadline && new Set(pageDeadlines).size > 1) requirements.push('公告存在多批次报名日期，当前岗位截止时间需单独核对');
  const matches = [];
  if (masters) matches.push('岗位学历要求包含硕士');
  if (cohortConfirmed) matches.push(`岗位明确列出${profile.graduationYear}届`);
  if (direction.focusMatch === 'ct' || direction.focusMatch === 'mixed') matches.push('具体岗位涉及CT');
  const code = fields.find(([key]) => /岗位代码|岗位编号|职位代码|职位编号/.test(key))?.[1];
  const originalIdentity = code || `${title}#${fields.filter(([key]) => /专业/.test(key)).map(([, value]) => value).join('|')}`;
  const departmentIdentity = field(/科室|^部门$/);
  const identity = code || `${originalIdentity}${departmentIdentity ? `#${departmentIdentity}` : ''}`;
  const id = hash(`${canonicalJobUrl(page.url)}#${structured ? `${employer ? `${employer.replace(/\s+/g, '')}#` : ''}${identity}` : 'announcement'}`);
  const oldId = hash(`${page.url}#${structured ? originalIdentity : 'announcement'}`);
  const priorQualifiedId = hash(`${canonicalJobUrl(page.url)}#${structured ? `${employer ? `${employer.replace(/\s+/g, '')}#` : ''}${originalIdentity}` : 'announcement'}`);
  const legacyIds = [...new Set([oldId, priorQualifiedId])].filter(value => value !== id);
  const fingerprint = hash(JSON.stringify({ text: clean(text), deadline, title: page.title }));
  return assessJobQuality({
    id, fingerprint, title: structured ? title : page.title,
    ...(legacyIds.length ? { legacyIds } : {}),
    organization: employer || repostEmployer(page.title, source) || (/医院/.test(source.name) ? source.name : `${source.name}发布（单位见公告）`),
    announcementTitle: publicExcerpt(page.title, 200), announcementText: publicExcerpt(page.text, 1200),
    sourceName: source.name, degreeRequirement, specialtyRequirement: field(/专业/),
    employerExplicit: employer, positionCode: code || '', recruitmentCycle: recruitmentCycle(page.title),
    sourceKind: source.sourceKind || (source.isRepost ? 'university-repost' : employer && clean(source.name) === employer ? 'official-employer' : 'official-publisher'),
    isRepost: source.isRepost === true || source.sourceKind === 'university-repost',
    deliveryVersion: hash(JSON.stringify({ text: clean(text), deadline })),
    headcount: field(/人数|计划数|招聘数量/), conditionExcerpt: structured ? clean(text).slice(0, 800) : '',
    province: source.province, role, url: page.url, published: page.published,
    deadline, matches, requirements, structured, ...direction,
    qualificationEvidence: { masters, graduationYear: cohortConfirmed ? profile.graduationYear : null, cohortGeneral: /应往届|届别不限|毕业.{0,6}不限/.test(scopedCohort.quote) },
    commonEvidence: { cohort: scopedCohort, degree: common.degree, application: common.application, registration: common.registration, certificateDeadline: common.certificateDeadline, currentCertificate: common.currentCertificate },
    excluded: doctorateOnly ? '该岗位仅列博士学历' : wrongCohort || scopedCohort.negated ? '届别不符' : null,
  }, { profile });
}

export function rankJobs(jobs, config, today = chinaDate()) {
  const ranked = jobs.filter(job => !job.excluded && !['mismatch', 'blocked'].includes(job.verification?.state) && (!job.deadline || daysBetween(job.deadline, today) >= 0))
    .map(job => assessJobQuality(job, config, today))
    .filter(job => !job.excluded)
    .sort((a, b) => b.qualityScore - a.qualityScore || (b.published || '').localeCompare(a.published || '') || a.id.localeCompare(b.id));
  const unique = new Map();
  for (const job of ranked) if (!unique.has(job.id)) unique.set(job.id, job);
  const groups = new Map();
  for (const job of unique.values()) {
    const key = crossSourceKey(job) || `id:${job.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  return [...groups.values()].map(group => {
    const selected = [...group].sort(preferRepresentative)[0];
    if (group.length === 1 && !selected.crossSourceAliases?.length) return selected;
    const aliases = new Map();
    for (const member of group) {
      for (const alias of aliasRecords(member)) aliases.set(`${alias.id}:${alias.fingerprint}:${alias.version || ''}`, alias);
    }
    return { ...selected, crossSourceAliases: [...aliases.values()] };
  }).sort((a, b) => b.qualityScore - a.qualityScore || (b.published || '').localeCompare(a.published || '') || a.id.localeCompare(b.id));
}

function crossSourceKey(job) {
  // No fuzzy employer/title matching. Old state lacking this evidence stays separate.
  if (!job.structured || !job.employerExplicit || !job.positionCode || !job.specialtyRequirement || !job.title
    || !job.qualificationEvidence?.graduationYear || job.qualificationEvidence?.cohortGeneral || !job.recruitmentCycle || !job.deliveryVersion
    || !/^20\d{2}-\d{2}-\d{2}$/.test(job.deadline || '')) return null;
  return JSON.stringify([clean(job.employerExplicit), clean(job.positionCode), job.qualificationEvidence.graduationYear,
    job.recruitmentCycle, job.deadline, clean(job.title), clean(job.specialtyRequirement)]);
}

function preferRepresentative(a, b) {
  const authority = job => job.isRepost || job.sourceKind === 'university-repost' ? 0 : job.sourceKind === 'official-employer' ? 3 : job.sourceKind === 'official-employer-group' ? 2 : 1;
  const completeness = job => ['degreeRequirement', 'specialtyRequirement', 'headcount', 'published', 'deadline', 'conditionExcerpt']
    .filter(key => job[key] && !/待核|待定|未知/.test(String(job[key]))).length;
  return authority(b) - authority(a) || completeness(b) - completeness(a)
    || (b.collectedAt || '').localeCompare(a.collectedAt || '') || b.qualityScore - a.qualityScore
    || (b.published || '').localeCompare(a.published || '') || a.id.localeCompare(b.id);
}

function aliasRecords(job) {
  return [
    { id: job.id, fingerprint: job.fingerprint, version: job.deliveryVersion },
    ...(job.legacyIds || []).map(id => ({ id, fingerprint: job.fingerprint, version: job.deliveryVersion })),
    ...(job.crossSourceAliases || []),
  ];
}

function matchingDeliveryRecords(job) {
  return aliasRecords(job).filter(alias => ((alias.id === job.id || (job.legacyIds || []).includes(alias.id))
    && alias.fingerprint === job.fingerprint) || (job.deliveryVersion && alias.version === job.deliveryVersion));
}

export function planDigest(jobs, state, config, today) {
  const active = rankJobs(jobs, config, today);
  const delivered = job => matchingDeliveryRecords(job).some(alias => typeof alias.fingerprint === 'string' && alias.fingerprint
    && state.sent[alias.id]?.fingerprint === alias.fingerprint);
  const unseen = active.filter(job => !delivered(job));
  const physicians = unseen.filter(job => job.role === 'physician').slice(0, config.maxPhysicians);
  const technicians = unseen.filter(job => job.role === 'technician').slice(0, config.maxTechnicians);
  const selected = new Set([...physicians, ...technicians].map(job => job.id));
  const reminders = active.filter(job => ['physician', 'technician'].includes(job.role) && job.deadline && !selected.has(job.id) && delivered(job)
    && daysBetween(job.deadline, today) <= config.reminderDays
    && !aliasRecords(job).some(alias => state.reminded[alias.id] === job.deadline)).slice(0, config.maxReminders);
  return { today, physicians, technicians, reminders, activeCount: active.filter(job => ['physician', 'technician'].includes(job.role)).length };
}

export function markDelivered(state, digest, recipient, deliveredAt) {
  const copy = structuredClone(state);
  copy.recipients ||= {};
  const bucket = copy.recipients[recipient] ||= { sent: {}, reminded: {} };
  for (const job of [...digest.physicians, ...digest.technicians]) {
    for (const alias of matchingDeliveryRecords(job)) bucket.sent[alias.id] = { fingerprint: alias.fingerprint, deliveredAt };
    bucket.sent[job.id] = { fingerprint: job.fingerprint, deliveredAt };
  }
  for (const job of digest.reminders) for (const alias of aliasRecords(job)) bucket.reminded[alias.id] = job.deadline;
  return copy;
}

export function renderMarkdown(digest, coverage) {
  const escape = value => clean(value).replace(/[\[\]<>*`|]/g, '');
  const lines = [`# 医学影像招聘日报 · ${digest.today}`, '', `来源检查：${coverage.filter(s => s.ok).length}/${coverage.length} 个来源成功。`,
    '关注方向：2027届硕士、CT优先、黑龙江优先，医师优先、技师候补。排序是岗位信息初筛，不代表已通过报名资格审核。',
    '仅统计本次可读取并可解析的内容；存在失败来源或未核验附件时，不能将无新增理解为没有招聘。', ''];
  for (const [label, jobs] of [['影像医师', digest.physicians], ['技师候补', digest.technicians], ['截止提醒', digest.reminders]]) {
    lines.push(`## ${label}`, '');
    if (!jobs.length) lines.push('本次无新增或提醒。', '');
    for (const job of jobs) {
      const reasons = (job.qualityReasons || job.matches || []).filter(reason => !/待核|尚待|仅公告/.test(reason));
      lines.push(`### ${escape(job.organization)}｜${escape(job.title)}`, '',
        `地区：${escape(job.province)}；${escape(job.priorityLabel) || (job.status === 'priority' ? '优先关注' : '待核实线索')}。`,
        `方向：${escape(job.directionLabel) || '具体方向待核对'}；报名截止：${job.deadline || '公告未明确，需核对'}。`,
        `学历/学位：${escape(job.degreeRequirement) || '见原公告'}；专业：${escape(job.specialtyRequirement) || '见原公告'}；人数：${escape(job.headcount) || '待核对'}。`,
        `优先理由：${reasons.map(escape).join('；') || '涉及影像相关岗位，具体资格待核实'}。`,
        `待核对：${job.requirements.map(escape).join('；')}。`,
        `发布日期：${job.published || '未识别'}；采集日期：${job.collectedAt || digest.today}。`,
        `[官方公告](${job.url})`, '',
        ...(job.conditionExcerpt || job.announcementText || job.announcementTitle ? ['<details>', '<summary>查看岗位原文及公告摘录</summary>', ''] : []),
        ...(job.conditionExcerpt ? [`岗位原文摘录：${escape(job.conditionExcerpt)}`] : []),
        ...(job.announcementTitle ? [`所属公告：${escape(job.announcementTitle)}`] : []),
        ...(job.announcementText ? [`公告正文摘录（非完整原文）：${escape(job.announcementText.slice(0, 1200))}`] : []),
        ...(job.conditionExcerpt || job.announcementText || job.announcementTitle ? ['', '</details>', ''] : []));
    }
  }
  lines.push('## 来源状态', '', '<details>', '<summary>展开来源检查与异常详情</summary>', '');
  for (const item of coverage) lines.push(`- ${escape(item.name)}：${item.ok ? `检查成功，解析公告 ${item.articles} 篇` : `检查失败：${escape(item.error)}`}${item.warnings?.length ? `；${item.warnings.map(escape).join('；')}` : ''}`);
  lines.push('', '</details>', '', '未解析的PDF、旧版XLS或图片附件只作为待人工核实线索，不据此声称岗位符合资格。', '');
  return lines.join('\n');
}

export function wechatData(digest, coverage) {
  const cut = (value, n) => Array.from(value).slice(0, n).join('');
  const jobs = [...digest.physicians, ...digest.technicians];
  const ready = coverage.filter(s => s.ok).length;
  const values = {
    a: digest.today,
    b: `新增${jobs.length}条·来源${ready}/${coverage.length}`,
    l: `影像医师${digest.physicians.length}条`,
    n2: `技师候补${digest.technicians.length}条`,
    q1: jobs[0] ? cut(`${jobs[0].organization}：${jobs[0].title}`, 60) : '今日暂无新增匹配信息',
    q2: cut(jobs.map((job, i) => `${i + 1}. ${job.province}｜${job.organization}｜${job.status === 'priority' ? '优先关注' : '待核实'}｜截止${job.deadline || '待核对'}`).join('\n') || '点击查看来源检查与招聘简报。', 180),
    m1: cut(digest.reminders.map(job => `${job.organization} ${job.deadline}截止`).join('；') || '暂无临期提醒', 60),
    m2: ready < coverage.length ? '部分来源失败，请查看简报' : '点击查看详情与官方公告',
  };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, color: '#173177' }]));
}

import crypto from 'node:crypto';
import { load } from 'cheerio';

export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
export const chinaDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now);
const dayNumber = value => Date.parse(`${value}T00:00:00+08:00`) / 86400000;
export const daysBetween = (a, b) => Math.round(dayNumber(a) - dayNumber(b));
export const imaging = /医学影像|影像医学|放射(?:科|诊断|影像)|影像(?:科|中心|诊断|医师|技师)|\b(?:CT|MRI|MR)\b|磁共振|核磁/i;
const recruitment = /招聘|招录|人才引进|诚聘|招贤/;
const procedural = /拟聘|拟录|公示|面试(?:名单|成绩|通知)|笔试(?:成绩|通知)|体检|递补|资格(?:复审|审查结果)|考试\s*(?:的\s*)?通知$/;

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
  for (const selector of ['.v_news_content', '#vsb_content', '.TRS_Editor', '.article-content', '.article_content', '#article', 'article', 'main']) {
    const node = $(selector).first();
    if (clean(node.text()).length > 50) { content = node; break; }
  }
  const title = clean($('meta[property="og:title"]').attr('content') || $('h1').first().text() || $('title').text());
  const text = clean(content.text());
  const dateHint = $('meta[property="article:published_time"],meta[name="PubDate"],meta[name="pubdate"]').first().attr('content')
    || clean($('time,.publish-time,.pubtime,.article-time').first().text())
    || clean($('body').text()).match(/(?:发布时间|发布日期|发表时间|来源时间)\s*[:：]?\s*(20\d{2}[年./-]\d{1,2}[月./-]\d{1,2})/)?.[1]
    || title.match(/20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}/)?.[0] || '';
  const published = datesIn(dateHint, 2000)[0] || null;
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
    const format = (link.url.match(/\.(xlsx?|pdf)(?:\?|$)/i)?.[1]
      || link.title.match(/\.(xlsx?|pdf)$/i)?.[1])?.toLowerCase();
    return format ? [{ ...link, format }] : [];
  });
  return { title, text, published, rows, attachments, url };
}

function excerpt(text, pattern) {
  const index = text.search(pattern);
  return index < 0 ? '' : text.slice(Math.max(0, index - 10), index + 100);
}

export function jobFrom(text, page, source, profile, rowNumber = 0) {
  if (!imaging.test(text)) return null;
  const structured = rowNumber > 0;
  const fields = Object.fromEntries(text.split('；').map(part => {
    const separator = part.indexOf('：');
    return separator < 0 ? ['', ''] : [clean(part.slice(0, separator)), clean(part.slice(separator + 1))];
  }));
  const position = Object.entries(fields).filter(([key]) => /岗位名称|招聘岗位|职位名称|^岗位$|^科室$|招聘科室|部门/.test(key)).map(([, value]) => value).filter(Boolean).join('｜');
  const roleText = position || text;
  const role = /技师|技术岗|医学影像技术/.test(roleText) && !/医师/.test(roleText) ? 'technician' : 'physician';
  if (/科研|研究助理|博士后|教师|实验员|行政|工程师|研究员/.test(position || page.title) && !/医师|技师/.test(position || page.title)) return null;
  const title = clean(position || excerpt(text, imaging)).slice(0, 100);
  const conditions = structured ? text : '';
  // A hospital-wide PhD requirement must not reject a separate master's opening.
  const doctorateOnly = /博士/.test(conditions) && !/硕士|本科|学士/.test(conditions);
  const cohorts = [...conditions.matchAll(/(20\d{2})\s*届/g)].map(m => Number(m[1]));
  const wrongCohort = cohorts.length > 0 && !cohorts.includes(profile.graduationYear) && !/往届|不限/.test(conditions);
  const requirements = [];
  if (!structured) requirements.push('公告线索：具体岗位条件需核对原文或附件');
  if (!/硕士/.test(text)) requirements.push('是否接受硕士待确认');
  if (!new RegExp(`${profile.graduationYear}\\s*届`).test(text)) requirements.push(`是否接受${profile.graduationYear}届待确认`);
  if (/报名时|报名前/.test(text) && /毕业证|学位证/.test(text)) requirements.push('注意报名时取得学历学位证的要求');
  if (/执业(?:医师)?证|执业注册|医师执业/.test(text)) requirements.push('医师执业注册情况待核对');
  if (/规培|规范化培训/.test(text)) requirements.push('核对规培专业及证书要求');
  if (/工作经验|工作经历|从业经验/.test(text)) requirements.push('核对工作经历要求');
  if (role === 'technician') requirements.push('核对是否接受医学影像学及技师资格要求');
  requirements.push('核对学硕/专硕、专业代码及其他资格条件');
  const deadline = extractDeadline(text, Number((page.published || chinaDate()).slice(0, 4)))
    || extractDeadline(page.text, Number((page.published || chinaDate()).slice(0, 4)));
  const matches = [];
  if (/硕士/.test(text)) matches.push('公告提及硕士');
  if (new RegExp(`${profile.graduationYear}\\s*届`).test(`${page.title} ${text}`)) matches.push(`公告提及${profile.graduationYear}届`);
  if (/CT|计算机断层/i.test(text)) matches.push('涉及CT');
  const code = Object.entries(fields).find(([key]) => /岗位代码|岗位编号|职位代码|职位编号/.test(key))?.[1];
  const identity = code || `${title}#${Object.entries(fields).filter(([key]) => /专业/.test(key)).map(([, value]) => value).join('|')}`;
  const id = hash(`${page.url}#${structured ? identity : 'announcement'}`);
  const fingerprint = hash(JSON.stringify({ text: clean(text), deadline, title: page.title }));
  const field = pattern => Object.entries(fields).filter(([key]) => pattern.test(key)).map(([, value]) => value).filter(Boolean).join('；');
  const employer = field(/招聘单位|单位名称|用人单位/);
  return {
    id, fingerprint, title: structured ? title : page.title,
    organization: employer || (/医院/.test(source.name) ? source.name : `${source.name}发布（单位见公告）`),
    sourceName: source.name, degreeRequirement: field(/学历|学位/), specialtyRequirement: field(/专业/),
    headcount: field(/人数|计划数|招聘数量/), conditionExcerpt: structured ? clean(text).slice(0, 800) : '',
    province: source.province, role, url: page.url, published: page.published,
    deadline, matches, requirements, structured,
    status: structured && /硕士/.test(text) && new RegExp(`${profile.graduationYear}\\s*届`).test(text) ? 'priority' : 'review',
    excluded: doctorateOnly ? '该岗位仅列博士学历' : wrongCohort ? '届别不符' : null,
  };
}

export function rankJobs(jobs, config) {
  return [...jobs].sort((a, b) => {
    const score = job => (job.role === 'physician' ? 1000 : 0)
      + (job.province === config.profile.preferredProvince ? 100 : 0)
      + (job.status === 'priority' ? 40 : 0) + job.matches.length * 5;
    return score(b) - score(a) || (b.published || '').localeCompare(a.published || '') || a.id.localeCompare(b.id);
  });
}

export function planDigest(jobs, state, config, today) {
  const unique = [...new Map(jobs.filter(job => !job.excluded).map(job => [job.id, job])).values()];
  const active = rankJobs(unique.filter(job => !job.deadline || daysBetween(job.deadline, today) >= 0), config);
  const unseen = active.filter(job => !state.sent[job.id] || state.sent[job.id].fingerprint !== job.fingerprint);
  const physicians = unseen.filter(job => job.role === 'physician').slice(0, config.maxPhysicians);
  const technicians = unseen.filter(job => job.role === 'technician').slice(0, config.maxTechnicians);
  const selected = new Set([...physicians, ...technicians].map(job => job.id));
  const reminders = active.filter(job => job.deadline && !selected.has(job.id) && state.sent[job.id]
    && daysBetween(job.deadline, today) <= config.reminderDays
    && state.reminded[job.id] !== job.deadline).slice(0, config.maxReminders);
  return { today, physicians, technicians, reminders, activeCount: active.length };
}

export function markDelivered(state, digest, recipient, deliveredAt) {
  const copy = structuredClone(state);
  copy.recipients ||= {};
  const bucket = copy.recipients[recipient] ||= { sent: {}, reminded: {} };
  for (const job of [...digest.physicians, ...digest.technicians]) bucket.sent[job.id] = { fingerprint: job.fingerprint, deliveredAt };
  for (const job of digest.reminders) bucket.reminded[job.id] = job.deadline;
  return copy;
}

export function renderMarkdown(digest, coverage) {
  const escape = value => clean(value).replace(/[\[\]<>*`|]/g, '');
  const lines = [`# 医学影像招聘日报 · ${digest.today}`, '', `来源检查：${coverage.filter(s => s.ok).length}/${coverage.length} 个来源成功。`,
    '适用方向：2027届硕士、CT方向，规培完成、已取得医师资格；所有资格以官方公告为准。', ''];
  for (const [label, jobs] of [['影像医师', digest.physicians], ['技师候补', digest.technicians], ['截止提醒', digest.reminders]]) {
    lines.push(`## ${label}`, '');
    if (!jobs.length) lines.push('本次无新增或提醒。', '');
    for (const job of jobs) {
      lines.push(`### ${escape(job.organization)}｜${escape(job.title)}`, '',
        `地区：${escape(job.province)}；${job.status === 'priority' ? '优先关注' : '待核实线索'}；截止：${job.deadline || '公告未明确，需核对'}。`,
        `学历/学位：${escape(job.degreeRequirement) || '见原公告'}；专业：${escape(job.specialtyRequirement) || '见原公告'}；人数：${escape(job.headcount) || '待核对'}。`,
        `依据：${job.matches.map(escape).join('；') || '涉及影像相关岗位，具体资格待核实'}。`,
        `待核对：${job.requirements.map(escape).join('；')}。`,
        ...(job.conditionExcerpt ? [`岗位原文摘录：${escape(job.conditionExcerpt)}`] : []),
        `发布日期：${job.published || '未识别'}；采集日期：${job.collectedAt || digest.today}。`,
        `[官方公告](${job.url})`, '');
    }
  }
  lines.push('## 来源状态', '');
  for (const item of coverage) lines.push(`- ${escape(item.name)}：${item.ok ? `检查成功，解析公告 ${item.articles} 篇` : `检查失败：${escape(item.error)}`}${item.warnings?.length ? `；${item.warnings.map(escape).join('；')}` : ''}`);
  lines.push('', '未解析的PDF、旧版XLS或图片附件只作为待人工核实线索，不据此声称岗位符合资格。', '');
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

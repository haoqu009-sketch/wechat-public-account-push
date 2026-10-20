import { load } from 'cheerio';
import { clean, imaging, jobFrom, safeUrl, publicationDateFromText, daysBetween } from './core.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const nonClinical = /科研|博士后|教师|护理|护士|实验员|工程师|学科带头人|负责人|主任/;
const province = value => clean(value).match(/^(北京|天津|上海|重庆|黑龙江|吉林|辽宁|河北|河南|山东|山西|陕西|甘肃|青海|四川|云南|贵州|湖南|湖北|安徽|江苏|浙江|江西|福建|广东|广西|海南|内蒙古|宁夏|新疆|西藏)/)?.[1] || '';
const date = value => {
  const candidate = String(value || '').slice(0, 10);
  return /^20\d{2}-\d{2}-\d{2}$/.test(candidate) && new Date(`${candidate}T00:00:00Z`).toISOString().slice(0, 10) === candidate ? candidate : null;
};

export function robotsAllowed(text, url) {
  const target = new URL(url).pathname + new URL(url).search;
  let applies = false, rules = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.split('#')[0].trim().match(/^(user-agent|disallow|allow)\s*:\s*(.*)$/i);
    if (!match) continue;
    const directive = match[1].toLowerCase(), value = match[2].trim();
    if (directive === 'user-agent') { applies = value === '*' || /MedicalImagingRecruitmentDigest/i.test(value); continue; }
    if (!applies || !value) continue;
    const pattern = value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    if (new RegExp(`^${pattern}`).test(target)) rules.push({ allow: directive === 'allow', length: value.length });
  }
  rules.sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
  return !rules.length || rules[0].allow;
}

export function discoverCards(html, source) {
  const $ = load(html), hosts = source.allowedHosts, result = [];
  if (source.provider === 'gaocai') {
    $('a.job-name[href]').each((_, node) => {
      const card = $(node).closest('li'), title = clean($(node).text());
      if (!imaging.test(title) || nonClinical.test(title) || /已下线|已结束|已截止/.test(card.text())) return;
      const notice = card.find('a.job-announcement').first();
      const url = safeUrl(notice.attr('href'), source.url, hosts);
      if (!url || !/^\/announcement\/detail\/\d+\.html$/.test(new URL(url).pathname)) return;
      const info = clean(card.find('.job-info').text()).split('|').map(clean);
      result.push({ url, title, announcement: clean(notice.text()), organization: clean(card.find('.company-name').text()), province: province(info[0]), degree: info[1] || '', headcount: info[2]?.replace(/^招/, '') || '' });
    });
  } else if (source.provider === 'jobmd') {
    $('a[href]').each((_, node) => {
      const url = safeUrl($(node).attr('href'), source.url, hosts);
      if (!url || !/^\/jobnotice\/\d+$/.test(new URL(url).pathname)) return;
      const label = clean($(node).text());
      if (/已结束|已截止|护理|护士|博士研究生|博士后/.test(label)) return;
      result.push({ url, title: '', announcement: clean($(node).find('[title]').attr('title') || label), organization: '', province: '', degree: '', headcount: '' });
    });
  }
  return [...new Map(result.map(item => [`${item.url}#${item.title}`, item])).values()];
}

export function rotatingNotices(cards, { maximum = 16, cycle = Math.floor(Date.now() / 14_400_000) } = {}) {
  const urls = [...new Set(cards.map(card => card.url))];
  const score = url => Math.max(...cards.filter(card => card.url === url).map(card => (/2027/.test(card.announcement) ? 30 : 0) + (card.province === '黑龙江' ? 25 : 0) + (/硕士/.test(card.degree) ? 10 : 0) + (/医师|医生/.test(card.title) ? 10 : 0)));
  urls.sort((a, b) => score(b) - score(a) || Number(b.match(/\d+(?=\D*$)/)?.[0] || 0) - Number(a.match(/\d+(?=\D*$)/)?.[0] || 0));
  if (urls.length <= maximum) return urls;
  const fixed = urls.slice(0, Math.ceil(maximum / 2)), pool = urls.slice(fixed.length), slots = maximum - fixed.length;
  const offset = (cycle * slots) % pool.length;
  return [...fixed, ...Array.from({ length: slots }, (_, index) => pool[(offset + index) % pool.length])];
}

export function parseDiscoveredNotice(html, url, cards, source, config, today) {
  const $ = load(html);
  const title = clean($('h1').first().text()) || cards[0]?.announcement || '';
  const all = clean($('body').text());
  // Only a labeled publisher date / structured metadata is accepted, never the crawl date.
  let published = publicationDateFromText(all);
  $('script[type="application/ld+json"]').each((_, node) => {
    try { const metadata = JSON.parse($(node).text()); published ||= date(metadata.pubDate || metadata.datePublished); } catch { /* Unsupported metadata is not evidence. */ }
  });
  $('script,style,nav,footer,header,noscript').remove();
  let content = source.provider === 'jobmd' ? $('article').first() : $('[class]').filter((_, node) => /^(?:announcement-content|announcement-detail|article-content|article_content|detail-content|content-detail|announcement-text|announcement-detail-content)$/.test($(node).attr('class') || '')).first();
  if (!content.length) content = $('body');
  const raw = clean(content.text());
  const text = raw.split(/附件\/来源打开异常提示|重要风险提示|热门地区|关于丁香人才/)[0].slice(0, 30000);
  if (/页面不存在|人机验证|安全验证|需要打开浏览器JavaScript/.test(text) || text.length < 50) throw new Error('平台公告未提供可解析正文');
  if (published && (daysBetween(today, published) < 0 || daysBetween(today, published) > config.lookbackDays)) return [];
  if (nonClinical.test(title) && !/临床|医技|医师|医生/.test(title)) return [];
  // Recruitment paragraphs only: equipment mentioned in a hospital introduction is NOT a vacancy.
  const recruitmentText = text.split(/医院简介|单位简介|【尖端设备|【一院两址|附件资料|查看联系方式/)[0];
  const fallbackTitles = [...new Set((recruitmentText.match(/(?:[\p{Script=Han}A-Za-z]{0,12})(?:放射科|医学影像科|影像科|超声科|核磁共振科)(?:医师|医生|技师|技术岗)?/gu) || []).filter(value => !nonClinical.test(value)))];
  const selected = source.provider === 'gaocai' ? cards : fallbackTitles.map(value => ({ title: value }));
  const organization = cards[0]?.organization || all.match(/发布单位\s*([^\s]{2,70}?)(?=工作地点)/)?.[1] || title.match(/^(.{2,80}?医院)/)?.[1] || '用人单位待核实';
  return selected.flatMap((card, index) => {
    if (!imaging.test(card.title) || nonClinical.test(card.title)) return [];
    const position = recruitmentText.indexOf(card.title), excerpt = position >= 0 ? recruitmentText.slice(Math.max(0, position - 15), position + 700) : '';
    // A listing without matching notice text remains a clue, not a confirmed vacancy.
    const condition = clean(excerpt || '列表涉及该专业，正文及岗位附件需要进一步核对').replace(/[；;]/g, '，');
    const row = `岗位名称：${card.title}；学历要求：${card.degree || ''}；人数：${card.headcount || ''}；条件：${condition}`;
    const job = jobFrom(row, { title, url, published, text: recruitmentText }, { ...source, province: card.province || '', sourceKind: 'aggregator', isRepost: true }, config.profile, index + 1);
    if (!job) return [];
    const employer = /医院|卫生院|医疗中心|卫生服务/.test(organization) ? organization : `${organization}发布（具体用人单位见公告）`;
    return [{ ...job, title: clean(card.title).slice(0, 100), organization: employer, employerExplicit: '', province: card.province || province(all.split('工作地点')[1] || ''), sourceKind: 'aggregator', isRepost: true, role: 'clue', status: 'review', priorityLabel: '平台转载·待核实', requirements: ['平台转载，尚未逐项核对官方岗位表，不能据此确认可报名', ...job.requirements], announcementText: recruitmentText.slice(0, 1200) }];
  });
}

export async function collectDiscovery(source, config, today, options = {}) {
  const jobs = [], observedPages = [], coverage = { name: source.name, ok: false, articles: 0, warnings: [] };
  const request = options.request, pause = options.pause || wait;
  let cards = [], lists = 0;
  try {
    let robots = options.robotsText;
    if (robots === undefined) {
      try { robots = (await request(new URL('/robots.txt', source.url).href, source.allowedHosts)).bytes.toString('utf8'); }
      catch (error) { if (/HTTP 404/.test(error.message)) robots = ''; else throw new Error('发现渠道访问规则暂未确认，本次不继续读取'); }
    }
    for (const entry of (source.entryUrls || [source.url]).slice(0, 4)) {
      const approved = safeUrl(entry, source.url, source.allowedHosts);
      if (!approved) throw new Error('发现栏目不在明确配置的HTTPS范围');
      if (!robotsAllowed(robots, approved)) { coverage.warnings.push('发现栏目受robots访问规则限制，未读取'); continue; }
      try {
        const response = await request(approved, source.allowedHosts);
        const found = discoverCards(response.bytes.toString('utf8'), source);
        if (!found.length) throw new Error('未识别公开招聘列表');
        cards.push(...found); lists++;
      } catch (error) {
        if (/HTTP 403|HTTP 429/.test(error.message || '')) { coverage.warnings.push('平台访问受限（403/429），已停止本轮后续请求，缓存线索需复核'); break; }
        coverage.warnings.push('部分发现栏目未完成读取，不代表没有招聘');
      }
      await pause(700);
    }
    if (!lists) throw new Error('发现渠道未提供可解析的公开列表');
    const notices = rotatingNotices(cards, { maximum: Math.min(source.maxDetails || 16, 20), cycle: options.cycle });
    if (new Set(cards.map(card => card.url)).size > notices.length) coverage.warnings.push('发现公告超过本轮上限，优先匹配项并滚动读取其余公告，未覆盖全部信息');
    for (const url of notices) {
      if (!robotsAllowed(robots, url)) { coverage.warnings.push('公告受robots访问规则限制，未读取'); continue; }
      try {
        const response = await request(url, source.allowedHosts);
        const parsed = parseDiscoveredNotice(response.bytes.toString('utf8'), response.url, cards.filter(card => card.url === url), source, config, today);
        jobs.push(...parsed); coverage.articles++; observedPages.push(url);
      } catch (error) {
        if (/HTTP 403|HTTP 429/.test(error.message || '')) { coverage.warnings.push('平台访问受限（403/429），已停止本轮后续请求，缓存线索需复核'); break; }
        coverage.warnings.push('部分平台公告读取失败或受限，未绕过验证');
      }
      await pause(700);
    }
    if (!coverage.articles) throw new Error('发现渠道公告详情均未完成检查');
    coverage.ok = true;
    coverage.warnings.push('此渠道为聚合发现，结果仅进入待核实线索区，不计入已核验医师或技师岗位');
  } catch (error) { coverage.error = error.message; }
  coverage.warnings = [...new Set(coverage.warnings)];
  return { jobs, coverage, observedPages };
}

import { load } from 'cheerio';
import { clean, classifyLink, safeUrl } from './core.mjs';

// Official regional directories cover changing employers, not a fixed hospital list.
// Keep each crawl bounded: newest/high-relevance notices + a rotating older slice.
// These hints choose what to read; they never prove a publication date or eligibility.
export function directoryNotices(html, base, hosts) {
  const $ = load(html), found = new Map();
  $('a[href]').each((_, node) => {
    const anchor = $(node), url = safeUrl(anchor.attr('href'), base, hosts);
    const title = clean(anchor.attr('title') || anchor.text());
    if (!url || url === base || classifyLink({ title }) !== 'article'
      || /\.(?:xlsx?|docx?|pdf|zip|png|jpe?g)(?:\?|$)/i.test(url)
      || /进入面试|面试人员|面试资格|政策性加分|资格审核|笔试公告|操作指[南导]|考试须知|报名操作|招聘会|培训|采购|招标/.test(title)) return;
    if (!found.has(url)) found.set(url, { url, title });
  });
  return [...found.values()];
}

export function selectDirectoryNotices(notices, today, now = Date.now(), limit = 12) {
  const year = Number(today.slice(0, 4));
  const score = item => (/医学影像|放射|超声|CT|MRI/i.test(item.title) ? 12 : 0)
    + (/医院|卫生|医疗|医科/.test(item.title) ? 6 : 0)
    + (item.title.includes(String(year + 1)) ? 4 : item.title.includes(String(year)) ? 2 : 0);
  const pool = [...new Map(notices.map(item => [item.url, item])).values()].slice(0, 80)
    .map((item, order) => ({ ...item, order, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  if (pool.length <= limit) return pool;
  const fixed = Math.ceil(limit / 2), rest = pool.slice(fixed);
  const offset = (Math.floor(now / 14_400_000) * (limit - fixed)) % rest.length;
  return [...pool.slice(0, fixed), ...rest.slice(offset), ...rest.slice(0, offset)].slice(0, limit);
}

const $ = id => document.getElementById(id);
const tabs = [...document.querySelectorAll('[data-tab]')];
const state = { report: null, jobs: [], tab: 'all', versionNotice: '', loading: false };
const normalText = value => typeof value === 'string' ? value : '';
const validDate = value => {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const beijingDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dayDistance = (date, from = beijingDate()) => validDate(date) && validDate(from) ? Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) : null;
const dateLabel = value => validDate(value) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${value}T12:00:00+08:00`)) : '尚未识别';
const isClosing = job => { const days = dayDistance(job.deadline); return days !== null && days >= 0 && days <= 3; };

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = String(content);
  return node;
}

function safeHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null;
  } catch { return null; }
}

function link(label, value, className) {
  const href = safeHttps(value);
  if (!href) return element('span', 'invalid-link', '官方链接待核实');
  const anchor = element('a', className, label);
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.referrerPolicy = 'no-referrer';
  return anchor;
}

function validateReport(report) {
  if (!report || report.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(report.reportId || '')
    || !validDate(report.reportDate) || !Number.isFinite(Date.parse(report.generatedAt))
    || !report.summary || !Array.isArray(report.summary.limitations) || !Array.isArray(report.jobs) || !Array.isArray(report.sources)) throw new Error('报告结构不完整');
  if (report.leads !== undefined && !Array.isArray(report.leads)) throw new Error('招聘线索结构异常');
  if ([...report.jobs, ...(report.leads || [])].some(job => !job || typeof job.id !== 'string' || typeof job.title !== 'string'
    || typeof job.organization !== 'string' || typeof job.province !== 'string'
    || !['physician', 'technician', 'clue'].includes(job.role) || !['priority', 'review'].includes(job.status)
    || !Array.isArray(job.qualityReasons) || !Array.isArray(job.requirements)
    || (job.deadline !== null && !validDate(job.deadline)))) throw new Error('岗位数据结构异常');
  if (report.sources.some(source => !source || typeof source.name !== 'string' || typeof source.ok !== 'boolean'
    || !Array.isArray(source.warnings) || !Number.isInteger(source.articles) || source.articles < 0)) throw new Error('来源数据结构异常');
  return report;
}

async function fetchReport(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!response.ok) throw new Error('采集报告暂时不可用');
    return validateReport(await response.json());
  } finally { clearTimeout(timer); }
}

async function getReport() {
  const version = new URLSearchParams(location.search).get('report');
  state.versionNotice = '';
  if (version && /^[a-f0-9]{24}$/.test(version)) {
    try {
      const archived = await fetchReport(`./data/${version}.json`);
      if (archived.reportId !== version) throw new Error('报告版本不一致');
      state.versionNotice = '正在查看这条推送对应的报告快照。截止天数仍按北京时间今日计算，报名状态请核对官方公告。';
      return archived;
    } catch {
      state.versionNotice = '这条推送对应的历史报告暂不可用，以下已切换为最新采集报告，内容可能与原推送不同。';
    }
  } else if (version) {
    state.versionNotice = '链接中的报告版本无效，以下显示最新采集报告。';
  }
  return fetchReport('./data/public.json');
}

function appendList(parent, items, className = '') {
  const list = element('ul', className);
  for (const item of items) if (typeof item === 'string' && item.trim()) list.append(element('li', '', item));
  parent.append(list);
  return list;
}

function setTab(value, focus = false) {
  state.tab = value;
  for (const tab of tabs) {
    const active = tab.dataset.tab === value;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    if (active && focus) tab.focus();
  }
  $('job-results').setAttribute('aria-labelledby', `tab-${value}`);
  if (state.report && !state.loading) renderJobs();
}

function renderMetadata(report) {
  const generated = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(report.generatedAt));
  $('report-date').textContent = `${dateLabel(report.reportDate)} · 生成于 ${generated}（北京时间）`;
  const sourceSuccess = report.sources.filter(source => source.ok).length;
  const sourceTotal = report.sources.length;
  $('coverage-count').textContent = `来源读取 ${sourceSuccess} / ${sourceTotal}`;
  $('coverage-dot').className = `status-dot ${sourceSuccess === sourceTotal && sourceTotal > 0 ? 'healthy' : 'partial'}`;
  $('coverage-brief').textContent = sourceSuccess < sourceTotal
    ? `${sourceTotal - sourceSuccess} 个来源本次未完成检查；未收录不代表没有招聘，资格与报名安排请核对官方公告。`
    : '本次来源读取已完成；具体岗位资格、报名安排与未完整解析的附件，仍需核对官方公告。';
  const limitations = ['仅展示采集到的招聘线索；关注偏好不构成资格判定。报名条件、是否开始报名及最新安排，以官方公告为准。', ...report.summary.limitations.filter(value => typeof value === 'string')];
  if (report.reportDate !== beijingDate()) limitations.unshift(`当前为 ${dateLabel(report.reportDate)} 的采集记录，尚未更新为今日数据；旧记录不表示目前仍可报名。`);
  if (sourceSuccess < sourceTotal) limitations.unshift(`本次有 ${sourceTotal - sourceSuccess} 个来源未完成检查。未收录或无新增，均不能据此判断没有招聘。`);
  $('limitations').replaceChildren(...[...new Set(limitations)].map(value => element('li', '', value)));
  const versionNotice = report.reportDate !== beijingDate()
    ? `历史快照 · ${dateLabel(report.reportDate)}。这份记录并非今日采集，旧信息可能已变化。${state.versionNotice}`
    : state.versionNotice;
  $('version-notice').hidden = !versionNotice;
  $('version-notice').textContent = versionNotice;
  $('report-id').textContent = `报告编号 ${report.reportId}`;

  const today = beijingDate();
  state.jobs = [...report.jobs, ...(report.leads || [])].filter(job => !validDate(job.deadline) || job.deadline >= today).map((job, index) => ({ ...job, originalIndex: index }));
  const count = role => state.jobs.filter(job => job.role === role).length;
  const clinical = state.jobs.filter(job => job.role !== 'clue'), leads = count('clue');
  const closing = clinical.filter(isClosing).length;
  $('active-count').textContent = String(clinical.length);
  $('new-count').textContent = String(leads);
  $('closing-count').textContent = String(closing);
  $('tab-count-all').textContent = String(clinical.length);
  $('tab-count-clue').textContent = String(leads);
  $('lead-summary').textContent = leads ? `另有 ${leads} 条待核实招聘线索，可切换上方标签查看。转载、职业类型不明或PDF文字线索均不计入岗位数，请核对原始岗位表。` : '公开岗位与待核实线索分别统计，资格及报名状态以官方最新公告为准。';
  $('tab-count-physician').textContent = String(count('physician'));
  $('tab-count-technician').textContent = String(count('technician'));
  $('tab-count-closing').textContent = String(closing);

  const previous = $('province').value;
  const provinces = [...new Set(state.jobs.map(job => job.province).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const options = [element('option', '', '全部地区'), ...provinces.map(province => { const option = element('option', '', province); option.value = province; return option; })];
  options[0].value = '';
  $('province').replaceChildren(...options);
  $('province').value = provinces.includes(previous) ? previous : '';
  renderSources(report.sources);
}

function renderSources(sources) {
  $('source-summary').textContent = `来源读取 ${sources.filter(source => source.ok).length} / ${sources.length}`;
  const nodes = sources.map(source => {
    const item = element('li', 'source-item');
    const line = element('div', 'source-line');
    line.append(link(source.name, source.url, 'source-name'), element('span', `source-status${source.ok ? '' : ' failed'}`, source.ok ? '读取成功' : '尚未完成检查'));
    item.append(line, element('p', 'source-description', source.ok ? `本次解析公告 ${source.articles} 篇，仍需核对具体资格与附件。` : normalText(source.error) || '本次来源读取未完成，请核对官方页面。'));
    if (source.warnings.length) appendList(item, source.warnings, 'source-warnings');
    return item;
  });
  $('source-list').replaceChildren(...nodes);
}

function fact(label, value, className = '') {
  const row = element('div', className);
  row.append(element('dt', '', label), element('dd', '', value || '待核对原文'));
  return row;
}

function renderCard(job) {
  const item = element('li');
  const card = element('article', 'job-card');
  const top = element('div', 'card-top');
  const badges = element('div', 'badges');
  const verification = job.verification;
  const verdict = { matched: '已核对关键条件', partial: '已核验 · 有具体疑点', blocked: '材料未取得或未对应', mismatch: '存在明确不匹配' };
  badges.append(element('span', `badge ${job.status === 'priority' ? 'badge-priority' : ''}`, verdict[verification?.state] || job.priorityLabel || '待核实线索'));
  if (job.isNew) badges.append(element('span', 'badge badge-new', '本轮候选'));
  if (job.stale || job.sourceHealthy === false) badges.append(element('span', 'badge badge-stale', '缓存待复核'));
  top.append(badges, element('span', 'province', job.province || '地区待核实'));
  card.append(top, element('h3', 'job-title', job.title), element('p', 'organization', job.organization));
  card.append(element('p', 'direction', `${job.role === 'physician' ? '影像医师' : job.role === 'technician' ? '技师候补' : '未核验招聘线索'} · ${job.directionLabel || '具体方向待核对'}`));
  if (verification) {
    card.append(element('p', 'verification-summary', verification.summary));
    if (verification.issues?.length) appendList(card, verification.issues, 'verification-issues');
  }
  const facts = element('dl', 'job-facts');
  facts.append(fact('学历 / 学位', job.degreeRequirement), fact('专业要求', job.specialtyRequirement, 'fact-specialty'), fact('人数', job.headcount, 'fact-headcount'));
  card.append(facts);
  const deadlineRow = element('div', 'deadline-row');
  const days = dayDistance(job.deadline);
  const rolling = verification?.evidence?.find(item => item.field === 'application' && /招满即止/.test(item.value));
  const deadline = days === null ? rolling ? '招满即止' : '原文尚无明确截止依据' : `${dateLabel(job.deadline)}${days === 0 ? ' · 今日截止' : days <= 3 ? ` · ${days}天后截止` : ''}`;
  deadlineRow.append(element('span', 'deadline-label', '报名截止'), element('span', `deadline-value${days === null ? ' unknown' : days <= 3 ? ' urgent' : ''}`, deadline));
  deadlineRow.append(element('span', 'deadline-note', rolling ? '公告接受报名，不代表岗位仍有空缺' : '以原文报名安排及最新调整为准'));
  card.append(deadlineRow);
  if (!verification && job.qualityReasons.length) appendList(card, job.qualityReasons.slice(0, 3), 'quality-reasons');

  const bottom = element('div', 'card-bottom');
  const details = element('details', 'job-details');
  details.append(element('summary', '', verification ? '查看逐项证据与核验过程' : '条件摘录与核对事项'));
  const body = element('div', 'detail-body');
  if (verification) {
    body.append(element('h4', '', '已取得的原文证据'));
    for (const proof of verification.evidence || []) {
      const section = element('div', 'verification-evidence');
      section.append(element('p', 'evidence-value', proof.value), element('blockquote', 'excerpt', proof.quote), link(`${proof.locator} ↗`, proof.url, 'evidence-link'));
      body.append(section);
    }
    if (!verification.evidence?.length) body.append(element('p', '', '本次尚未取得可确认具体条件的原始证据，没有用平台摘要代替官方核验。'));
    if (verification.attempts?.length) {
      body.append(element('h4', '', '本次实际核验过程'));
      const list = element('ul', 'verification-attempts');
      for (const attempt of verification.attempts) {
        const item = element('li'); item.append(element('span', '', attempt.reason + ' '), link('查看对应页面 ↗', attempt.url, 'evidence-link')); list.append(item);
      }
      body.append(list);
    }
    body.append(element('p', 'source-note', `核验时间：${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(verification.checkedAt))}（北京时间）。只核对已知条件，不替代招聘方资格审核。`));
  } else if (job.requirements.length) { body.append(element('h4', '', '尚待核对')); appendList(body, job.requirements); }
  if (job.conditionExcerpt) body.append(element('h4', '', '岗位条件摘录'), element('p', 'excerpt', job.conditionExcerpt));
  if (job.announcementTitle) body.append(element('h4', '', '所属公告'), element('p', '', job.announcementTitle));
  if (job.announcementText) body.append(element('h4', '', '公告正文摘录（非完整原文）'), element('p', 'excerpt', job.announcementText));
  const dates = element('dl', 'detail-dates');
  dates.append(fact('发布日期', dateLabel(job.published)), fact('采集日期', dateLabel(job.collectedAt)));
  body.append(dates, element('p', 'source-note', `采集来源：${job.sourceName || '待核实'}${job.sourceHealthy ? '' : ' · 本次未完成检查，需复核最新公告'}`));
  details.append(body);
  bottom.append(details, link(verification?.officialUrl ? '查看核验原文 ↗' : job.role === 'clue' ? '查看来源原文 ↗' : '查看官方原文 ↗', verification?.officialUrl || job.url, 'official-link'));
  card.append(bottom);
  item.append(card);
  return item;
}

function filteredJobs() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const province = $('province').value;
  const focus = $('focus').value;
  const jobs = state.jobs.filter(job => {
    if (state.tab === 'clue' ? job.role !== 'clue' : job.role === 'clue') return false;
    if (state.tab === 'closing' && !isClosing(job)) return false;
    if (['physician', 'technician'].includes(state.tab) && job.role !== state.tab) return false;
    if (province && job.province !== province) return false;
    if (focus === 'ct' && !['ct', 'mixed'].includes(job.focusMatch)) return false;
    if (focus === 'other' && job.focusMatch !== 'other') return false;
    if (focus === 'unknown' && !['unknown', undefined, null, ''].includes(job.focusMatch)) return false;
    if (query && ![job.title, job.organization, job.sourceName, job.specialtyRequirement, job.degreeRequirement, job.directionLabel].join(' ').toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  if ($('sort').value === 'deadline') jobs.sort((a, b) => (validDate(a.deadline) ? Date.parse(a.deadline) : Infinity) - (validDate(b.deadline) ? Date.parse(b.deadline) : Infinity) || a.originalIndex - b.originalIndex);
  if ($('sort').value === 'published') jobs.sort((a, b) => (validDate(b.published) ? Date.parse(b.published) : -Infinity) - (validDate(a.published) ? Date.parse(a.published) : -Infinity) || a.originalIndex - b.originalIndex);
  return jobs;
}

function renderJobs() {
  const jobs = filteredJobs();
  const selectedFilters = Number(Boolean($('province').value)) + Number(Boolean($('focus').value)) + Number($('sort').value !== 'recommended');
  $('more-filter-summary').textContent = selectedFilters ? `已启用 ${selectedFilters} 项` : '地区 · 方向 · 排序';
  $('jobs').replaceChildren(...jobs.map(renderCard));
  const total = state.jobs.filter(job => state.tab === 'clue' ? job.role === 'clue' : job.role !== 'clue').length;
  $('result-count').textContent = `${state.tab === 'clue' ? '待核实线索' : '岗位'}共 ${total} 条 · 显示 ${jobs.length} 条`;
  $('empty-state').hidden = jobs.length > 0;
  $('retry').hidden = true;
  $('reset-filters').hidden = total === 0;
  if (!jobs.length && total) {
    $('empty-title').textContent = '没有符合当前筛选的岗位';
    $('empty-description').textContent = '可以缩短关键词、调整地区或影像方向，也可以清除全部筛选后查看。';
  } else if (!jobs.length) {
    $('empty-title').textContent = state.tab === 'clue' ? '本次暂无可展示的待核实线索' : '本次暂无可展示的岗位';
    $('empty-description').textContent = '空列表不代表没有招聘。可切换岗位与待核实线索标签；部分来源、附件或报名条件尚未核验，请查看下方来源诊断。';
  }
}

async function load() {
  if (state.loading) return;
  state.loading = true;
  $('refresh').disabled = true;
  $('job-results').setAttribute('aria-busy', 'true');
  $('loading').hidden = false;
  $('empty-state').hidden = true;
  $('jobs').replaceChildren();
  $('result-count').textContent = '正在加载真实采集数据…';
  try {
    const report = await getReport();
    state.report = report;
    renderMetadata(report);
    renderJobs();
  } catch {
    state.report = null;
    state.jobs = [];
    $('report-date').textContent = '暂未取得有效的采集日期与生成时间';
    for (const id of ['active-count', 'new-count', 'closing-count', 'tab-count-all', 'tab-count-physician', 'tab-count-technician', 'tab-count-closing', 'tab-count-clue']) $(id).textContent = '—';
    $('lead-summary').textContent = '';
    $('coverage-dot').className = 'status-dot partial';
    $('coverage-count').textContent = '状态未取得';
    $('coverage-brief').textContent = '来源状态暂未取得，无法判断本次覆盖范围或有无招聘，请稍后重试。';
    $('limitations').replaceChildren(element('li', '', '目前无法读取有效采集报告，不能据此判断有无招聘。请稍后重试，并以官方公告为准。'));
    $('result-count').textContent = '数据加载失败';
    $('empty-title').textContent = '暂时无法读取招聘报告';
    $('empty-description').textContent = '可能尚未发布本次采集文件，或当前网络暂不可用。页面没有使用示例岗位或替代内容，请稍后重新读取。';
    $('empty-state').hidden = false;
    $('retry').hidden = false;
    $('reset-filters').hidden = true;
    $('source-summary').textContent = '尚未取得来源状态';
    $('source-list').replaceChildren();
    $('report-id').textContent = '';
    $('version-notice').hidden = true;
  } finally {
    state.loading = false;
    $('refresh').disabled = false;
    $('loading').hidden = true;
    $('job-results').setAttribute('aria-busy', 'false');
  }
}

for (const tab of tabs) {
  tab.addEventListener('click', () => setTab(tab.dataset.tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setTab(tabs[next].dataset.tab, true);
  });
}
for (const id of ['search', 'province', 'focus', 'sort']) $(id).addEventListener(id === 'search' ? 'input' : 'change', () => { if (state.report && !state.loading) renderJobs(); });
$('reset-filters').addEventListener('click', () => {
  $('search').value = '';
  $('province').value = '';
  $('focus').value = '';
  $('sort').value = 'recommended';
  setTab('all');
});
$('refresh').addEventListener('click', load);
$('retry').addEventListener('click', load);
load();

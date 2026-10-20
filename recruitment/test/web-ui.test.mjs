import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createPublicReport } from '../public-report.mjs';
import { jobFrom, chinaDate } from '../core.mjs';

const today = chinaDate(), source = { id: 'fixture', name: '测试医院', url: 'https://hospital.example/', province: '黑龙江' };
const config = { profile: { graduationYear: 2027, preferredProvince: '黑龙江' }, lookbackDays: 90, sources: [source] };
const job = jobFrom('岗位名称：放射科医师；专业：医学影像学；学历：硕士；条件：2027届', { title: '招聘公告', url: 'https://hospital.example/jobs', text: '', published: today }, source, config.profile, 1);
const report = () => createPublicReport({ jobs: [job, { ...job, id: 'lead', title: '<img src=x onerror=alert(1)>影像医生', role: 'clue', sourceKind: 'aggregator', organization: '新发现医院' }], digest: { today, physicians: [job], technicians: [], reminders: [] }, config, coverage: [{ name: source.name, ok: true, articles: 1, warnings: [] }] });
async function page(t, data) {
  const html = await fs.readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const script = await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://jobs.example/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  dom.window.fetch = async () => Response.json(data);
  dom.window.AbortController = AbortController;
  dom.window.eval(script);
  await new Promise(resolve => setImmediate(resolve));
  return dom.window;
}

test('页面岗位数与线索数独立统计，线索不会默认混入正式岗位', async t => {
  const window = await page(t, report()), document = window.document;
  assert.equal(document.getElementById('active-count').textContent, '1');
  assert.equal(document.getElementById('new-count').textContent, '1');
  assert.equal(document.querySelectorAll('#jobs .job-card').length, 1);
  assert.match(document.getElementById('lead-summary').textContent, /另有 1 条/);
  document.getElementById('tab-clue').click();
  assert.equal(document.querySelectorAll('#jobs .job-card').length, 1);
  assert.match(document.querySelector('#jobs .official-link').textContent, /来源原文/);
  assert.match(document.querySelector('#jobs .direction').textContent, /未核验/);
  assert.equal(document.querySelectorAll('#jobs img').length, 0);
});

test('线索区关键词筛选、空状态及切回岗位可正常使用', async t => {
  const window = await page(t, report()), document = window.document;
  document.getElementById('tab-clue').click();
  const input = document.getElementById('search');
  input.value = '不存在的医院'; input.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('#jobs .job-card').length, 0);
  assert.equal(document.getElementById('empty-state').hidden, false);
  document.getElementById('reset-filters').click();
  assert.equal(document.getElementById('tab-all').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelectorAll('#jobs .job-card').length, 1);
});

test('旧快照没有leads仍能显示，坏数据进入明确失败态', async t => {
  const legacy = report(); delete legacy.leads;
  const window = await page(t, legacy);
  assert.equal(window.document.getElementById('active-count').textContent, '1');
  assert.equal(window.document.getElementById('new-count').textContent, '0');
  const broken = await page(t, { ...report(), leads: 'bad' });
  assert.match(broken.document.getElementById('empty-title').textContent, /无法读取/);
  assert.equal(broken.document.querySelectorAll('#jobs .job-card').length, 0);
});

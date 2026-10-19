import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkWechat, testTemplateData } from '../check-wechat.mjs';
import { chinaDate, wechatData } from '../core.mjs';

const env = {
  RECRUITMENT_TEMPLATE_ID: 'test-template',
  ALL_CONFIG: JSON.stringify({ APP_ID: 'app', APP_SECRET: 'secret', USER_INFO: [{ id: 'first' }, { id: 'second' }] }),
  RECRUITMENT_REPORT_URL: 'https://github.com/example/repo/blob/recruitment-state/reports/latest.md',
};

test('招聘模板只读校验不会发送；发送必须显式选择测试模式', async () => {
  let checks = 0;
  const services = {
    getAccessToken: async () => 'token',
    validateTemplates: async () => { checks++; return { templateCount: 1 }; },
    sendMessage: async () => assert.fail('只读校验不应发送'),
    loadPreview: async () => assert.fail('只读校验不应读取日报'),
  };
  await checkWechat([], env, services);
  assert.equal(checks, 1);
  await assert.rejects(checkWechat([], { ...env, RECRUITMENT_TEMPLATE_ID: '' }, services), /缺少 RECRUITMENT_TEMPLATE_ID/);
  assert.equal(checks, 1);
});

test('测试消息逐接收人发送，部分失败仍检查其他接收人，且内容明确标识测试', async () => {
  const attempted = [];
  const services = {
    getAccessToken: async () => 'token',
    validateTemplates: async () => ({ templateCount: 1 }),
    sendMessage: async (user, data, token, url) => {
      attempted.push(user.openId);
      assert.match(data.b.value, /模板测试/);
      assert.match(data.q1.value, /测试消息/);
      assert.equal(token, 'token');
      assert.equal(url, env.RECRUITMENT_REPORT_URL);
      if (user.openId === 'first') throw new Error('模拟发送失败');
    },
  };
  await assert.rejects(checkWechat(['--send-test'], env, services), /1位接收人/);
  assert.deepEqual(attempted, ['first', 'second']);
  assert.deepEqual(Object.keys(testTemplateData()), ['a', 'b', 'l', 'n2', 'q1', 'q2', 'm1', 'm2']);
  assert.ok(Object.values(testTemplateData()).every(item => Array.from(item.value).length <= 18));
});

const preview = () => ({
  digest: { today: chinaDate(), physicians: [], technicians: [], reminders: [] },
  coverage: [{ name: '正常官网', ok: true, articles: 2, warnings: [] }, { name: '暂时不可用官网', ok: false, articles: 0, warnings: [], error: 'HTTP 403' }],
});
const dailyServices = (value, sent = []) => ({
  loadPreview: async () => value,
  getAccessToken: async () => 'token',
  validateTemplates: async () => ({ templateCount: 1 }),
  sendMessage: async (user, data, token, url) => { sent.push({ user, data, token, url }); },
});

test('无候选也使用当天正式日报样式，逐用户发送且不回退模板测试文案', async () => {
  const value = preview(), sent = [];
  await checkWechat(['--send-daily-preview'], env, dailyServices(value, sent));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(item => item.user.openId), ['first', 'second']);
  for (const item of sent) {
    assert.deepEqual(item.data, wechatData(value.digest, value.coverage));
    assert.match(item.data.q1.value, /今日暂无新增匹配信息/);
    assert.doesNotMatch(JSON.stringify(item.data), /模板测试|测试消息|区域显示正常/);
    assert.equal(item.url, env.RECRUITMENT_REPORT_URL);
  }
});

test('过期日报、损坏岗位与来源结构、全来源失败全部拒绝，不触发微信请求', async () => {
  const stale = preview(); stale.digest.today = '2000-01-01';
  const badArray = preview(); badArray.digest.physicians = {};
  const badJob = preview(); badJob.digest.physicians = [{ title: '不完整岗位' }];
  const badCoverage = preview(); badCoverage.coverage[0].ok = 'true';
  const badWarning = preview(); badWarning.coverage[0].warnings = [42];
  const failed = preview(); failed.coverage.forEach(item => { item.ok = false; });
  for (const value of [stale, badArray, badJob, badCoverage, badWarning, failed]) {
    const services = dailyServices(value);
    services.getAccessToken = async () => assert.fail('无效日报不应请求微信');
    services.sendMessage = async () => assert.fail('无效日报不应发送');
    await assert.rejects(checkWechat(['--send-daily-preview'], env, services), /不是今天|结构异常|字段异常|全部来源失败/);
  }
});

test('两种发送标志互斥，拒绝前不读取日报或调用微信', async () => {
  const services = dailyServices(preview());
  services.loadPreview = async () => assert.fail('互斥模式不应读取日报');
  services.getAccessToken = async () => assert.fail('互斥模式不应请求微信');
  await assert.rejects(checkWechat(['--send-test', '--send-daily-preview'], env, services), /不能同时使用/);
});

test('默认从stateDir/reports读取真实日报，不写state、pending或报告', async t => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-daily-preview-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const reportDir = path.join(stateDir, 'reports'), value = preview(), sent = [];
  await fs.mkdir(reportDir);
  const files = new Map([
    [path.join(stateDir, 'state.json'), '{"sent":"keep"}'],
    [path.join(stateDir, 'pending.json'), '{"pending":"keep"}'],
    [path.join(reportDir, 'preview.json'), JSON.stringify(value.digest)],
    [path.join(reportDir, 'source-status.json'), JSON.stringify(value.coverage)],
    [path.join(reportDir, 'latest.md'), '# 当天真实招聘日报'],
  ]);
  for (const [file, text] of files) await fs.writeFile(file, text);
  const services = dailyServices(value, sent);
  delete services.loadPreview;
  await checkWechat(['--send-daily-preview'], { ...env, RECRUITMENT_STATE_DIR: stateDir }, services);
  assert.equal(sent.length, 2);
  for (const [file, text] of files) assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.deepEqual((await fs.readdir(stateDir)).sort(), ['pending.json', 'reports', 'state.json']);
  assert.deepEqual((await fs.readdir(reportDir)).sort(), ['latest.md', 'preview.json', 'source-status.json']);
});

test('reportDir可单独覆盖；损坏JSON不会回退到测试数据', async t => {
  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-preview-report-'));
  t.after(() => fs.rm(reportDir, { recursive: true, force: true }));
  await fs.writeFile(path.join(reportDir, 'preview.json'), '{broken');
  await fs.writeFile(path.join(reportDir, 'source-status.json'), '[]');
  const services = dailyServices(preview());
  delete services.loadPreview;
  services.sendMessage = async () => assert.fail('读取失败不能回退测试消息');
  await assert.rejects(checkWechat(['--send-daily-preview'], { ...env, RECRUITMENT_REPORT_DIR: reportDir }, services), /日报预览读取失败/);
});

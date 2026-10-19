import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, loadState, atomicJson } from '../run.mjs';
import { sync } from '../github-state.mjs';
import { jobFrom, chinaDate } from '../core.mjs';
const config = JSON.parse(await fs.readFile(new URL('../config.json', import.meta.url)));
const today = chinaDate();
const source = { name: '测试医院', province: '黑龙江' };
const job = jobFrom('岗位代码：CT1；岗位：放射科医师；学历：硕士；专业：医学影像学；条件：2027届', { title: '测试招聘', url: 'https://hospital.example/1', text: '', published: today }, source, config.profile, 1);
const coverage = [{ name: source.name, ok: true, articles: 1 }];
const temp = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'recruitment-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const envFor = dir => ({ RECRUITMENT_STATE_DIR: dir, RECRUITMENT_REPORT_URL: 'https://github.com/example/repo/blob/recruitment-state/reports/latest.md', ALL_CONFIG: JSON.stringify({ APP_ID: 'example', APP_SECRET: 'not-real', USER_INFO: [{ id: 'recipient1', wechatTemplateId: 'template' }, { id: 'recipient2', wechatTemplateId: 'template' }] }) });
const collection = async () => ({ jobs: [job], coverage, observedPages: [job.url] });

test('完整采集-报告-部分发送失败-重试：只重试失败接收人', async t => {
  const dir = await temp(t), env = envFor(dir), calls = [];
  const services = { collect: collection, getAccessToken: async () => 'not-real', sendDigest: async user => { calls.push(user.openId); if (user.openId === 'recipient2') throw new Error('模拟失败'); } };
  await run(['--collect-only'], env, services);
  assert.equal(calls.length, 0);
  await assert.rejects(run(['--send-only'], env, services), /1个接收人/);
  assert.deepEqual(calls, ['recipient1', 'recipient2']);
  await run(['--collect-only'], env, services);
  services.sendDigest = async user => { calls.push(user.openId); };
  await run(['--send-only'], env, services);
  assert.deepEqual(calls, ['recipient1', 'recipient2', 'recipient2']);
  const state = await loadState(path.join(dir, 'state.json'));
  assert.equal(Object.keys(state.recipients).length, 2);
  assert.match(await fs.readFile(path.join(dir, 'reports/latest.md'), 'utf8'), /https:\/\/hospital.example\/1/);
});

test('预览不改变状态；全来源失败不发送、不覆盖已有发送记录', async t => {
  const dir = await temp(t), env = envFor(dir);
  const original = { version: 1, jobs: {}, recipients: { existing: { sent: { old: { fingerprint: 'keep' } }, reminded: {} } } };
  await atomicJson(path.join(dir, 'state.json'), original);
  const before = await fs.readFile(path.join(dir, 'state.json'), 'utf8');
  let sent = 0;
  await run(['--dry-run'], env, { collect: collection, sendDigest: async () => { sent++; } });
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), before);
  await assert.rejects(run(['--collect-only'], env, { collect: async () => ({ jobs: [], observedPages: [], coverage: [{ name: '源', ok: false, error: 'HTTP403' }] }), sendDigest: async () => { sent++; } }), /全部来源失败/);
  assert.equal(await fs.readFile(path.join(dir, 'state.json'), 'utf8'), before);
  assert.equal(sent, 0);
});

test('损坏的持久化状态不能静默重置', async t => {
  const dir = await temp(t);
  await fs.writeFile(path.join(dir, 'state.json'), '{broken');
  await assert.rejects(loadState(path.join(dir, 'state.json')), /去重状态读取失败/);
});

test('GitHub状态初次发布、恢复和并发冲突保护', async t => {
  const dir = await temp(t), env = { RECRUITMENT_STATE_DIR: dir, GITHUB_REPOSITORY: 'example/repo', GH_TOKEN: 'not-real' };
  let head = null, remoteState;
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname.replace('/repos/example/repo', '');
    const body = options.body ? JSON.parse(options.body) : null;
    if (route === '/git/ref/heads/recruitment-state') return head ? Response.json({ object: { sha: head } }) : new Response('', { status: 404 });
    if (route === '') return Response.json({ full_name: 'example/repo' });
    if (route === '/git/trees') { remoteState = JSON.parse(body.tree.find(file => file.path === 'state.json').content); return Response.json({ sha: 'tree1' }); }
    if (route === '/git/commits' && options.method === 'POST') return Response.json({ sha: 'commit1' });
    if (route === '/git/refs') { head = body.sha; return Response.json({}); }
    if (route.startsWith('/git/commits/')) return Response.json({ tree: { sha: 'tree1' } });
    if (route === '/contents/state.json') return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(remoteState)).toString('base64') });
    throw new Error(`Unexpected route ${route}`);
  };
  await sync('restore', env, fetcher);
  await fs.mkdir(path.join(dir, 'reports'));
  await fs.writeFile(path.join(dir, 'reports/latest.md'), '# Test');
  await sync('publish', env, fetcher);
  assert.equal(head, 'commit1');
  await sync('restore', env, fetcher);
  assert.equal((await loadState(path.join(dir, 'state.json'))).version, 1);
  head = 'other-commit';
  await assert.rejects(sync('publish', env, fetcher), /其他更新/);
});

test('GitHub仓库404不能误认为新状态，网络错误不会暴露token', async t => {
  const dir = await temp(t), env = { RECRUITMENT_STATE_DIR: dir, GITHUB_REPOSITORY: 'example/repo', GH_TOKEN: 'sensitive-token' };
  await assert.rejects(sync('restore', env, async () => new Response('', { status: 404 })), /仓库不可访问/);
  await assert.rejects(sync('restore', env, async () => { throw new Error('sensitive-token'); }), error => !error.message.includes('sensitive-token'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { publishWeb } from '../publish-web.mjs';

const id = 'a'.repeat(24), sha = 'b'.repeat(40), token = 'PRIVATE_SITE_SYNC_TOKEN';
const report = { schemaVersion: 1, reportId: id, reportDate: '2026-10-19', generatedAt: '2026-10-19T01:00:00.000Z', summary: { activeCount: 0 }, jobs: [], sources: [] };
const env = { GITHUB_REPOSITORY: 'example/repo', RECRUITMENT_STATE_DIR: path.resolve('test-state'), RECRUITMENT_PUBLIC_BASE_URL: 'https://jobs.example.com/recruit', RECRUITMENT_SITE_SYNC_TOKEN: token };
const fallback = `https://github.com/example/repo/blob/${sha}/reports/latest.md`;
const baseServices = (overrides = {}) => {
  const requests = [], outputs = [], warnings = [], reads = [], pauses = [];
  return {
    requests, outputs, warnings, reads, pauses,
    readFile: async file => { reads.push(file); return JSON.stringify(file.endsWith('.sync.json') ? { sha } : report); },
    fetch: async (url, options) => { requests.push({ url, options }); return Response.json(options.method === 'POST' ? { reportId: id } : report); },
    output: async (name, value) => { outputs.push([name, value]); },
    warn: message => { warnings.push(message); }, pause: async ms => { pauses.push(ms); }, ...overrides,
  };
};

test('无网站配置不请求网络或读取公共数据，以当前提交构建不可变备用链接', async () => {
  const services = baseServices({ fetch: async () => assert.fail('默认配置不可访问网络') });
  const result = await publishWeb({ GITHUB_REPOSITORY: env.GITHUB_REPOSITORY, RECRUITMENT_STATE_DIR: env.RECRUITMENT_STATE_DIR }, services);
  assert.equal(result.published, false);
  assert.equal(result.reportUrl, fallback);
  assert.deepEqual(services.outputs, [['report_url', fallback]]);
  assert.deepEqual(services.reads, [path.join(env.RECRUITMENT_STATE_DIR, '.sync.json')]);
  assert.match(services.warnings.join('；'), /未配置.*未访问网站/);
});

test('部分配置不请求网站，元数据不可用时明确回退状态分支', async () => {
  const services = baseServices({ readFile: async () => { throw new Error(`${token} https://private.example/`); }, fetch: async () => assert.fail('不完整配置不可访问网络') });
  const result = await publishWeb({ ...env, RECRUITMENT_SITE_SYNC_TOKEN: '' }, services);
  assert.equal(result.reportUrl, 'https://github.com/example/repo/blob/recruitment-state/reports/latest.md');
  assert.match(services.warnings.join('；'), /提交标识不可用.*配置不完整/);
  assert.doesNotMatch(services.warnings.join('；'), /PRIVATE_SITE_SYNC_TOKEN|private\.example/);
});

test('路径基址使用Bearer同步，公开回读完整一致后才输出本次网页链接', async () => {
  const services = baseServices();
  const result = await publishWeb(env, services);
  assert.equal(result.published, true);
  assert.equal(result.reportId, id);
  assert.equal(result.reportUrl, `https://jobs.example.com/recruit/?report=${id}`);
  assert.deepEqual(services.outputs, [['report_url', result.reportUrl]]);
  assert.equal(services.requests.length, 2);
  const [post, get] = services.requests;
  assert.equal(post.url, 'https://jobs.example.com/recruit/api/sync');
  assert.equal(post.options.headers.Authorization, `Bearer ${token}`);
  assert.deepEqual(JSON.parse(post.options.body), report);
  assert.equal(post.options.redirect, 'manual');
  assert.equal(post.options.cache, 'no-store');
  assert.ok(post.options.signal instanceof AbortSignal);
  assert.equal(get.url, `https://jobs.example.com/recruit/data/public.json?report=${id}`);
  assert.equal(get.options.method, 'GET');
  assert.equal(get.options.redirect, 'manual');
  assert.equal(get.options.cache, 'no-store');
  assert.equal(get.options.headers.Authorization, undefined);
  assert.match(get.options.headers['Cache-Control'], /no-store/);
  assert.doesNotMatch(JSON.stringify({ outputs: services.outputs, warnings: services.warnings, result }), new RegExp(token));
});

test('JSON键顺序不同但完整数据相同可以通过回读验证', async () => {
  const services = baseServices({ fetch: async (url, options) => Response.json(options.method === 'POST' ? { reportId: id } : Object.fromEntries(Object.entries(report).reverse())) });
  assert.equal((await publishWeb(env, services)).published, true);
});

test('缓存回读最多三次，第三次数据一致可恢复且只POST一次', async () => {
  const services = baseServices();
  let posts = 0, gets = 0;
  services.fetch = async (url, options) => {
    if (options.method === 'POST') { posts++; return Response.json({ reportId: id }); }
    gets++;
    return Response.json(gets === 3 ? report : { ...report, reportId: 'c'.repeat(24) });
  };
  assert.equal((await publishWeb(env, services)).published, true);
  assert.equal(posts, 1);
  assert.equal(gets, 3);
  assert.deepEqual(services.pauses, [500, 500]);
});

test('网站持久旧数据或仅reportId一致但正文不同都不能用自域详情', async () => {
  const services = baseServices();
  let gets = 0;
  services.fetch = async (url, options) => {
    if (options.method === 'POST') return Response.json({ reportId: id });
    gets++;
    return Response.json({ ...report, summary: { activeCount: 99 } });
  };
  const result = await publishWeb(env, services);
  assert.equal(gets, 3);
  assert.equal(result.published, false);
  assert.equal(result.reportId, null);
  assert.equal(result.reportUrl, fallback);
  assert.deepEqual(services.outputs, [['report_url', fallback]]);
  assert.match(services.warnings.join('；'), /回退GitHub.*不会使用网站旧数据/);
});

test('POST标识不匹配、HTTP失败及重定向都停止，不向其他地址发送凭据', async () => {
  for (const response of [Response.json({ reportId: 'wrong' }), new Response('denied', { status: 403 }), new Response(null, { status: 307, headers: { location: `https://evil.example/?secret=${token}` } })]) {
    const services = baseServices();
    let count = 0;
    services.fetch = async (url, options) => { count++; assert.equal(options.redirect, 'manual'); assert.equal(url, 'https://jobs.example.com/recruit/api/sync'); return response; };
    const result = await publishWeb(env, services);
    assert.equal(count, 1);
    assert.equal(result.reportUrl, fallback);
    assert.doesNotMatch(JSON.stringify({ result, warnings: services.warnings }), /PRIVATE_SITE_SYNC_TOKEN|evil\.example/);
  }
});

test('GET重定向不跟随，既不换域也不携带同步凭据', async () => {
  const services = baseServices();
  let count = 0;
  services.fetch = async (url, options) => {
    count++;
    if (options.method === 'POST') return Response.json({ reportId: id });
    assert.equal(options.headers.Authorization, undefined);
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/data.json' } });
  };
  const result = await publishWeb(env, services);
  assert.equal(count, 2);
  assert.equal(result.reportUrl, fallback);
});

test('异常原文可能带密钥或敏感URL，所有日志与输出仍脱敏', async () => {
  const services = baseServices({ fetch: async () => { throw new Error(`${token} https://jobs.example.com/api?access_token=${token}`); } });
  const result = await publishWeb(env, services);
  assert.equal(result.reportUrl, fallback);
  assert.doesNotMatch(JSON.stringify({ result, outputs: services.outputs, warnings: services.warnings }), /PRIVATE_SITE_SYNC_TOKEN|access_token|\/api\?/);
});

test('非法HTTPS主机、凭据、端口、查询、片段与歧义路径都不访问网站', async () => {
  const bad = ['http://jobs.example.com', 'https://user:password@jobs.example.com', 'https://jobs.example.com:8443', 'https://jobs.example.com?token=private', 'https://jobs.example.com#fragment', 'https://bad_host.example.com', 'https://-bad.example.com', 'https://example..com', 'https://127.0.0.1', 'https://localhost', 'https://jobs.example.com/private/../recruit', 'https://jobs.example.com/a%2fb', 'https://jobs.example.com\\@evil.example', 'https://jobs.example.com/\nsecret'];
  for (const address of bad) {
    const services = baseServices({ fetch: async () => assert.fail('不安全地址不可发起请求') });
    const result = await publishWeb({ ...env, RECRUITMENT_PUBLIC_BASE_URL: address }, services);
    assert.equal(result.published, false, address);
    assert.equal(result.reportUrl, fallback, address);
  }
});

test('上传数据超过2MB或结构损坏时不发送请求', async () => {
  for (const data of [JSON.stringify({ ...report, extra: 'x'.repeat(2_000_001) }), '{broken', JSON.stringify({ ...report, reportId: 'not-a-report-id' }), JSON.stringify({ ...report, jobs: {} })]) {
    const services = baseServices({ readFile: async file => file.endsWith('.sync.json') ? JSON.stringify({ sha }) : data, fetch: async () => assert.fail('坏报告不可上传') });
    assert.equal((await publishWeb(env, services)).reportUrl, fallback);
  }
});

test('公开回读大小也有上限，不能借成功同步响应输出未验证网页', async () => {
  const services = baseServices();
  services.fetch = async (url, options) => options.method === 'POST' ? Response.json({ reportId: id }) : new Response('{}', { headers: { 'Content-Length': '2000001' } });
  assert.equal((await publishWeb(env, services)).reportUrl, fallback);
  assert.deepEqual(services.pauses, [500, 500]);
});

test('自定义报告目录仅读取public.json与同步元数据，不写状态或pending', async () => {
  const services = baseServices();
  const reportDir = path.resolve('custom-reports');
  await publishWeb({ ...env, RECRUITMENT_REPORT_DIR: reportDir }, services);
  assert.deepEqual(services.reads, [path.join(env.RECRUITMENT_STATE_DIR, '.sync.json'), path.join(reportDir, 'public.json')]);
});

test('恶意提交标识不能注入备用链接，GitHub仓库无效时不伪造链接', async () => {
  const services = baseServices({ readFile: async file => JSON.stringify(file.endsWith('.sync.json') ? { sha: `abc?secret=${token}\nreport_url=evil` } : report) });
  const branch = await publishWeb({ GITHUB_REPOSITORY: env.GITHUB_REPOSITORY }, services);
  assert.equal(branch.reportUrl, 'https://github.com/example/repo/blob/recruitment-state/reports/latest.md');
  assert.doesNotMatch(JSON.stringify(branch), /PRIVATE_SITE_SYNC_TOKEN|report_url=evil/);
  const missing = baseServices({ fetch: async () => assert.fail('未配置网站不应访问网络') });
  const result = await publishWeb({ GITHUB_REPOSITORY: '../evil' }, missing);
  assert.equal(result.reportUrl, null);
  assert.deepEqual(missing.outputs, []);
});

test('工作流输出失败用固定安全异常终止，不显示底层路径或凭据', async () => {
  const services = baseServices({ output: async () => { throw new Error(`${token} private-output-path`); } });
  await assert.rejects(publishWeb(env, services), error => error.message === '详情链接写入工作流输出失败' && !error.message.includes(token));
});

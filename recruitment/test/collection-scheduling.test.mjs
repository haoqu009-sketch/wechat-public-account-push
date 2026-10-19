import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../collector.mjs';

const today = '2026-10-19';
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const source = (name, host = `${name}.example`, extra = {}) => ({ name, url: `https://${host}/jobs`, ...extra });
const success = entry => ({ jobs: [{ id: entry.name }], coverage: { name: entry.name, ok: true, articles: 1, warnings: [] }, observedPages: [`${entry.url}/${entry.name}`] });

test('最多两个不同来源并行，完成乱序但结果保持启用配置顺序', async () => {
  const sources = [source('first'), source('second'), source('third'), source('fourth')];
  const delays = new Map([['first', 35], ['second', 5], ['third', 5], ['fourth', 5]]);
  let active = 0, peak = 0;
  const finished = [];
  const result = await collect({ sources }, today, {
    collectSource: async entry => {
      active++; peak = Math.max(peak, active);
      assert.ok(active <= 2);
      await pause(delays.get(entry.name));
      active--; finished.push(entry.name);
      return success(entry);
    },
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.notDeepEqual(finished, sources.map(entry => entry.name));
  assert.deepEqual(result.jobs.map(job => job.id), sources.map(entry => entry.name));
  assert.deepEqual(result.coverage.map(item => item.name), sources.map(entry => entry.name));
  assert.deepEqual(result.observedPages, sources.map(entry => `${entry.url}/${entry.name}`));
});

test('相同主机以及共享声明附件主机的来源不重叠，空闲槽继续选取其他主机', async () => {
  const sources = [
    source('one', 'hospital.example', { allowedHosts: ['shared.example'] }),
    source('same-host', 'hospital.example'),
    source('shared-attachment', 'other.example', { allowedHosts: ['shared.example'] }),
    source('independent', 'independent.example'),
  ];
  const busy = new Set(), started = [], finished = [];
  const result = await collect({ sources }, today, {
    collectSource: async entry => {
      const hosts = [new URL(entry.url).hostname, ...(entry.allowedHosts || [])];
      assert.ok(hosts.every(host => !busy.has(host)), '共享主机不得同时采集');
      hosts.forEach(host => busy.add(host)); started.push(entry.name);
      await pause(entry.name === 'one' ? 25 : 3);
      hosts.forEach(host => busy.delete(host)); finished.push(entry.name);
      return success(entry);
    },
  });
  assert.deepEqual(started.slice(0, 2), ['one', 'independent']);
  assert.ok(finished.indexOf('one') < finished.indexOf('same-host'));
  assert.ok(finished.indexOf('one') < finished.indexOf('shared-attachment'));
  assert.equal(busy.size, 0);
  assert.deepEqual(result.coverage.map(item => item.name), sources.map(entry => entry.name));
});

test('过滤禁用来源，保留源内options，完成回调只提供安全计数摘要', async () => {
  const disabled = source('disabled', 'disabled.example', { enabled: false });
  const sources = [source('one'), disabled, source('two')], events = [], called = [];
  const request = async () => { throw new Error('must not make network requests'); };
  const politePause = async () => {};
  await collect({ sources }, today, {
    request, pause: politePause,
    collectSource: async (entry, config, date, options) => {
      called.push(entry.name);
      assert.equal(config.sources, sources);
      assert.equal(date, today);
      assert.equal(options.request, request);
      assert.equal(options.pause, politePause);
      assert.equal(options.collectSource, undefined);
      assert.equal(options.onSourceComplete, undefined);
      return success(entry);
    },
    onSourceComplete: event => { events.push(event); },
  });
  assert.deepEqual(called, ['one', 'two']);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(event => event.completed), [1, 2]);
  assert.deepEqual(events.map(event => event.index), [0, 1]);
  assert.ok(events.every(event => event.total === 2 && event.ok && event.jobCount === 1 && event.articleCount === 1));
  assert.deepEqual(Object.keys(events[0]), ['name', 'index', 'completed', 'total', 'ok', 'jobCount', 'articleCount']);
  assert.doesNotMatch(JSON.stringify(events), /https:|access_token|warnings|observedPages/);
});

test('单源reject转换为明确失败覆盖，隐藏原始URL和秘密，其他来源完成且回调照常执行', async () => {
  const sources = [source('failed'), source('success')], events = [];
  const result = await collect({ sources }, today, {
    collectSource: async entry => {
      if (entry.name === 'failed') throw new Error('https://private.example/?access_token=PRIVATE_SECRET');
      return success(entry);
    },
    onSourceComplete: event => { events.push(event); },
  });
  assert.equal(result.coverage[0].ok, false);
  assert.match(result.coverage[0].error, /采集未完成/);
  assert.equal(result.coverage[1].ok, true);
  assert.deepEqual(result.jobs, [{ id: 'success' }]);
  assert.equal(events.length, 2);
  assert.equal(events.find(event => event.name === 'failed').jobCount, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SECRET|private\.example|access_token/);
});

test('进度回调异常不会悬挂或遗弃任务，全部完成后抛不含秘密的错误', { timeout: 2000 }, async () => {
  const sources = [source('first'), source('second'), source('third')];
  const finished = [], events = [];
  let active = 0;
  await assert.rejects(collect({ sources }, today, {
    collectSource: async entry => {
      active++;
      await pause(entry.name === 'first' ? 15 : 3);
      active--; finished.push(entry.name);
      return success(entry);
    },
    onSourceComplete: async event => {
      events.push(event.name);
      if (event.name === 'second') throw new Error('PRIVATE_CALLBACK_SECRET');
    },
  }), error => {
    assert.match(error.message, /进度回调失败.*全部采集任务已结束/);
    assert.doesNotMatch(error.message, /PRIVATE_CALLBACK_SECRET/);
    return true;
  });
  assert.equal(active, 0);
  assert.equal(finished.length, 3);
  assert.equal(events.length, 3);
});

test('无启用来源时直接返回空集合，不请求网络或触发完成回调', async () => {
  let calls = 0;
  const result = await collect({ sources: [source('disabled', 'disabled.example', { enabled: false })] }, today, {
    collectSource: async () => { calls++; }, onSourceComplete: () => { calls++; },
  });
  assert.deepEqual(result, { jobs: [], coverage: [], observedPages: [] });
  assert.equal(calls, 0);
});

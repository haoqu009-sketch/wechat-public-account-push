import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWechat, testTemplateData } from '../check-wechat.mjs';

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

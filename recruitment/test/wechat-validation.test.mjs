import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecruitmentTemplates, sendTemplateMessage } from '../wechat.mjs';

const fields = ['a', 'b', 'l', 'n2', 'q1', 'q2', 'm1', 'm2'];
const content = fields.map(field => `标签：{{${field}.DATA}}`).join('\n');
const config = { users: [{ openId: 'first-private-recipient', templateId: 'private-template' }, { openId: 'second-private-recipient', templateId: 'private-template' }] };
const response = body => ({ ok: true, json: async () => body });
const templates = (value = content) => response({ template_list: [{ template_id: 'private-template', content: value }] });

test('两个接收人共用模板时只读取一次官方模板列表，摘要不含ID或模板原文', async () => {
  let calls = 0;
  const result = await validateRecruitmentTemplates(config, 'private-token', async (url, options) => {
    calls++;
    assert.equal(new URL(url).pathname, '/cgi-bin/template/get_all_private_template');
    assert.equal(new URL(url).searchParams.get('access_token'), 'private-token');
    assert.equal(options.method, undefined);
    return templates();
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { templateCount: 1, recipientCount: 2, fields });
  assert.doesNotMatch(JSON.stringify(result), /private|标签/);
});

test('模板缺少字段时阻止发送并只指出已知字段名', async () => {
  await assert.rejects(validateRecruitmentTemplates(config, 'token', async () => templates(content.replace('{{q1.DATA}}', ''))), /缺少字段：q1/);
});

test('模板含未知变量、错误后缀或不闭合括号时拒绝，错误不回显模板', async () => {
  for (const addition of ['{{private_unknown.DATA}}', '{{q1.VALUE}}', '{{private_unclosed.DATA']) {
    await assert.rejects(validateRecruitmentTemplates(config, 'token', async () => templates(content + addition)), error => {
      assert.match(error.message, /不支持的变量|括号格式异常/);
      assert.doesNotMatch(error.message, /private_|VALUE|标签/);
      return true;
    });
  }
});

test('微信账号中不存在配置模板时给出安全错误', async () => {
  await assert.rejects(validateRecruitmentTemplates(config, 'token', async () => response({ template_list: [] })), error => {
    assert.match(error.message, /找不到已配置的招聘模板/);
    assert.doesNotMatch(error.message, /private-template|private-recipient/);
    return true;
  });
});

test('模板列表请求失败不暴露敏感URL、token或服务器错误正文', async () => {
  const failures = [
    async url => { throw new Error(`failed ${url}`); },
    async () => ({ ok: false, status: 403, json: async () => ({ message: 'private-server-detail' }) }),
    async () => response({ errcode: 40001, errmsg: 'private-server-detail' }),
    async () => ({ ok: true, json: async () => { throw new Error('private-server-detail'); } }),
  ];
  for (const fetcher of failures) {
    await assert.rejects(validateRecruitmentTemplates(config, 'private-token', fetcher), error => {
      assert.doesNotMatch(error.message, /private-|https:|access_token/);
      return true;
    });
  }
});

test('逐个校验不同模板并拒绝缺失列表及空配置', async () => {
  const twoTemplates = { users: [...config.users, { openId: 'third-private-recipient', templateId: 'second-private-template' }] };
  await assert.rejects(validateRecruitmentTemplates(twoTemplates, 'token', async () => templates()), /找不到已配置/);
  await assert.rejects(validateRecruitmentTemplates(config, 'token', async () => response({})), /未返回模板列表/);
  await assert.rejects(validateRecruitmentTemplates({ users: [] }, 'token', async () => { throw new Error('must not fetch'); }), /完整的接收人和模板配置/);
});

test('底层发送保留指定字段且仅在errcode为0并返回msgid时接受', async () => {
  const data = Object.fromEntries(fields.map(field => [field, { value: `测试${field}` }]));
  const user = config.users[0];
  const result = await sendTemplateMessage(user, data, 'private-token', 'https://report.example/daily', async (url, options) => {
    assert.equal(new URL(url).pathname, '/cgi-bin/message/template/send');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { touser: user.openId, template_id: user.templateId, url: 'https://report.example/daily', data });
    return response({ errcode: 0, msgid: 123 });
  });
  assert.deepEqual(result, { accepted: true });
  for (const body of [{ errcode: 0 }, { msgid: 123 }, { errcode: 40003, errmsg: 'private-server-detail' }]) {
    await assert.rejects(sendTemplateMessage(user, data, 'private-token', 'https://report.example/daily', async () => response(body)), error => {
      assert.doesNotMatch(error.message, /private-|https:|access_token/);
      return true;
    });
  }
});

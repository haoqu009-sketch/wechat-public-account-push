import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chinaDate } from './core.mjs';
import { readWechatConfig, getAccessToken, validateRecruitmentTemplates, sendTemplateMessage } from './wechat.mjs';

// These values exercise every template field without inventing recruitment openings.
export function testTemplateData(today = chinaDate()) {
  const values = {
    a: today,
    b: '模板测试，不是招聘公告',
    l: '影像医师区域显示正常',
    n2: '技师候补区域显示正常',
    q1: '这是一条招聘模板测试消息',
    q2: '点击消息可查看真实采集报告',
    m1: '本次测试不记录岗位已发送',
    m2: '详情链接与官方来源待确认',
  };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, color: '#173177' }]));
}

export async function checkWechat(args = process.argv.slice(2), env = process.env, services = {}) {
  if (!env.RECRUITMENT_TEMPLATE_ID?.trim()) throw new Error('缺少 RECRUITMENT_TEMPLATE_ID，请在仓库 Actions Secrets 添加');
  const config = readWechatConfig(env);
  const token = await (services.getAccessToken || getAccessToken)(config);
  const summary = await (services.validateTemplates || validateRecruitmentTemplates)(config, token);
  console.log(`招聘模板校验成功：${summary.templateCount}个模板，8个字段齐全；接收人${config.users.length}位。`);
  if (!args.includes('--send-test')) {
    console.log('只读校验完成，未发送微信。');
    return;
  }
  const reportUrl = env.RECRUITMENT_REPORT_URL;
  if (!reportUrl?.startsWith('https://')) throw new Error('请先发布采集报告，再设置 RECRUITMENT_REPORT_URL');
  const data = testTemplateData();
  let failures = 0;
  for (const [index, user] of config.users.entries()) {
    try {
      await (services.sendMessage || sendTemplateMessage)(user, data, token, reportUrl);
      console.log(`微信接口已接受接收人${index + 1}的测试消息；请在手机确认显示与详情链接。`);
    } catch (error) {
      failures++;
      console.error(`接收人${index + 1}测试未完成：${error.message}`);
    }
  }
  if (failures) throw new Error(`${failures}位接收人测试未完成，请根据错误检查后再重试`);
  console.log('测试完成，未修改任何岗位发送或提醒记录。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWechat().catch(error => { console.error(error.message); process.exitCode = 1; });
}

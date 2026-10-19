import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chinaDate, wechatData } from './core.mjs';
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

async function loadPreview({ reportDir }) {
  try {
    const [digest, coverage] = await Promise.all([
      fs.readFile(path.join(reportDir, 'preview.json'), 'utf8'),
      fs.readFile(path.join(reportDir, 'source-status.json'), 'utf8'),
    ]);
    return { digest: JSON.parse(digest), coverage: JSON.parse(coverage) };
  } catch { throw new Error('当前日报预览读取失败，请先重新采集生成preview.json与source-status.json'); }
}

function validateDailyPreview(preview, today) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const string = value => typeof value === 'string' && value.trim().length > 0;
  const digest = preview?.digest, coverage = preview?.coverage;
  if (!object(digest)) throw new Error('当前日报预览结构异常');
  if (digest.today !== today) throw new Error('当前日报预览不是今天生成，请重新采集');
  const validJob = job => object(job) && string(job.id) && string(job.organization)
    && string(job.title) && string(job.province) && ['priority', 'review'].includes(job.status)
    && (job.deadline == null || /^20\d{2}-\d{2}-\d{2}$/.test(job.deadline));
  if (['physicians', 'technicians', 'reminders'].some(field => !Array.isArray(digest[field]) || digest[field].some(job => !validJob(job)))) {
    throw new Error('当前日报预览岗位数组或岗位字段异常');
  }
  if (!Array.isArray(coverage) || !coverage.length || coverage.some(item => !object(item)
    || !string(item.name) || typeof item.ok !== 'boolean' || !Number.isInteger(item.articles) || item.articles < 0
    || (item.warnings != null && (!Array.isArray(item.warnings) || item.warnings.some(value => typeof value !== 'string'))))) {
    throw new Error('当前日报来源状态结构异常');
  }
  if (!coverage.some(item => item.ok)) throw new Error('当前日报全部来源失败，拒绝发送无招聘结论');
  return { digest, coverage };
}

export async function checkWechat(args = process.argv.slice(2), env = process.env, services = {}) {
  const sendTest = args.includes('--send-test'), sendDailyPreview = args.includes('--send-daily-preview');
  if (sendTest && sendDailyPreview) throw new Error('--send-test与--send-daily-preview不能同时使用');
  if (!env.RECRUITMENT_TEMPLATE_ID?.trim()) throw new Error('缺少 RECRUITMENT_TEMPLATE_ID，请在仓库 Actions Secrets 添加');
  const config = readWechatConfig(env);
  const reportUrl = env.RECRUITMENT_REPORT_URL;
  let data;
  if (sendTest || sendDailyPreview) {
    if (!reportUrl?.startsWith('https://')) throw new Error('请先发布采集报告，再设置 RECRUITMENT_REPORT_URL');
    if (sendDailyPreview) {
      const directory = path.dirname(fileURLToPath(import.meta.url));
      const stateDir = env.RECRUITMENT_STATE_DIR || path.join(directory, '../.recruitment-state');
      const reportDir = env.RECRUITMENT_REPORT_DIR || path.join(stateDir, 'reports');
      const preview = await (services.loadPreview || loadPreview)({ stateDir, reportDir });
      const { digest, coverage } = validateDailyPreview(preview, chinaDate());
      data = wechatData(digest, coverage);
    } else data = testTemplateData();
  }
  const token = await (services.getAccessToken || getAccessToken)(config);
  const summary = await (services.validateTemplates || validateRecruitmentTemplates)(config, token);
  console.log(`招聘模板校验成功：${summary.templateCount}个模板，8个字段齐全；接收人${config.users.length}位。`);
  if (!sendTest && !sendDailyPreview) {
    console.log('只读校验完成，未发送微信。');
    return;
  }
  const label = sendDailyPreview ? '日报预览' : '测试';
  let failures = 0;
  for (const [index, user] of config.users.entries()) {
    try {
      await (services.sendMessage || sendTemplateMessage)(user, data, token, reportUrl);
      console.log(`微信接口已接受接收人${index + 1}的${label}消息；请在手机确认显示与详情链接。`);
    } catch (error) {
      failures++;
      console.error(`接收人${index + 1}${label}未完成：${error.message}`);
    }
  }
  if (failures) throw new Error(`${failures}位接收人${label}未完成，请根据错误检查后再重试`);
  console.log(`${label}完成，未修改任何岗位发送或提醒记录。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkWechat().catch(error => { console.error(error.message); process.exitCode = 1; });
}

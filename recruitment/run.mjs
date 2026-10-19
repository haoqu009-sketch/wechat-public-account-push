import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './collector.mjs';
import { chinaDate, daysBetween, planDigest, rankJobs, markDelivered, renderMarkdown } from './core.mjs';
import { readWechatConfig, recipientKey, getAccessToken, sendDigest } from './wechat.mjs';
import { createPublicReport } from './public-report.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
export async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function loadState(file) {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.version !== 1 || !state.jobs || !state.recipients) throw new Error('状态结构或版本不受支持');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, jobs: {}, recipients: {} };
    throw new Error('去重状态读取失败；为避免重复发送，停止运行，请检查状态文件');
  }
}

export async function run(args = process.argv.slice(2), env = process.env, services = {}) {
  const dryRun = args.includes('--dry-run');
  const collectOnly = args.includes('--collect-only');
  const sendOnly = args.includes('--send-only');
  if (collectOnly && sendOnly) throw new Error('不能同时选择采集和发送阶段');
  const config = JSON.parse(await fs.readFile(env.RECRUITMENT_CONFIG || path.join(directory, 'config.json'), 'utf8'));
  const stateDir = env.RECRUITMENT_STATE_DIR || path.join(directory, '../.recruitment-state');
  const reportDir = env.RECRUITMENT_REPORT_DIR || path.join(stateDir, 'reports');
  const stateFile = path.join(stateDir, 'state.json');
  const planFile = path.join(stateDir, 'pending.json');
  const today = chinaDate();
  let state = await loadState(stateFile);
  let pending;
  let wechat;
  if (!dryRun) wechat = readWechatConfig(env);
  if (!sendOnly) {
    const { jobs, coverage, observedPages } = await (services.collect || collect)(config, today, {
      onSourceComplete: result => console.log(`来源检查 ${result.completed}/${result.total}：${result.name}（${result.ok ? '已读取' : '未完成'}，影像线索${result.jobCount}条）`),
    });
    const refreshed = new Set(observedPages);
    for (const [id, job] of Object.entries(state.jobs)) if (refreshed.has(job.url)) delete state.jobs[id];
    for (const job of jobs) state.jobs[job.id] = { ...job, collectedAt: today };
    // Retain recent observations during a source outage, but label their actual collection date.
    for (const [id, job] of Object.entries(state.jobs)) {
      const stillOpen = job.deadline && daysBetween(job.deadline, today) >= 0;
      if (job.collectedAt && daysBetween(today, job.collectedAt) > config.lookbackDays) delete state.jobs[id];
      else if (job.published && daysBetween(today, job.published) > config.lookbackDays && !stillOpen) delete state.jobs[id];
    }
    const available = Object.values(state.jobs);
    const targets = dryRun ? [{ key: 'preview' }] : wechat.users.map(user => ({ key: recipientKey(user) }));
    const digests = Object.fromEntries(targets.map(({ key }) => [key, planDigest(available, state.recipients[key] || { sent: {}, reminded: {} }, config, today)]));
    // The shared report covers the union of all recipients' unsent jobs and reminders.
    const merge = field => rankJobs([...new Map(Object.values(digests).flatMap(d => d[field]).map(job => [job.id, job])).values()], config);
    const report = { today, physicians: merge('physicians'), technicians: merge('technicians'), reminders: merge('reminders') };
    await fs.mkdir(reportDir, { recursive: true });
    const markdown = renderMarkdown(report, coverage);
    await fs.writeFile(path.join(reportDir, 'latest.md'), markdown);
    await fs.writeFile(path.join(reportDir, `${today}.md`), markdown);
    await atomicJson(path.join(reportDir, 'source-status.json'), coverage);
    await atomicJson(path.join(reportDir, 'preview.json'), report);
    await atomicJson(path.join(reportDir, 'public.json'), createPublicReport({ jobs: available, digest: report, coverage, config }));
    console.log(`来源成功 ${coverage.filter(item => item.ok).length}/${coverage.length}，本次采集影像线索 ${jobs.length} 条；医师 ${report.physicians.length}，技师 ${report.technicians.length}，提醒 ${report.reminders.length}。`);
    for (const item of coverage) if (!item.ok) console.error(`来源不可用：${item.name}（${item.error}）`);
    if (!coverage.some(item => item.ok)) throw new Error('全部来源失败，已生成诊断报告；不会推送“没有招聘”或更新已发送状态');
    pending = { today, coverage, digests };
    if (!dryRun) {
      await atomicJson(stateFile, state);
      await atomicJson(planFile, pending);
    }
    if (dryRun || collectOnly) { console.log(dryRun ? '预览完成，未发送消息、未改变去重状态。' : '采集完成，等待发布详情及发送。'); return; }
  } else {
    pending = JSON.parse(await fs.readFile(planFile, 'utf8'));
    if (pending.today !== today) throw new Error('待发送日报不是今天生成，请重新采集');
    if (!pending.coverage?.some(item => item.ok)) throw new Error('待发送日报没有成功来源，停止发送');
  }
  const reportUrl = env.RECRUITMENT_REPORT_URL;
  if (!reportUrl?.startsWith('https://')) throw new Error('请先发布日报并设置RECRUITMENT_REPORT_URL');
  let token;
  let failures = 0;
  for (const [index, user] of wechat.users.entries()) {
    const key = recipientKey(user), digest = pending.digests[key];
    if (!digest) { failures++; console.error(`接收人${index + 1}与采集阶段不一致，请重新采集`); continue; }
    if (!digest.physicians.length && !digest.technicians.length && !digest.reminders.length) {
      console.log(`接收人${index + 1}没有新增或提醒，本次不发送。`); continue;
    }
    try {
      token ||= await (services.getAccessToken || getAccessToken)(wechat);
      await (services.sendDigest || sendDigest)(user, digest, pending.coverage, token, reportUrl);
      state = markDelivered(state, digest, key, new Date().toISOString());
      await atomicJson(stateFile, state);
      console.log(`微信已接受接收人${index + 1}的日报消息。`);
    } catch (error) { failures++; console.error(`接收人${index + 1}发送未完成：${error.message}`); }
  }
  if (failures) throw new Error(`${failures}个接收人未完成推送；已成功发送的状态已保留，失败者下次重试`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './run.mjs';

const branch = 'recruitment-state';
export async function sync(mode, env = process.env, fetcher = fetch) {
  const root = env.RECRUITMENT_STATE_DIR || path.resolve('.recruitment-state');
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !token) throw new Error('GitHub仓库或认证未配置');
  const endpoint = `https://api.github.com/repos/${repo}`;
  async function api(route, body, method = body ? 'POST' : 'GET') {
    let response;
    try {
      response = await fetcher(`${endpoint}${route}`, {
        method, signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error('GitHub API网络请求失败'); }
    if (response.status === 404 && method === 'GET') return null;
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}，检查仓库权限、网络及分支保护`);
    return response.json();
  }
  const metadata = path.join(root, '.sync.json');
  if (mode === 'restore') {
    const ref = await api(`/git/ref/heads/${branch}`);
    let tree = null;
    if (ref) {
      const commit = await api(`/git/commits/${ref.object.sha}`);
      tree = commit.tree.sha;
      const blob = await api(`/contents/state.json?ref=${ref.object.sha}`);
      if (!blob || blob.encoding !== 'base64') throw new Error('状态分支缺少有效state.json，停止以避免重复发送');
      // Validate before writing, never silently replace corrupt state with an empty state.
      const state = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8'));
      if (state.version !== 1 || !state.jobs || !state.recipients) throw new Error('远程状态结构无效');
      await atomicJson(path.join(root, 'state.json'), state);
    } else {
      if (!await api('')) throw new Error('仓库不可访问，不能将缺失权限当作首次部署');
      await atomicJson(path.join(root, 'state.json'), { version: 1, jobs: {}, recipients: {} });
    }
    await atomicJson(metadata, { sha: ref?.object.sha || null, tree });
    console.log(ref ? '已恢复招聘去重状态。' : '首次部署，将创建独立招聘状态分支。');
    return;
  }
  if (mode !== 'publish') throw new Error('不支持的状态操作');
  const previous = JSON.parse(await fs.readFile(metadata, 'utf8'));
  const current = await api(`/git/ref/heads/${branch}`);
  if ((current?.object.sha || null) !== previous.sha) throw new Error('远程状态已有其他更新，请重新运行，避免覆盖');
  const entries = [{ path: 'state.json', mode: '100644', type: 'blob', content: await fs.readFile(path.join(root, 'state.json'), 'utf8') }];
  for (const name of await fs.readdir(path.join(root, 'reports'))) {
    if (!/^(?:latest\.md|\d{4}-\d{2}-\d{2}\.md|source-status\.json|preview\.json)$/.test(name)) continue;
    entries.push({ path: `reports/${name}`, mode: '100644', type: 'blob', content: await fs.readFile(path.join(root, 'reports', name), 'utf8') });
  }
  const tree = await api('/git/trees', { ...(previous.tree ? { base_tree: previous.tree } : {}), tree: entries });
  if (tree.sha === previous.tree) { console.log('报告和状态无变化。'); return; }
  const commit = await api('/git/commits', { message: 'chore: update medical recruitment digest', tree: tree.sha, parents: previous.sha ? [previous.sha] : [] });
  if (previous.sha) await api(`/git/refs/heads/${branch}`, { sha: commit.sha, force: false }, 'PATCH');
  else await api('/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
  await atomicJson(metadata, { sha: commit.sha, tree: tree.sha });
  console.log('招聘报告和去重状态已保存至独立状态分支。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sync(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}

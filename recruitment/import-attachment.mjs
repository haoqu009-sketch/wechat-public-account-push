import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeUrl } from './core.mjs';
import { verificationAuthorities } from './verification.mjs';
import { saveAttachmentImport } from './attachment-store.mjs';

export async function importAttachment(args, env = process.env) {
  const get = flag => args[args.indexOf(flag) + 1];
  if (!['--url', '--file', '--format'].every(flag => args.includes(flag) && get(flag) && !get(flag).startsWith('--'))) throw new Error('用法：node recruitment/import-attachment.mjs --url HTTPS官方附件地址 --file 本地文件 --format xlsx');
  const config = JSON.parse(await fs.readFile(env.RECRUITMENT_CONFIG || new URL('./config.json', import.meta.url), 'utf8'));
  const hosts = verificationAuthorities(config).flatMap(source => source.hosts);
  const url = safeUrl(get('--url'), get('--url'), hosts);
  if (!url) throw new Error('仅接受已批准官方域名内的HTTPS附件原始地址');
  const input = path.resolve(get('--file')), stat = await fs.lstat(input);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000) throw new Error('输入文件无效或超限');
  const directory = env.RECRUITMENT_ATTACHMENT_IMPORT_DIR || path.join(env.RECRUITMENT_STATE_DIR || path.resolve('.recruitment-state'), 'attachment-imports');
  const result = await saveAttachmentImport(directory, { url, format: get('--format'), bytes: await fs.readFile(input) });
  console.log('补充附件已保存；下轮在官方附件下载失败时重解析，结果标为手动补充，不能据此确认官网仍在招聘。');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) importAttachment(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });

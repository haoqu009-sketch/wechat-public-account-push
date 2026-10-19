import { wechatData, hash } from './core.mjs';

export function readWechatConfig(env = process.env) {
  let original = {};
  if (env.ALL_CONFIG) {
    try { original = JSON.parse(env.ALL_CONFIG); } catch { throw new Error('ALL_CONFIG格式错误，请在Secrets中检查，勿将内容写入日志'); }
  }
  const appId = env.APP_ID || original.APP_ID;
  const appSecret = env.APP_SECRET || original.APP_SECRET;
  const users = (original.USER_INFO || []).filter(user => user.id).map(user => ({
    openId: user.id, templateId: env.RECRUITMENT_TEMPLATE_ID || env.WECHAT_TEMPLATE_ID || user.wechatTemplateId || user.useTemplateId,
  }));
  if (env.USER_OPENID) {
    const entry = { openId: env.USER_OPENID, templateId: env.RECRUITMENT_TEMPLATE_ID || env.WECHAT_TEMPLATE_ID || users[0]?.templateId };
    if (users.length === 1) users[0] = entry;
    else if (!users.some(user => user.openId === entry.openId)) users.push(entry);
  }
  const additional = env.ADDITIONAL_USER_OPENIDS?.trim();
  if (additional) {
    let ids;
    try { ids = JSON.parse(additional); } catch { ids = additional.split(/[\s,;]+/); }
    for (const id of Array.isArray(ids) ? ids : [ids]) {
      if (typeof id === 'string' && id.trim() && !users.some(user => user.openId === id.trim())) {
        users.push({ openId: id.trim(), templateId: env.RECRUITMENT_TEMPLATE_ID || env.WECHAT_TEMPLATE_ID || users[0]?.templateId });
      }
    }
  }
  if (!appId || !appSecret || !users.length || users.some(user => !user.templateId)) {
    throw new Error('微信配置不完整：需要APP_ID、APP_SECRET及接收人和模板ID；可沿用仓库已有ALL_CONFIG等Secrets');
  }
  return { appId, appSecret, users: [...new Map(users.map(user => [user.openId, user])).values()] };
}

export const recipientKey = user => hash(user.openId);

async function api(url, options, fetcher) {
  let response;
  try { response = await fetcher(url, { ...options, signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error('微信接口网络请求失败（敏感请求地址已隐藏）'); }
  if (!response.ok) throw new Error(`微信接口HTTP ${response.status}`);
  let data;
  try { data = await response.json(); } catch { throw new Error('微信接口返回非JSON响应'); }
  if (data.errcode) throw new Error(`微信接口错误码 ${Number(data.errcode)}，请按官方文档检查凭据、IP白名单或模板权限`);
  return data;
}

export async function getAccessToken(config, fetcher = fetch) {
  const query = new URLSearchParams({ grant_type: 'client_credential', appid: config.appId, secret: config.appSecret });
  const result = await api(`https://api.weixin.qq.com/cgi-bin/token?${query}`, {}, fetcher);
  if (!result.access_token) throw new Error('微信接口未返回access_token');
  return result.access_token;
}

export async function sendDigest(user, digest, coverage, token, reportUrl, fetcher = fetch) {
  if (!reportUrl || !/^https:\/\//.test(reportUrl)) throw new Error('微信日报需要可访问的HTTPS详情地址');
  const data = await api(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ touser: user.openId, template_id: user.templateId, url: reportUrl, data: wechatData(digest, coverage) }),
  }, fetcher);
  if (data.errcode !== 0 || !data.msgid) throw new Error('微信接口未确认消息已接受');
  return { accepted: true };
}

# 医学影像招聘每日推送

默认画像：2027届硕士、CT方向、规培已完成、已取得医师资格证；影像医师优先，黑龙江优先，全国补充，技师候补。未确认的执业注册、学硕/专硕、专业代码及技师资格始终提示核对，不自动认定符合报名条件。

## 运行

需要 Node.js 24：

```bash
npm ci --prefix recruitment
npm test --prefix recruitment
node --use-env-proxy recruitment/run.mjs --dry-run
```

预览不发送消息，不改变已发送状态。报告位于忽略目录 `.recruitment-state/reports/latest.md`，包含各来源成功/失败情况。全部来源失败时返回非零退出码，不能据此声称没有招聘。只有新增、实质更新或首次进入截止前3天提醒窗口时才发送；每日最多5条医师、2条技师和3条提醒。

在 `config.json` 编辑来源及筛选上限。现配置15个来源，包含哈医大及两所附属医院、齐齐哈尔医学院及直属单位、黑龙江省医院、省传染病防治院、省卫健委，以及北京、天津、辽宁、山东医院和吉林大学就业网的官方转发。高校转发不是用人单位，未知地区不当作发布学校所在地。不代表每个来源都有符合条件的当前招聘。最多两个无共享主机的来源并行；单源仍依次读取、保留礼貌延迟，最多4个目录页和12篇公告。跳转或附件域名需显式加入该来源的 `allowedHosts`，不会访问网页上任意域名。

公开GET请求遇到连接重置、暂时超时等传输故障时，最多等待500毫秒后重试一次；HTTP 403/404/406、TLS证书错误、验证码等不会通过重复请求或放宽校验绕过。重试不能保证来源恢复，最终状态以每次报告为准。

HTML表格和XLSX岗位表按行提取，学历、学位分别核对；博士专用、届别明确不符、科研导师及栏目导航不当作临床岗位。职业不明确的公告线索不计入医师/技师候选。排序优先明确岗位、硕士与2027届证据、CT方向和黑龙江，但不是报名资格认证。跨来源仅在明确单位、岗位代码、同轮次及条件等强证据一致时合并，保留旧去重记录兼容。

也支持网址为 `download.jsp`、锚文本为 `.xlsx` 文件名的官方附件。PDF、旧XLS、图片或脚本渲染页面需要人工核实或专门适配；验证码页明确记录为待核实，不绕过验证、不把无结果当成无岗位。无日期公告保留未知，不伪造为今天；近90天以外的公告只有明确报名截止仍有效才保留。超过90天未观察的缓存清理。考试、公示等后续流程不作新招聘。

## Codex 云环境网络配置

云开发环境的网络设置只影响开发和调试，不控制 GitHub Actions 的网络，也不能替代微信凭据。环境联网设置修改后，需要保存并发布，再在新任务中验证。

选择“包管理器”，在“额外允许的域名”加入以下实际使用的主机：

```text
hr.hrbmu.edu.cn
www.hrbmu.edu.cn
www.54dr.org.cn
www.hrbmush.edu.cn
wsjkw.hlj.gov.cn
www.cmu1h.com
jobs.pumch.cn
www.qmu.edu.cn
www.hljsyy.org.cn
omo-oss-file110.thefastfile.com
hljjh.org.cn
www.lnpatcm.com
v1.cecdn.yun300.cn
jdjyw.jlu.edu.cn
www.yuquanhosp.cn
www.zryhyy.com.cn
www.tjfch.com.cn
www.sph.com.cn
api.github.com
api.weixin.qq.com
```

额外域名不是通配符，允许学校主域名不会自动允许 `hr` 子域名。包管理器预设之外的 GitHub API 也要单独允许。若来源诊断是 `HTTP 403`，检查代理策略与网站响应；若是 `ECONNRESET` 或 TLS 错误，则是连接被重置，增加无关域名或微信密钥不会修复。

北京协和医院使用专用公开接口适配，读取其招聘网页实际使用的列表和岗位详情接口。每次最多3页列表（30篇公告）、12篇近期详情，逐个真实岗位筛选；未覆盖的历史公告、学历代码及未解析附件会明确提示，不能将有界检查解读为已覆盖全部招聘。

## GitHub Actions 部署

已有 `.github/workflows/qinglong-push.yml` 已改为招聘工作流，每天北京时间07:30运行；旧版 `weixin-push-on-time.yml` 只保留手动触发，避免继续定时发送生活内容。GitHub的定时任务可能延迟，并且工作流需要位于默认分支且Actions已启用。

正式任务使用标准 `macos-latest` GitHub托管环境，不需要个人电脑保持开机。2026-10-19的无密钥只读对比中，Ubuntu可采集2/6来源，Windows和macOS均为4/6；这不是持续可达性保证，仍需查看每次来源报告。可手动运行 `recruitment-hosted-network-check` 复查三个环境；该诊断不发送微信、不修改远程去重记录。

1. 将代码部署到默认分支后，在Actions运行 `medical-imaging-recruitment`，先保持 `dry_run=true`，查看下载的日报及来源状态。需要逐项核实来源能访问、招聘入口正确、公告内容可以解析。这个预览不要求微信Secrets。
2. 沿用原有 `ALL_CONFIG`：读取 `APP_ID`、`APP_SECRET` 和 `USER_INFO` 中的微信接收人、模板ID。也兼容已有 `USER_OPENID`、`ADDITIONAL_USER_OPENIDS`、`WECHAT_TEMPLATE_ID` 覆盖项。若不用ALL_CONFIG，则分别设置 `APP_ID`、`APP_SECRET`、`USER_OPENID`、`WECHAT_TEMPLATE_ID`。只在GitHub仓库Settings → Secrets and variables → Actions安全输入；不要把凭据放进代码、聊天或日志。无需天行API Key。
3. 在微信测试号平台，将模板文字改为下面的招聘模板，字段名保持一致；如果创建了新模板，将新ID存到 `RECRUITMENT_TEMPLATE_ID`。脚本支持已有字段，但无法通过本地代码更改微信平台保存的文字标签。
4. 再以 `dry_run=false` 手动运行，确认微信消息和详情链接。`errcode=0` 且有 `msgid` 才记录为接口已接受；这不等于用户已读或确认送达。

在正式发送前，可手动选择 `test_wechat=true`：流程只验证 `RECRUITMENT_TEMPLATE_ID` 指向的模板是否包含8个正确字段，生成并发布真实采集预览，然后向现有接收人发送明确标注的测试消息。该模式不会把任何岗位记录为已发送，也不会因普通代码推送而发送测试消息。模板列表、密钥和接收人的原始ID不会打印到日志。

要查看真实日常内容而非字段占位测试，手动选择 `daily_preview=true`、保持 `test_wechat=false`。流程重新采集并发布报告，再用与正式推送相同的排版发送一次；没有候选时如实显示暂无新增，不编造岗位。此模式不会修改岗位已发送或提醒记录，也不会改变定时任务的“无新增不推送”规则。两个手动预览模式不能同时选择。

只验收网页和跨网络同步时选择 `publish_web_preview=true`，其他两个发送预览保持false。此模式强制只读采集，把报告及网页更新，但不发送微信，也不改岗位去重记录；即使误把dry_run关闭也不会发送。不能与任何微信预览模式同时选择。普通代码push仍仅生成不发布的预览。

模板内容：

```text
日期：{{a.DATA}}
概览：{{b.DATA}}

岗位：{{l.DATA}}
候补：{{n2.DATA}}

重点：{{q1.DATA}}
摘要：{{q2.DATA}}

提醒：{{m1.DATA}}
详情：{{m2.DATA}}
```

脚本将字段限制在现有模板使用的长度内。若微信平台对当前账号/模板限制不同，以接口实际响应为准，不能通过删减岗位资格信息冒充完整信息；完整内容在报告中保留。

## 详情及状态持久化

工作流在独立 `recruitment-state` 分支保存 `state.json` 和招聘报告，不修改默认分支。公共网页数据由严格字段白名单生成 `reports/public.json`，不含密钥、原始接收人或去重记录。网页目录列出所有未确认过期的可展示岗位，不受单条微信数量上限或已发送历史限制。

独立的手机阅读页源码在 `web/`，不加载外部CDN，浏览器仅访问同域数据。自有域名部署步骤见 [Ubuntu部署说明](deploy/README.md)。服务器同步只监听回环端口，使用新建的专用令牌；不能上传管理服务器的SSH私钥到GitHub。

启用网站时设置仓库变量 `RECRUITMENT_PUBLIC_BASE_URL` 与Secret `RECRUITMENT_SITE_SYNC_TOKEN`。发布器先同步，再完整回读核对公共JSON，成功才把微信详情指向本次不可变快照 `/?report=<reportId>`。未配置或验证失败时自动回退当前提交的GitHub报告，不用自域的旧数据冒充新日报；GitHub提交标识也不可用时明确降级为状态分支链接。私有仓库的备用报告需要GitHub登录。

不要删除 `recruitment-state` 分支，否则会丢失去重记录。状态分支不包含凭据，接收人仅保存不可逆哈希。

工作流需要 `contents: write` 权限。先发布可点击报告再发送微信，最后保存逐接收人的成功记录；部分接收人失败时已成功者不会重新发送，失败者下次重试。若微信接受后持久化状态本身失败，下一次可能重复发送，应先检查失败运行；外部消息发送与Git提交无法实现跨系统原子事务。

本机部署可以依次运行：

```bash
# 凭据通过安全的环境变量注入，命令行不要包含密钥。
node --use-env-proxy recruitment/github-state.mjs restore
node --use-env-proxy recruitment/run.mjs --collect-only
node --use-env-proxy recruitment/github-state.mjs publish
node --use-env-proxy recruitment/publish-web.mjs
# RECRUITMENT_REPORT_URL 使用上述已验证输出的HTTPS链接，不能手填未经验证的站点。
node --use-env-proxy recruitment/run.mjs --send-only
node --use-env-proxy recruitment/github-state.mjs publish
```

同步步骤需要 `GITHUB_REPOSITORY=owner/repo` 与可写入仓库的 `GH_TOKEN` 或 `GITHUB_TOKEN`。本机任务不是常驻托管服务；长期定时运行使用GitHub Actions，而不依赖云开发环境中的进程存活。

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

在 `config.json` 编辑来源及筛选上限。默认六个来源覆盖哈尔滨医科大学及两所附属医院、黑龙江省卫健委，以及辽宁、北京的医院。它们是待连接验证的官方入口，不代表已确认存在当前招聘。模块从首页识别招聘入口，再读取最多3个目录页和12篇公告；建议验证后将 `url` 改成明确的招聘栏目地址，并设 `isListing: true`。跳转或附件域名需显式加入该来源的 `allowedHosts`，不会自动访问网页上任意域名。

HTML表格和XLSX岗位表按行提取，避免把一个岗位的博士要求套用到其他岗位。PDF、旧XLS、图片或脚本渲染页面需要人工核实或后续专门适配；附件解析失败会记入诊断，不会把无结果当成无岗位。无日期公告标注待核实；有明确发布日期时仅取最近90天。有明确报名截止时间时过滤已截止信息。

## GitHub Actions 部署

已有 `.github/workflows/qinglong-push.yml` 已改为招聘工作流，每天北京时间07:30运行；旧版 `weixin-push-on-time.yml` 只保留手动触发，避免继续定时发送生活内容。GitHub的定时任务可能延迟，并且工作流需要位于默认分支且Actions已启用。

1. 将代码部署到默认分支后，在Actions运行 `medical-imaging-recruitment`，先保持 `dry_run=true`，查看下载的日报及来源状态。需要逐项核实来源能访问、招聘入口正确、公告内容可以解析。这个预览不要求微信Secrets。
2. 沿用原有 `ALL_CONFIG`：读取 `APP_ID`、`APP_SECRET` 和 `USER_INFO` 中的微信接收人、模板ID。也兼容已有 `USER_OPENID`、`ADDITIONAL_USER_OPENIDS`、`WECHAT_TEMPLATE_ID` 覆盖项。若不用ALL_CONFIG，则分别设置 `APP_ID`、`APP_SECRET`、`USER_OPENID`、`WECHAT_TEMPLATE_ID`。只在GitHub仓库Settings → Secrets and variables → Actions安全输入；不要把凭据放进代码、聊天或日志。无需天行API Key。
3. 在微信测试号平台，将模板文字改为下面的招聘模板，字段名保持一致；如果创建了新模板，将新ID存到 `RECRUITMENT_TEMPLATE_ID`。脚本支持已有字段，但无法通过本地代码更改微信平台保存的文字标签。
4. 再以 `dry_run=false` 手动运行，确认微信消息和详情链接。`errcode=0` 且有 `msgid` 才记录为接口已接受；这不等于用户已读或确认送达。

模板内容：

```text
📅 医学影像招聘·{{a.DATA}}
📊 今日概览·{{b.DATA}}

🩺 {{l.DATA}}
🔬 {{n2.DATA}}

重点关注
{{q1.DATA}}
{{q2.DATA}}

⏳ {{m1.DATA}}
🔗 {{m2.DATA}}
```

脚本将字段限制在现有模板使用的长度内。若微信平台对当前账号/模板限制不同，以接口实际响应为准，不能通过删减岗位资格信息冒充完整信息；完整内容在报告中保留。

## 详情及状态持久化

工作流在独立 `recruitment-state` 分支保存 `state.json` 和公开招聘报告，不修改默认分支。微信点击详情打开该分支的 `reports/latest.md`，每条信息附官方公告链接；私有仓库需登录GitHub后访问。无需额外开通网站或GitHub Pages。分支不包含凭据，接收人仅保存不可逆哈希；不要删除此分支，否则会丢失去重记录。

工作流需要 `contents: write` 权限。先发布可点击报告再发送微信，最后保存逐接收人的成功记录；部分接收人失败时已成功者不会重新发送，失败者下次重试。若微信接受后持久化状态本身失败，下一次可能重复发送，应先检查失败运行；外部消息发送与Git提交无法实现跨系统原子事务。

本机部署可以依次运行：

```bash
# 凭据通过安全的环境变量注入，命令行不要包含密钥。
node --use-env-proxy recruitment/github-state.mjs restore
node --use-env-proxy recruitment/run.mjs --collect-only
node --use-env-proxy recruitment/github-state.mjs publish
# RECRUITMENT_REPORT_URL 指向已经发布的HTTPS报告。
node --use-env-proxy recruitment/run.mjs --send-only
node --use-env-proxy recruitment/github-state.mjs publish
```

同步步骤需要 `GITHUB_REPOSITORY=owner/repo` 与可写入仓库的 `GH_TOKEN` 或 `GITHUB_TOKEN`。本机任务不是常驻托管服务；长期定时运行使用GitHub Actions，而不依赖云开发环境中的进程存活。

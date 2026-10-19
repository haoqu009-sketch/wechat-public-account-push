# Ubuntu 自有域名招聘阅读页部署准备

目标子域名为 `jobs.ragzhicha.cn`，腾讯云北京服务器地址为 `82.156.99.248`。本文记录独立站点的部署步骤；实际启用状态应以服务器验收为准。该服务器的 UFW 限制公网 SSH，已有 Tailscale 安全内网，可通过已授权的内网连接部署，不应为此关闭防火墙。

保持现有主域名及服务。不要覆盖默认站点，不要关闭防火墙，不要执行清空 `/var/www`、`/etc/nginx` 等目录的命令。私钥 `Q.pem` 只留在你自己的受信设备上，不上传项目、GitHub、网站目录或聊天。

## 1. 先只读核查服务器

用云控制台或恢复后的 SSH 登录后，先检查当前环境。以下检查不会安装或重启服务：

```bash
uname -a
cat /etc/os-release
command -v nginx apache2 apachectl caddy docker node certbot
command -v node
node --version
sudo ss -ltnp
sudo systemctl list-units --type=service --state=running
sudo ls -l /etc/nginx/sites-enabled
```

有对应组件时，再检查现有站点和容器端口：

```bash
sudo nginx -t
sudo apachectl -S
sudo docker ps --format '{{.Names}}\t{{.Ports}}'
sudo certbot certificates
```

只运行存在的命令。不要把环境变量、私钥正文或带认证头的调试输出贴进日志；不运行可能显示容器密钥的完整 `docker inspect`，也不要打印 `sync.env`。确认 80/443 由谁持有、是否已有反向代理及 TLS 证书。如果 Apache、Caddy 或容器已经占用这些端口，应接入其现有反向代理，不能再启动一套冲突的 Nginx。本目录给的是现有 Nginx 环境下的独立虚拟主机示例。

服务使用 Node.js 24。示例 `ExecStart` 使用独立的 `/opt/recruitment-reader/runtime/node/bin/node`，不改变其他应用的系统 Node。`prepare-isolated-runtime.sh` 仅适用于已检查目录未占用的 x86_64 目标：从 Node.js 官方 HTTPS 地址下载固定版本并验证已核实的 SHA-256，创建无登录专用账户和独立目录。执行前审查脚本，已有专用账户或运行时会停止，不能直接反复执行。不要使用其他用户主目录中的 Node：服务启用 `ProtectHome=true`。

## 2. 仅新增子域名 DNS

在 `ragzhicha.cn` 的 DNS 管理中精确新增一条记录：

| 项目 | 值 |
| --- | --- |
| 主机记录 | `jobs` |
| 类型 | `A` |
| 记录值 | `82.156.99.248` |

不修改 `@`、`www` 或其他既有解析。先检查 `jobs` 是否已有记录，不能直接覆盖其已有用途；不要在未核实 IPv6 前新增 AAAA。记录生效后，在客户端核对：

```bash
getent ahostsv4 jobs.ragzhicha.cn
```

若现有云安全组和系统防火墙未开放网站所需的 80/443，只增加这两个端口的精确规则；8769 不对公网开放。不要关闭防火墙或删除已有规则。

## 3. 创建独立用户及目录

先确认下面的用户名和目录未被其他应用占用。若已存在，核对归属和用途后再决定是否复用。以下是人工操作清单，不是自动安装脚本：

```bash
getent passwd recruitment-reader
sudo ls -ld /opt/recruitment-reader /var/www/recruitment-reader /var/lib/recruitment-reader /etc/recruitment-reader
```

确定未占用后创建无登录系统用户及专用目录：

```bash
sudo useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin recruitment-reader
sudo install -d -m 0755 -o root -g root /opt/recruitment-reader/recruitment
sudo install -d -m 0755 -o root -g root /var/www/recruitment-reader
sudo install -d -m 0755 -o recruitment-reader -g recruitment-reader /var/lib/recruitment-reader/data
sudo install -d -m 0700 -o root -g root /etc/recruitment-reader
sudo install -d -m 0755 -o root -g root /var/www/letsencrypt/.well-known/acme-challenge
```

只上传已审查的 `recruitment/site-server.mjs`、本目录配置，以及前端成品静态文件。同步服务代码放到 `/opt/recruitment-reader/recruitment/site-server.mjs`；前端 `index.html` 与其本地 CSS/JS 等资源放到 `/var/www/recruitment-reader`，保持资源相对路径不变。代码和静态资源归 root 所有、普通文件权限 0644。不要整仓复制到网站根目录，不上传 `.git`、`.env`、去重状态、`pending.json`、微信配置或 SSH 私钥。

同步服务仅使用 Node 原生模块，运行这个服务本身不需要安装 Excel/采集依赖，也不在服务器执行采集器。Nginx 只提供静态页面和白名单公共 JSON，采集仍由 GitHub Actions 执行。

## 4. 新建独立同步密钥

同步密钥必须与微信、天行、DeepSeek、SSH 密钥分开。至少 32 字符；建议随机 32 字节转成 64 位十六进制。下面的单条命令只创建服务环境文件，不打印密钥；`set -C` 会在文件已存在时停止，避免无意轮换：

```bash
sudo bash -c 'set -euo pipefail; set -C; umask 077; sync_token_value="$(openssl rand -hex 32)"; printf "RECRUITMENT_SITE_SYNC_TOKEN=%s\nRECRUITMENT_SITE_DATA_DIR=/var/lib/recruitment-reader/data\nRECRUITMENT_SITE_SYNC_PORT=8769\n" "$sync_token_value" > /etc/recruitment-reader/sync.env; unset sync_token_value'
sudo stat -c '%U %G %a %n' /etc/recruitment-reader/sync.env
```

应看到环境文件为 `root root 600`。`EnvironmentFile` 由 systemd 管理器读取并注入进程，服务用户无需拥有读取该文件的权限。只在你自己控制的交互式文件编辑器中复制同步密钥，稍后安全填入 GitHub Secret；不要用命令参数、`echo`、日志或聊天传递密钥。

## 5. 安装服务并先验证回环监听

核对 Node 绝对路径后，将本目录 `recruitment-reader-sync.service` 安装为同名新服务。不要替换已有其他服务文件。人工执行：

```bash
sudo install -m 0644 recruitment/deploy/recruitment-reader-sync.service /etc/systemd/system/recruitment-reader-sync.service
sudo systemd-analyze verify /etc/systemd/system/recruitment-reader-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now recruitment-reader-sync.service
sudo systemctl status recruitment-reader-sync.service --no-pager
sudo ss -ltnp
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8769/api/sync
```

最后一个无凭据 GET 应返回 `405`；监听必须为 `127.0.0.1:8769`。它不是给浏览器读取文件的服务，不提供目录列表或任意 GET 下载。服务失败时只检查脱敏错误和配置归属，不打印环境文件或 token。系统服务启用单进程运行；不要用 PM2 cluster、多副本或不同端口的多个进程同时写同一个数据目录。

## 6. HTTP 虚拟主机与 ACME

先人工审查 `recruitment-reader.http.conf`，确认只涉及 `jobs.ragzhicha.cn`。它没有 `default_server`，不需要尚不存在的证书，并预留 ACME webroot。安装到独立文件，再启用一个此前不存在的站点链接：

```bash
sudo install -m 0644 recruitment/deploy/recruitment-reader.http.conf /etc/nginx/sites-available/recruitment-reader.http.conf
sudo ln -s /etc/nginx/sites-available/recruitment-reader.http.conf /etc/nginx/sites-enabled/recruitment-reader.conf
sudo nginx -t
sudo systemctl reload nginx
```

如果同名链接已存在，`ln -s` 会失败；先核对，不要使用强制覆盖，也不删除已有主域站点。只有 `nginx -t` 成功后才 reload。用浏览器或不带凭据的请求确认 HTTP 页面由这个子域返回。此阶段不配置 GitHub 同步凭据，不通过 HTTP 发送 token。

如果已有适用证书，确认其域名、完整链及私钥路径后直接准备下一阶段；不要改动现有主域证书。若需新签子域证书，先确认 Certbot 已存在或由管理员单独安装，再人工使用 webroot 模式，避免让它自动改写其他站点：

```bash
sudo certbot certonly --webroot -w /var/www/letsencrypt -d jobs.ragzhicha.cn
sudo test -r /etc/letsencrypt/live/jobs.ragzhicha.cn/fullchain.pem
sudo test -r /etc/letsencrypt/live/jobs.ragzhicha.cn/privkey.pem
```

不要查看或复制私钥正文。若用云平台签发的证书，将下一节 HTTPS 示例中的两个路径改成已核实的服务器证书路径。

## 7. 证书就绪后切换独立 HTTPS 配置

仅在证书文件已存在且 Nginx 可读时，审查并安装 `recruitment-reader.https.conf`。它同时包含这个子域的 HTTP 跳转和 HTTPS 站点；不能与 HTTP-only 配置同时启用，否则 `server_name` 冲突。

```bash
sudo install -m 0644 recruitment/deploy/recruitment-reader.https.conf /etc/nginx/sites-available/recruitment-reader.https.conf
sudo ls -l /etc/nginx/sites-enabled/recruitment-reader.conf
```

确认该链接正是本手册第 6 节创建、目前指向 HTTP-only 示例后，再人工改指 HTTPS 示例。不要操作其他站点链接：

```bash
sudo ln -sfn /etc/nginx/sites-available/recruitment-reader.https.conf /etc/nginx/sites-enabled/recruitment-reader.conf
sudo nginx -t
sudo systemctl reload nginx
```

若语法检查失败，不 reload，先把这个专属链接恢复到 HTTP-only 示例并重新检查。运行中的 Nginx 不会因为一次配置检查失败而自动停止。证书续期的 webroot 路径仍保留；核实续期任务，并只在证书更新且 `nginx -t` 成功后 reload Nginx，不重启其他服务。

该配置所有页面和 JSON 均为 `no-store`，脚本、样式及数据请求只允许同源；不加载外部 CDN。不要添加 `Access-Control-Allow-Origin: *`，前端也不需要同步密钥。数据路径仅公开 `/data/public.json` 和 `/data/<24位reportId>.json`，其余数据路径与隐藏文件返回 404。

## 8. GitHub 配置与完整回读验收

在仓库 `Settings → Secrets and variables → Actions` 设置：

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Secret | `RECRUITMENT_SITE_SYNC_TOKEN` | 与服务器环境文件完全相同的独立同步密钥 |
| Repository variable | `RECRUITMENT_PUBLIC_BASE_URL` | `https://jobs.ragzhicha.cn` |

只在 HTTPS 已就绪后设置。先从不带凭据的公开请求核查状态：

```bash
curl -I https://jobs.ragzhicha.cn/
curl -s -o /dev/null -w '%{http_code}\n' https://jobs.ragzhicha.cn/api/sync
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' https://jobs.ragzhicha.cn/api/sync
curl -s -o /dev/null -w '%{http_code}\n' https://jobs.ragzhicha.cn/.env
```

依次应为页面可读、GET `405`、无认证 POST `401`、隐藏文件 `404`。首次成功同步之前，`/data/public.json` 不存在是预期情况；不能把空数据或旧文件冒充本次发布。

然后在已加载这两个配置值、并已生成当天脱敏报告的受信执行环境中运行 `node recruitment/publish-web.mjs`，或运行工作流中对应的网站同步及回读步骤。这一步只发布网页数据，不直接调用微信；不要在命令行内填入 token。

发布端会先 Bearer POST `/api/sync`，核对返回的 `reportId`，再 GET `/data/public.json?report=<reportId>`，最多回读 3 次，并完整比对报告内容。只有完全一致才生成 `https://jobs.ragzhicha.cn/?report=<reportId>` 的微信详情链接；同步失败、重定向、数据仍旧或回读不一致时继续使用 GitHub 备用报告。手动查看页面、岗位原文链接、来源缺口和手机显示，验收后再让正式 07:30 流程使用自域链接。

同步服务只校验 `reportId` 为 24 位十六进制，并用同 ID 的完整内容一致性保证不可变；不重新计算上游 JSON 哈希，避免对象字段顺序耦合。相同内容重试幂等，不同内容复用 ID 返回 409；旧生成时间不覆盖新快照。快照与 `public.json` 分别通过同目录原子重命名发布；两步之间发生故障时，重试可补全 latest。网页目录里只放经过公共字段白名单导出的报告，不含收件人、密钥或去重记录。

## 回退范围

本目录没有全自动 root 安装脚本。若新站点尚未验收，先不设置或撤销仓库变量 `RECRUITMENT_PUBLIC_BASE_URL`，微信仍用 GitHub 备用报告。需要停用时，只停 `recruitment-reader-sync.service`、撤下本手册创建的独立站点链接并在语法检查成功后 reload 现有 Nginx；不要删除其他站点、证书、应用目录或招聘去重分支。既有报告快照可保留，无需清空数据目录。

配置语义参考 [Nginx 官方 location/alias 文档](https://nginx.org/en/docs/http/ngx_http_core_module.html#alias)及 [systemd 官方进程隔离文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)。示例仍需在目标服务器通过 `nginx -t` 和 `systemd-analyze verify`；本机没有实际执行这些线上检查。

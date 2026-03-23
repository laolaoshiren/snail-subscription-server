# 蜗牛助手订阅中转服务

## 一键安装

生产服务器执行这一条命令即可完成安装或更新、写入 `systemd` 服务、设置开机自启并立即启动：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/snail-subscription-server/main/scripts/install.sh | sudo bash
```

## Docker 一键安装

如果你希望用 Docker 部署，执行这一条命令即可完成安装或更新、拉取镜像并启动容器：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/snail-subscription-server/main/scripts/docker-install.sh | sudo bash
```

脚本会交互式询问两项内容：

- 面板密码
- 监听端口

规则如下：

1. 新安装时，密码直接回车会自动生成随机密码。
2. 新安装时，端口直接回车会自动生成随机端口。
3. 更新已安装项目时，密码直接回车会保留当前密码。
4. 更新已安装项目时，端口直接回车会保留当前端口。

脚本会自动判断当前服务器是首次安装还是已有项目更新。
脚本会优先自动探测公网 IP，并把它写入服务配置，后续面板和 API 生成的中转链接会优先使用这个公网地址。

如果你不想交互，也可以通过环境变量直接传值：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/snail-subscription-server/main/scripts/install.sh | sudo env PANEL_PASSWORD='你的密码' PORT=3000 PROXY_URL=http://127.0.0.1:7890 INVITE_CODE=你的邀请码 bash
```

Docker 模式同样支持环境变量直传：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/snail-subscription-server/main/scripts/docker-install.sh | sudo env PANEL_PASSWORD='你的密码' PORT=3000 PROXY_URL=http://127.0.0.1:7890 INVITE_CODE=你的邀请码 bash
```

## 项目说明

这是一个服务器端订阅中转面板。面板展示的是固定的服务器订阅链接，客户端始终使用服务器地址，不直接接触外部订阅地址。

当前逻辑如下：

1. 面板内置 `用户A` 到 `用户E` 共 5 个用户位，每个用户都有独立的服务器中转 token。
2. 兼容模式保留旧逻辑，客户端每次拉取固定中转链接时都会重新注册上游账号。
3. 智能模式只会在两种请求到来时访问上游：客户端拉取订阅、管理页查看当前用户状态。
4. 智能模式下，服务端会先查询当前用户上游流量；剩余流量低于 `20%` 才重新注册，否则直接复用现有上游订阅。
5. 管理页支持按用户查看最近流量快照、历史注册时间和中转日志。
6. 如果你给服务器绑定了域名，可以在管理页设置里填写中转域名；填写后页面和 API 返回的订阅链接会优先按该域名显示。

## 生产部署结果

一键安装脚本默认会完成这些动作：

1. 安装 `curl`、`git`、`Node.js 20`。
2. 把项目部署到 `/opt/snail-subscription-server`。
3. 生成环境文件 `/etc/snail-subscription-server.env`。
4. 创建 `systemd` 服务 `snail-subscription-server`。
5. 执行开机自启并立即启动服务。
6. 首次安装时写入你设置的面板密码，或自动生成随机密码。

支持的系统以常见 Linux 发行版为主，要求系统使用 `systemd`。

## Docker 发布

仓库已经加入 GitHub Actions 自动构建流程。每次推送到 `main` 后，GitHub 会自动构建 Docker 镜像。

如果是刚推送完新版本，先等 GitHub Actions 执行成功，再使用 Docker 一键安装脚本拉取最新镜像。

默认镜像地址：

```text
ghcr.io/laolaoshiren/snail-subscription-server:latest
```

相关文件：

- `.github/workflows/docker.yml`
- `Dockerfile`
- `.dockerignore`
- `scripts/docker-install.sh`

## 常用运维命令

查看服务状态：

```bash
sudo systemctl status snail-subscription-server
```

查看实时日志：

```bash
sudo journalctl -u snail-subscription-server -f
```

重启服务：

```bash
sudo systemctl restart snail-subscription-server
```

## 可选环境变量

安装命令里可以按需覆盖这些变量：

- `PORT`
- `PROXY_URL`
- `INVITE_CODE`
- `ALLOW_INSECURE_TLS`
- `RELAY_FETCH_TIMEOUT_MS`
- `MAX_RETRIES`
- `RETRY_DELAY_MS`
- `FETCH_TIMEOUT_MS`
- `PUBLIC_ORIGIN`

默认情况下安装脚本会把 `PROXY_URL` 设为 `off`。如果你的服务器访问外网必须经过代理，请显式传入代理地址。

## 访问面板

默认地址：

```text
http://127.0.0.1:3000
```

程序监听在 `0.0.0.0`，同一局域网内的其他设备可以通过服务器实际 IP 访问。

如果你是用一键安装脚本部署，面板密码以安装脚本最后输出的结果为准。

如果你是本地手动直接运行项目，默认面板密码仍然是 `admin`。

## API

需要登录的接口：

- `POST /api/login`
- `POST /api/logout`
- `GET /api/session`
- `POST /api/password`
- `POST /api/settings`
- `POST /api/subscriptions`
- `GET /api/subscriptions/latest?type=full&user=userA`

公开订阅入口：

- `GET /subscribe/:type?token=...`

支持的订阅类型：

- `full`
- `universal`
- `clash`
- `shadowrocket`
- `surge`
- `quantumultx`
- `sing-box`

## 本地开发

安装依赖：

```bash
npm install
```

启动项目：

```bash
npm start
```

开发模式：

```bash
npm run dev
```

## CLI 示例

读取当前最新记录：

```bash
$env:PANEL_PASSWORD="admin"
node src/client.js latest full
```

手动触发一次注册并返回当前中转链接：

```bash
node src/client.js create full TESTCODE http://127.0.0.1:3000
```

## Mock 模式

如果只想测试整条中转链路，而不访问真实外部资源，可以使用 Mock 模式：

```bash
$env:AUTO_REGISTER_MOCK="1"
npm start
```

Mock 模式下，中转链接仍然可访问，但返回的是本地生成的模拟内容。

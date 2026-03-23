# 蜗牛助手订阅中转服务

## 一键安装

生产服务器执行这一条命令即可完成安装或更新、写入 `systemd` 服务、设置开机自启并立即启动：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/snail-subscription-server/main/scripts/install.sh | sudo bash
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

如果你不想交互，也可以通过环境变量直接传值：

```bash
curl -fsSL https://raw.githubusercontent.com/laolaoshiren/snail-subscription-server/main/scripts/install.sh | sudo env PANEL_PASSWORD='你的密码' PORT=3000 PROXY_URL=http://127.0.0.1:7890 INVITE_CODE=你的邀请码 bash
```

## 项目说明

这是一个服务器端订阅中转面板。面板展示的是固定的服务器订阅链接，客户端始终使用服务器地址，不直接接触外部订阅地址。

当前逻辑如下：

1. 面板生成固定的服务器中转链接。
2. 客户端每次请求这个固定链接时，服务端都会重新执行注册脚本。
3. 服务端拿到这一次最新的订阅内容后，立即中转返回给客户端。
4. 本地只保存最近一次注册结果，方便面板查看和排错。

## 生产部署结果

一键安装脚本默认会完成这些动作：

1. 安装 `curl`、`git`、`Node.js 20`。
2. 把项目部署到 `/opt/snail-subscription-server`。
3. 生成环境文件 `/etc/snail-subscription-server.env`。
4. 创建 `systemd` 服务 `snail-subscription-server`。
5. 执行开机自启并立即启动服务。
6. 首次安装时写入你设置的面板密码，或自动生成随机密码。

支持的系统以常见 Linux 发行版为主，要求系统使用 `systemd`。

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
- `POST /api/subscriptions`
- `GET /api/subscriptions/latest?type=full`

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

# Snail Subscription Server

This project provides a dark-mode web control panel for a server-side subscription relay flow.

The logic is:

1. You log in to the panel with a password
2. The server runs `auto_register.js`
3. The server stores the latest upstream registration result locally
4. The panel shows server-hosted relay subscription links
5. The client always uses the server URL, not the upstream URL
6. When the client requests a relay link, the server fetches and returns the current upstream subscription content

## Install

```bash
npm install
```

## Start

```bash
npm start
```

Default address:

```text
http://127.0.0.1:3000
```

The server listens on `0.0.0.0`, so devices on the same network can access it by using the host machine IP.

## Login

Open:

```text
http://127.0.0.1:3000
```

Default panel password:

- `admin`

The dashboard supports changing the password online.

## Upstream detection

The registration script now starts from the detector entry and resolves the current official site config dynamically:

- Detector entry: [http://xn--9kq658f7go.com/](http://xn--9kq658f7go.com/)
- Detector config: [https://xn--9kq658f7go.com/config.json](https://xn--9kq658f7go.com/config.json)
- Official config example: [https://snaillink.com/config.json](https://snaillink.com/config.json)

The script reads the live `api_base` from the official site config instead of only relying on a hard-coded API URL.

## Protected API

Authenticated endpoints:

- `POST /api/login`
- `POST /api/logout`
- `GET /api/session`
- `POST /api/password`
- `POST /api/subscriptions`
- `GET /api/subscriptions/latest?type=full`

Public relay endpoint:

- `GET /subscribe/:type?token=...`

Supported subscription `type` values:

- `full`
- `universal`
- `clash`
- `shadowrocket`
- `surge`
- `quantumultx`
- `sing-box`

## CLI client

The example client logs in with the panel password and then calls the protected API.

```bash
$env:PANEL_PASSWORD="admin"
node src/client.js latest full
```

Create a new upstream registration and get the current server relay URLs:

```bash
node src/client.js create full TESTCODE http://127.0.0.1:3000
```

## Mock mode

To test the whole flow without creating a real upstream account:

```bash
$env:AUTO_REGISTER_MOCK="1"
npm start
```

In mock mode the panel still generates working server relay URLs, but the upstream data is fake and local-only.

# 上游模块开发文档

这份文档的目标只有一个：

任何人不需要阅读项目源码，只靠这份文档，就能写出一个新的上游模块，放进项目后直接被主程序识别、配置、重载和使用。

## 1. 模块接入效果

当你完成一个模块后，主程序会自动提供这些能力：

- 在管理面板的“上游”页自动出现这个模块
- 自动加载模块描述、支持的订阅类型、能力声明和私有配置字段
- 自动持久化模块配置
- 自动支持“重载上游模块”
- 自动把模块返回的上游注册结果接入中转逻辑
- 自动把模块返回的上游流量查询结果接入智能续期逻辑

你不需要修改以下核心文件：

- `src/server.js`
- `src/authStore.js`
- `src/upstreams/service.js`
- `public/app.js`
- `public/index.html`

唯一需要新增的是一个新的模块目录。

## 2. 模块放置位置

把你的模块放到：

```text
src/upstreams/vendors/<module-id>/index.js
```

例如：

```text
src/upstreams/vendors/my-provider/index.js
```

主程序扫描 `src/upstreams/vendors/` 下的每个目录，并尝试加载其中的 `index.js`。

如果模块定义不合法：

- 模块不会被加载
- 点击“重新加载上游模块”时，面板会提示有几个模块未通过校验
- 你也可以用命令行主动检查

## 3. 最小开发流程

1. 复制模板

```text
templates/upstream-vendor-template/index.js
```

2. 粘贴到新目录

```text
src/upstreams/vendors/<module-id>/index.js
```

3. 改 3 处核心内容

- `manifest`
- `register()`
- `query()`

4. 运行校验

```bash
npm run upstreams:check
```

或者只校验单个文件/目录：

```bash
node scripts/check-upstreams.js src/upstreams/vendors/<module-id>
```

5. 在管理面板点击“重新加载上游模块”

## 4. 标准导出接口

模块必须通过官方 helper 导出：

```js
const { defineUpstreamModule } = require("../../src/upstreams/core/moduleContract");

module.exports = defineUpstreamModule({
  manifest: { ... },
  defaultConfig: { ... },
  normalizeProviderSettings(settings, context) { ... },
  async register(context) { ... },
  async query(context) { ... },
});
```

`defineUpstreamModule()` 会自动完成这些事情：

- 规范化 `manifest`
- 规范化模块配置
- 校验模块能力声明
- 校验 `register()` 的返回结构
- 校验 `query()` 的返回结构
- 给主程序补齐默认值

## 5. manifest 规范

### 5.1 必填字段

```js
manifest: {
  id: "my-provider",
  label: "我的上游",
  description: "一句话描述这个上游模块",
}
```

字段说明：

- `id`
  - 必填
  - 只能在项目内唯一
  - 会作为配置主键、用户状态主键、面板模块标识
- `label`
  - 必填
  - 面板中显示的模块名称
- `description`
  - 选填
  - 面板说明文字

### 5.2 可选字段

```js
manifest: {
  author: "Your Team",
  website: "https://example.com",
  docsUrl: "https://example.com/docs",
  supportedTypes: ["universal", "clash", "sing-box"],
  capabilities: {
    supportsStatusQuery: true,
    supportsInviteCode: true,
  },
  settingFields: [ ... ],
}
```

字段说明：

- `author`
  - 选填
  - 模块作者/维护者
- `website`
  - 选填
  - 上游官网
- `docsUrl`
  - 选填
  - 模块自己的外部文档地址
- `supportedTypes`
  - 选填
  - 支持的下游订阅类型列表
  - 可选值：
    - `universal`
    - `clash`
    - `shadowrocket`
    - `surge`
    - `quantumultx`
    - `sing-box`
  - 不填时默认支持全部类型
  - `universal` 建议始终提供，因为主程序很多视图默认基于它工作
- `capabilities.supportsStatusQuery`
  - 选填，默认 `true`
  - `false` 表示你的模块只支持注册，不支持查剩余流量/到期时间
  - 设为 `false` 后，主程序会自动限制这个模块只能使用“兼容模式”
- `capabilities.supportsInviteCode`
  - 选填，默认 `true`
  - `false` 表示这个上游完全不支持邀请码
  - 设为 `false` 后，面板会自动禁用邀请码输入框

## 6. settingFields 规范

`settingFields` 决定“当前上游配置”页里模块私有参数的 UI 渲染。

### 6.1 字段结构

每个字段都是一个对象：

```js
{
  key: "panelBaseUrl",
  label: "面板地址",
  type: "url",
  placeholder: "https://panel.example.com",
  description: "上游面板或 API 根地址",
  required: true,
  defaultValue: "",
  min: null,
  max: null,
  step: null,
  options: [],
}
```

### 6.2 支持的类型

- `text`
- `password`
- `url`
- `number`
- `textarea`
- `checkbox`
- `select`

### 6.3 字段行为

- `key`
  - 必填
  - 作为 `config.settings[key]` 的持久化键名
- `label`
  - 选填
  - 面板显示标题
- `type`
  - 选填
  - 默认是 `text`
- `placeholder`
  - 选填
- `description`
  - 选填
  - 会显示在字段下方
- `required`
  - 选填，默认 `false`
- `defaultValue`
  - 选填
  - 若当前模块配置里没有该值，面板会用它做初始值
- `options`
  - 仅 `select` 生效
  - 格式：

```js
options: [
  { value: "cn", label: "中国区" },
  { value: "us", label: "美国区" },
]
```

- `min / max / step`
  - 仅 `number` 生效

## 7. defaultConfig 规范

`defaultConfig` 用来定义主程序首次加载该模块时的默认配置。

标准结构：

```js
defaultConfig: {
  enabled: true,
  name: "我的上游",
  remark: "",
  runtimeMode: "always_refresh",
  trafficThresholdPercent: 20,
  maxRegistrationAgeMinutes: 120,
  subscriptionUpdateIntervalMinutes: 30,
  inviteCode: "",
  settings: {
    // 这里放 settingFields 对应的默认值
  },
}
```

字段解释：

- `enabled`
  - 是否启用当前上游
- `name`
  - 面板里这个上游实例的显示名称
- `remark`
  - 面板备注
- `runtimeMode`
  - `always_refresh` 或 `smart_usage`
  - 如果模块 `supportsStatusQuery=false`，主程序会自动强制改成 `always_refresh`
- `trafficThresholdPercent`
  - 智能模式下，剩余流量低于该百分比时重新注册
- `maxRegistrationAgeMinutes`
  - 智能模式下，账号年龄超过该分钟数时重新注册
- `subscriptionUpdateIntervalMinutes`
  - 回给下游客户端的自动更新时间
- `inviteCode`
  - 模块默认邀请码
  - 如果模块 `supportsInviteCode=false`，主程序会自动清空它
- `settings`
  - 模块私有配置对象

## 8. normalizeProviderSettings() 规范

这个函数只负责规范化模块私有配置，也就是 `config.settings`。

示例：

```js
normalizeProviderSettings(settings = {}, { helpers }) {
  return {
    panelBaseUrl: helpers.normalizeString(settings.panelBaseUrl),
    registerPath: helpers.normalizeString(settings.registerPath) || "/api/register",
    apiKey: helpers.normalizeString(settings.apiKey),
    allowInsecure: helpers.normalizeBoolean(settings.allowInsecure, false),
  };
}
```

你不需要自己处理这些公共字段：

- `enabled`
- `name`
- `remark`
- `runtimeMode`
- `trafficThresholdPercent`
- `maxRegistrationAgeMinutes`
- `subscriptionUpdateIntervalMinutes`
- `inviteCode`

这些公共字段由宿主统一处理。

## 9. register(context) 规范

### 9.1 调用时机

`register()` 会在以下场景被调用：

- 手动点击“重新注册当前上游”
- 兼容模式下，客户端每次拉取订阅时
- 智能模式下，被判断为应该重注册时
- 用户首次没有任何上游记录时

### 9.2 context 结构

```js
{
  inviteCode,
  upstreamConfig,
  verbose,
  logger,
  manifest,
  helpers,
}
```

字段说明：

- `inviteCode`
  - 本次注册最终要使用的邀请码
  - 可能来自手动输入，也可能来自模块默认配置
- `upstreamConfig`
  - 已经由宿主归一化后的完整配置
- `verbose`
  - 是否建议输出更多日志
- `logger`
  - 可直接调用 `logger.log()` / `logger.error()`
- `manifest`
  - 当前模块自己的 manifest
- `helpers`
  - 宿主提供的辅助工具

### 9.3 register() 必须返回什么

推荐直接返回：

```js
return helpers.createRegistrationRecord({
  email: "...",
  password: "...",
  inviteCode,
  token: "...",
  clientUrls: {
    universal: "...",
    clash: "...",
    "sing-box": "...",
  },
  upstreamSite: "...",
  apiBase: "...",
  entryUrl: "...",
  detectorConfigUrl: "...",
  upstreamSource: "custom-module",
});
```

其中关键字段是：

- `token`
  - 后续 `query()` 查流量时通常要用到
- `clientUrls`
  - 每个下游类型对应的上游订阅地址
- `clientUrls.universal`
  - 强烈建议必须存在

可选附加字段：

- `email`
- `password`
- `inviteCode`
- `createdAt`
- `accountCreatedAt`
- `expiredAt`
- `mock`
- `upstreamSite`
- `apiBase`
- `entryUrl`
- `detectorConfigUrl`
- `upstreamSource`

## 10. query(context) 规范

### 10.1 调用时机

`query()` 会在以下场景被调用：

- 智能模式下，客户端拉取订阅前
- 智能模式下，管理页查看当前状态时

如果你的模块不支持流量查询：

```js
capabilities: {
  supportsStatusQuery: false,
}
```

然后可以不实现智能模式逻辑，宿主会自动限制。

### 10.2 context 结构

```js
{
  record,
  upstreamConfig,
  verbose,
  logger,
  manifest,
  helpers,
}
```

字段说明：

- `record`
  - 最近一次 `register()` 保存下来的注册记录
- `upstreamConfig`
  - 当前模块完整配置
- 其他字段与 `register()` 相同

### 10.3 query() 推荐返回

```js
return helpers.createUsageSnapshot({
  email: record.email,
  clientUrls: record.clientUrls,
  transferEnable: 53687091200,
  usedUpload: 123456789,
  usedDownload: 234567890,
  remainingTraffic: 50000000000,
  remainingPercent: 93.1,
  usagePercent: 6.9,
  expiredAt: "2026-12-31T00:00:00.000Z",
  accountCreatedAt: "2026-03-24T03:00:00.000Z",
  lastLoginAt: "2026-03-24T08:00:00.000Z",
  planId: 1,
  planName: "月付套餐",
  resetDay: 1,
  stat: {},
  upstreamSite: record.upstreamSite,
  apiBase: record.apiBase,
  entryUrl: record.entryUrl,
  detectorConfigUrl: record.detectorConfigUrl,
  upstreamSource: "custom-module",
});
```

宿主最关心的是这些字段：

- `remainingPercent`
- `transferEnable`
- `usedUpload`
- `usedDownload`
- `usedTotal`
- `remainingTraffic`
- `expiredAt`
- `accountCreatedAt`
- `clientUrls`

因为智能续期逻辑会基于它们做判断。

## 11. helpers 可以直接用什么

`defineUpstreamModule()` 会给 `register()` / `query()` 传入 `helpers`。

目前可用：

- `helpers.normalizeString(value)`
- `helpers.normalizeBoolean(value, fallback)`
- `helpers.normalizePositiveInteger(value, fallback, minimum)`
- `helpers.normalizePercentage(value, fallback)`
- `helpers.normalizeNumber(value, fallback)`
- `helpers.normalizeProviderSettingsBySchema(rawSettings)`
- `helpers.createRegistrationRecord(input)`
- `helpers.createUsageSnapshot(input)`
- `helpers.getDefaultConfig()`

最常用的两个：

- `createRegistrationRecord()`
- `createUsageSnapshot()`

建议直接用它们，避免自己拼字段时漏字段或字段名写错。

## 12. 推荐目录结构

一个完整模块建议长这样：

```text
src/upstreams/vendors/my-provider/
  index.js
  README.md
```

其中：

- `index.js` 是主程序真正加载的入口
- `README.md` 是给你团队自己维护的模块说明，可选

## 13. 模块校验与自测

### 13.1 扫描全部模块

```bash
npm run upstreams:check
```

输出示例：

```text
- snail-default | 主上游 | api=1 | types=universal, clash, shadowrocket, surge, quantumultx, sing-box
- my-provider | 我的上游 | api=1 | types=universal, clash
No upstream module diagnostics.
```

### 13.2 单独检查某个模块

```bash
node scripts/check-upstreams.js src/upstreams/vendors/my-provider
```

输出示例：

```text
Validated module: my-provider
Label: 我的上游
API version: 1
Supported types: universal, clash
Capabilities: query=true, inviteCode=false
```

### 13.3 面板重载验证

把模块文件放好以后：

1. 打开管理面板
2. 进入“系统”页
3. 点击“重新加载上游模块”
4. 如果加载成功，新模块会出现在上游切换器中
5. 如果失败，面板会提示有多少个模块未通过校验

## 14. 宿主统一能力边界

这些能力是宿主统一提供的，不需要模块自己实现：

- 多用户中转 token
- 固定下游订阅链接
- 上游切换
- 管理面板
- 公共配置持久化
- 用户状态与历史记录存储
- 兼容模式 / 智能模式
- 向下游强制写 `profile-update-interval`
- 返回前统一订阅体清洗

这些能力必须由模块自己实现：

- 真正的上游注册请求
- 真正的上游流量状态查询
- 上游返回数据转成宿主标准结构
- 模块私有配置字段定义与归一化

## 15. 最后建议

如果你要开发一个新模块，最稳妥的顺序是：

1. 先复制模板
2. 先把 `manifest` 和 `settingFields` 定好
3. 先写通 `register()`
4. 再写 `query()`
5. 跑 `npm run upstreams:check`
6. 放进 `src/upstreams/vendors/`
7. 在面板里重载并做一次真实注册测试

只要你的模块遵守这份文档里的导出结构和返回结构，就不需要改宿主源码。

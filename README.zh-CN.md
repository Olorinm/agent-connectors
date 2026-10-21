# Agent Connectors

给 Agent 用的 GitHub、Google Workspace、飞书和 Notion 业务连接器，以 MCP 工具提供。凭证和授权都放在 Agent 环境之外。

- **凭证不进沙箱。** 生产配置使用 AES-256-GCM 和 Google Cloud KMS 信封加密：OAuth 令牌保存在加密数据库字段中，应用配置和飞书 CLI 文件保存在加密文件包中，运行时只解密到私有内存目录。
- **服务端授权。** 每次调用都要带 Router 签发的短期调用令牌。令牌绑定一个 Agent、一个 owner 和一组连接，每个连接只有它的 owner 能用。
- **读直接执行，写要审批。** 写操作先返回 `approval_required` 和操作 ID。Router 把这个操作原样展示给 owner，owner 确认后，Router 提交一张绑定操作摘要的批准凭据，写操作才会执行。批准凭据只能用一次，几分钟后过期。模型自己加 `--yes` 之类的参数没有用。
- **窄范围预批准。** 可以为某个连接预先放行“参数取指定值”的写操作，比如只允许写入发票表。
- **结果不确定的操作不重试。** 写操作中途遇到未知错误，会记为 `uncertain`。

分工：Router 负责身份、入口和审批展示，并签发令牌；本服务保管凭证、执行授权检查、执行操作；Host 只拿到 MCP 地址和调用令牌。飞书和邮件的消息收发属于入口，留在 Router；日历、文档、邮箱读写、报销这类业务工具放在本仓库。

已有连接器：**Google 使用正式 API + 官方 Node SDK**，支持普通 Gmail 和 Workspace 账号；GitHub、Notion 使用官方远程 MCP；[飞书](docs/feishu.md)使用官方 lark-cli。对 Agent 统一提供 MCP 工具，写操作沿用已有审批。

初始化四个服务的配置入口：

```sh
npm ci
npm run build
node dist/cli.js init --out .local-four-services --owner '@alice:router.example'
node dist/cli.js serve --config .local-four-services/connectors.json
```

`init` 生成本地开发密钥和账号配置，不会自动授权，只能监听本机回环地址。生产环境配置 Google Cloud KMS 和集群短期身份，见[加密配置](docs/security-model.md#production-encryption)。GitHub、Google 的 OAuth 应用由产品方配置一次；用户随后打开授权链接。**Google 不需要填写 MCP 预览申请表**：启用所需正式 API，配置 OAuth Web 应用即可。普通 Gmail 账号用 External 受众，开发阶段添加为测试用户；公众上线按申请的权限处理 OAuth 审核。Notion 默认使用动态客户端注册。

Google 已提供 Gmail、Drive、Docs、Sheets、Slides 和 Calendar 的具体读写工具。原有 `kind: "google"` 配置可以继续用；旧预览 MCP 授权需重新连接，Agent 需刷新工具列表。

统一入口是 `connection status`、`connection connect <id>`、`connection disconnect <id>`，使用可信端的 authority key。详见[四个服务的配置、授权和凭证说明](docs/accounts.md)。

当前完成的是连接器仓库的接入代码、管理 API 和 CLI。Mau 的账号连接页面、Host 的调用令牌下发和审批展示还需接这些公开接口；不会自动修改线上部署。

详见 [安全模型](docs/security-model.md) 和 [Router 对接](docs/router-integration.md)。

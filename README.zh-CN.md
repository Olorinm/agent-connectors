# Agent Connectors

给 Agent 用的业务连接器，比如邮箱、飞书，以 MCP 工具提供。凭证和授权都放在 Agent 环境之外。

- **凭证不进沙箱。** 连接和 OAuth 凭证保存在本服务内，用 AES-256-GCM 加密存储。
- **服务端授权。** 每次调用都要带 Router 签发的短期调用令牌。令牌绑定一个 Agent、一个 owner 和一组连接，每个连接只有它的 owner 能用。
- **读直接执行，写要审批。** 写操作先返回 `approval_required` 和操作 ID。Router 把这个操作原样展示给 owner，owner 确认后，Router 提交一张绑定操作摘要的批准凭据，写操作才会执行。批准凭据只能用一次，几分钟后过期。模型自己加 `--yes` 之类的参数没有用。
- **窄范围预批准。** 可以为某个连接预先放行“参数取指定值”的写操作，比如只允许写入发票表。
- **结果不确定的操作不重试。** 写操作中途遇到未知错误，会记为 `uncertain`。

分工：Router 负责身份、入口和审批展示，并签发令牌；本服务保管凭证、执行授权检查、执行操作；Host 只拿到 MCP 地址和调用令牌。飞书和邮件的消息收发属于入口，留在 Router；日历、文档、邮箱读写、报销这类业务工具放在本仓库。

已有连接器：[飞书](docs/feishu.md)。底层调用官方 lark-cli，以 owner 身份执行；读写由 lark-cli 官方为每条命令声明的风险等级决定。

详见 [安全模型](docs/security-model.md) 和 [Router 对接](docs/router-integration.md)。

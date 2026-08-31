# 隐私说明 / Privacy Notice

更新日期：2026-08-31

本项目是本地优先、自托管的浏览器副驾，不提供官方托管账户体系，也不包含广告、分析 SDK 或行为追踪服务。

## 数据在哪里

- Chrome 本地存储：模型 API Key、工作区访问令牌、业务配置、运行模式、发送计数与本地状态。
- 自托管 Bridge 的 SQLite：工作区资料、导入的知识文档与向量、人工反馈案例、主动提供的联系方式、回复日志。
- 浏览器页面：扩展为生成草稿读取当前客服页面可见的会话内容、客户昵称和消息时间；默认不把整页内容长期保存。

## 数据会发送给谁

- 生成回复时，相关会话片段、命中的业务资料和模型 API Key 会先发送到使用者自建的 Bridge，再由 Bridge 转发给使用者选择的模型服务商。
- 使用飞书文档导入时，Bridge 会向飞书接口请求指定文档；启用飞书/企微 Webhook 后，新线索提醒和经营日报会发送到配置的群机器人。
- 除上述由使用者主动配置的服务外，项目代码不向项目维护者发送遥测、密钥、会话或线索数据。

## 保留与删除

- Chrome 数据可在扩展设置、Chrome 扩展数据清理或卸载扩展时删除。
- Bridge 数据默认位于 `server/data/xhs_reply_feedback.sqlite3`；线索可通过产品内删除/清空功能处理，完整数据可由服务器所有者删除 SQLite 文件。
- 删除或轮换模型 API Key、工作区令牌和 Webhook 后，应同时清理浏览器本地存储及服务器配置。

## 权限用途

- `storage`：保存本地配置、凭据和安全状态。
- 小红书相关站点访问权限：在适配的客服/笔记页面读取当前可见内容并插入由人工确认的草稿控件。
- `127.0.0.1` / `localhost`：连接本机自托管 Bridge。

使用者是其业务数据的控制者，应自行取得必要授权并遵守适用的隐私、劳动、消费者保护及平台规则。

---

This project is local-first and self-hosted. It contains no ads, analytics SDKs, or maintainer-operated telemetry. Model keys and configuration are stored in Chrome local storage; relevant conversation excerpts are sent to the user's local Bridge and then to the model provider selected by the user. Optional Feishu/WeCom integrations transmit only when configured. Users control retention and deletion of browser and Bridge data.

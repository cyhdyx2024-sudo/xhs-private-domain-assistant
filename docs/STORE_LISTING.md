# Chrome Web Store listing draft

## Product name

小红书私信智能副驾（XHS Copilot）

## Short description

面向专业号客服工作台的本地 AI 私信起草副驾：多轮上下文、业务知识库、人工确认与线索捕获。

## Positioning

本扩展是独立第三方浏览器起草工具，不是小红书官方产品，也不代表或获得相关平台背书。默认模式只把草稿填入输入框，由操作员检查并发送。

## Permission justification

- `storage`：保存 API Key、工作区令牌、业务资料配置和安全状态。
- 小红书站点：识别当前会话与可见消息、插入副驾控制台及草稿。
- `localhost` / `127.0.0.1`：连接使用者本机运行的开源 Bridge。

扩展不直接访问模型厂商域名；模型请求统一经本机 Bridge 转发。无广告、无遥测、无远程代码。

## Store review notes

1. Install and start the local Bridge with `python3 agent.py`.
2. Load the extension and complete setup.
3. Open the supported customer-service workbench.
4. Select a conversation; Copilot mode drafts text but does not click Send.
5. Autonomous mode is disabled by default and requires an explicit away-mode action.

Before submission, add screenshots that avoid real customer names, messages, phone numbers, account IDs and API keys.

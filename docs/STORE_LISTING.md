# Chrome Web Store submission copy

## Product name

私信智能副驾（适配小红书专业号）

## Short description

面向专业号客服工作台的本地 AI 私信起草副驾：多轮上下文、业务知识库、人工确认与线索捕获。

## Single purpose

在使用者自己的专业号客服工作台中读取当前会话上下文，生成可由人工检查、修改和发送的私信回复草稿。

## Long description

私信智能副驾是一款本地优先、可自托管的第三方客服起草工具。它在当前客服会话内工作，结合最近消息、使用者导入的业务资料和人工优秀案例生成草稿；默认只预填输入框，不替代操作员点击发送。

主要能力：

- 按稳定会话 ID 隔离多位客户，切换会话即丢弃过期结果；
- 结合多轮上下文与本地业务知识生成草稿；
- 人工修改后的优质话术可回存到自托管知识库；
- 识别客户主动提供的联系方式并辅助预填客资栏；
- 对无法核验的外部动作、过旧消息和敏感表述停止自动处理；
- 模型 Key 保存在 Chrome 本地存储，经使用者本机 Bridge 临时转发，不写入项目维护者的服务器。

使用前需在本机启动开源 Bridge。扩展无广告、无遥测，不加载或执行远程代码。

## Positioning

本扩展是独立第三方浏览器起草工具，不是小红书官方产品，也不代表或获得相关平台背书。默认模式只把草稿填入输入框，由操作员检查并发送。

## Permission justification

- `storage`：保存 API Key、工作区令牌、业务资料配置和安全状态。
- 小红书站点：识别当前会话与可见消息、插入副驾控制台及草稿。
- `localhost` / `127.0.0.1`：连接使用者本机运行的开源 Bridge。

扩展不直接访问模型厂商域名；模型请求统一经本机 Bridge 转发。无广告、无遥测、无远程代码。

## Privacy dashboard declarations

- Personal communications：是。读取当前客服会话片段，用于生成草稿。
- Personally identifiable information：可能。客户昵称，以及客户主动提供的手机号/微信号可被识别并存入使用者自托管 Bridge。
- Authentication information：是。模型 API Key 与工作区令牌保存在 Chrome 本地存储，并只发往本机 Bridge。
- Website content：是。只读取受支持客服/笔记页面中实现单一用途所需的可见内容。
- User activity：不上传。点击、键盘和滚动仅作为页面内临时安全信号，用于在人工操作时暂停值守。
- Browsing history、location、financial/health data：不收集。
- Remote code：No。所有 JavaScript 均包含在扩展包内；模型返回内容仅按文本处理，不执行。

隐私政策 URL：<https://github.com/cyhdyx2024-sudo/xhs-private-domain-assistant/blob/main/PRIVACY.md>

支持 URL：<https://github.com/cyhdyx2024-sudo/xhs-private-domain-assistant/issues>

## Graphic assets

- Store icon 128×128：`assets/store/store-icon-128.png`
- Screenshot 1280×800：`assets/store/store-screenshot-01.png`
- Small promo tile 440×280：`assets/store/store-promo-small.png`
- Marquee promo tile 1400×560（可选）：`assets/store/store-promo-marquee.png`

截图全部使用演示数据，不包含真实客户昵称、消息、联系方式、账号 ID 或 API Key。

## Store review notes

1. Install and start the local Bridge with `python3 agent.py`.
2. Load the extension and complete setup.
3. Open the supported customer-service workbench.
4. Select a conversation; Copilot mode drafts text but does not click Send.
5. Autonomous mode is disabled by default and requires an explicit away-mode action.
6. The listing and screenshots clearly identify this as an independent third-party tool and use demonstration data only.

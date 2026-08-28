# 小红书私信智能顾问

V1.0 是一个面向小红书专业号客服工作台的 Chrome 私信副驾，由浏览器扩展和可自托管的 LLM Bridge 组成。

## 功能

- 半自动生成并预填回复，默认不自动发送
- 谨慎的全自动值守、冷却时间和发送后回读
- 多轮上下文与会话隔离
- BYOK 多模型接入
- 业务知识库、人工反馈学习和线索识别
- 对“加了没、发了吗”等不可核验状态自动转人工

## 目录

- `extension/`：Chrome Manifest V3 扩展
- `server/`：Python LLM Bridge 与安全测试

## 安装扩展

1. 下载 GitHub Release 中的 `xhs-private-domain-assistant-v1.0.0.zip` 并解压。
2. Chrome 打开 `chrome://extensions/`，启用开发者模式。
3. 点击“加载已解压的扩展程序”，选择解压后的 `extension` 目录。
4. 打开扩展完成首次设置。建议先使用半自动模式检查真实会话。

## 运行 Bridge

```bash
cd server
cp .env.example .env
python3 agent.py
```

生产模式要求扩展显式传入模型 API Key、HTTPS 接口地址和模型名称。模型 Key 保存在 Chrome 本地存储中；生成回复时会经 Bridge 临时转发给模型厂商，Bridge 数据库不保存明文 Key。

## 测试

```bash
cd extension && node test_release.mjs
cd ../server && python3 -m unittest discover -v
```

## 使用边界

- 全自动必须由用户明确开启；安装或刷新不会自动打开。
- 自动化依赖小红书网页 DOM，平台改版后需要重新验证。
- 涉及外部动作状态、关键事实或模型不可用时，应交由人工处理。
- 使用前请自行确认符合平台规则、隐私要求和适用法律。

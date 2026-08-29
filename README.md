# 小红书私信智能顾问

V1.0 是一个面向小红书专业号客服工作台的 Chrome 私信副驾，由浏览器扩展和可自托管的 LLM Bridge 组成。当前补丁版本为 V1.0.1。

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

1. 下载 GitHub Release 中的 `xhs-private-domain-assistant-v1.0.1.zip` 并解压。
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
node test_safety.mjs
cd ../server && python3 -m unittest discover -v
```

## 使用边界

- 全自动必须由用户明确开启；安装或刷新不会自动打开。
- 自动化依赖小红书网页 DOM，平台改版后需要重新验证。
- 涉及外部动作状态、关键事实或模型不可用时，应交由人工处理。
- 全自动仅处理时间可确认且不超过两小时的消息，并要求在工作台显式点击“开始无人值守”。
- 使用前请自行确认符合平台规则、隐私要求和适用法律。

## 开源许可证

本项目采用 [MIT License](LICENSE) 开源。
# 小红书私信智能副驾 (XHS Copilot Pro)

面向小红书专业号客服工作台的 **AI 私信智能副驾与私域转化系统**。

---

## ✨ 核心亮点

- 🛡️ **安全第一的回复策略**：默认采用「半自动副驾」模式（只预填草稿，人工确认发送）；对“加了没、发了吗”等不可核验的外部动作状态自动熔断转人工，坚决不虚假承诺。
- 🧠 **多轮上下文与真实意图理解**：结合前序对话逻辑深度理解客户诉求，避免机械复读与模板化推销。
- 📚 **业务知识库 & RAG 检索**：支持导入业务资料（PDF、Word、Markdown、FAQ 等），基于企业真实业务事实生成专业应答。
- 🎯 **自动线索识别 (CRM)**：智能捕获客户在私信中留下的微信号、手机号，自动格式化并预填至客服工作台客资区。
- 🔄 **人工反馈自学习**：客服在工作台直接修改的话术可一键反哺给知识库，越用越懂你的业务风格。
- 🔑 **BYOK (Bring Your Own Key)**：支持 DeepSeek、OpenAI、Claude、GLM、Qwen、MiniMax、Moonshot、SiliconFlow、OpenRouter 等任意兼容 OpenAI 接口的模型；API Key 仅保存在浏览器本地，安全可控。
- 🌙 **谨慎的全自动离开值守**：支持时段限制、单会话冷却（防轰炸）、两小时消息时限过滤，以及操作员活动检测（碰触键盘鼠标即刻退出值守）。

---

## 🏗️ 系统架构

本项目由前端 Chrome 扩展与轻量级 Python LLM Bridge 组成：

```
小红书客服网页 (pro.xiaohongshu.com)
       │
       ▼
[ Chrome 扩展 (MV3) ]  ──(携带上下文 / RAG 检索 / 本地 Key)──►  [ LLM Bridge Gateway ]
       │                                                              │
       │                                                              ▼
(DOM 解析 / 智能预填 / 线索捕获)                                [ 大模型服务商 / API ]
```

- **`extension/`**：基于 Chrome Extension Manifest V3 开发的网页插件，提供沉浸式悬浮控制台与 Studio 管理后台。
- **`server/`**：可自托管的轻量级 Python 网关，处理工作区隔离、向量/关键词切片检索、人工案例自学习与回复质量质检。

---

## 🚀 快速上手

### 1. 安装 Chrome 扩展

1. 前往 [Releases 页面](https://github.com/cyhdyx2024-sudo/xhs-private-domain-assistant/releases) 下载最新的 `xhs-private-domain-assistant-v1.0.1.zip` 并解压。
2. 打开 Chrome 浏览器，访问 `chrome://extensions/` 并开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择解压出的 `extension` 文件夹。
4. 打开扩展配置面板（Studio），填写你的大模型 API Key 及店铺基础资料。

### 2. 本地运行 Bridge (可选自托管)

如需自建后端网关，可在服务器或本地启动：

```bash
cd server
cp .env.example .env
# 安装依赖并启动服务
python3 agent.py --port 18195
```

---

## 🧪 质量与测试

代码经过了严格的前端契约测试、安全风控逻辑测试与单元测试覆盖：

```bash
# 前端契约与安全规则测试
cd extension && node test_release.mjs && node test_safety.mjs

# 后端单元测试
cd ../server && python3 -m unittest discover -v
```

---

## ⚠️ 使用边界与免责声明

- 本项目为辅助提效工具，全自动模式需操作员明确在控制台开启。
- 涉及退款、客诉、外部动作状态核实（如“是否已加好友/发资料”）等敏感场景，系统会自动转交人工处理。
- 请遵守小红书平台规则、合规政策及相关法律法规。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
# 小红书私信智能副驾 (XHS Copilot Pro)

面向小红书专业号客服工作台的 **AI 私信智能副驾与私域转化系统**。
# 小红书私信智能副驾 (XHS Copilot Pro)
面向小红书专业号客服工作台的 **AI 私信智能副驾与私域转化系统**。

传统自动回复死板生硬、容易答非所问，而纯全自动 AI 又可能在关键事实和状态上胡编乱造。本项目专为真实业务场景设计：**深度结合多轮上下文、本地知识库与人工反馈机制，白天作为半自动 Copilot 辅助提效，夜间/离开时提供谨慎安全的自动化值守**。

---

## ✨ 核心亮点

- 🛡️ **安全第一的回复策略**：默认采用「半自动副驾」模式（只预填草稿，人工确认发送）；对“加了没、发了吗”等不可核验的外部动作状态自动熔断转人工，坚决不虚假承诺。
- 🧠 **多轮上下文与真实意图理解**：结合前序对话逻辑深度理解客户诉求，避免机械复读与模板化推销。
- 📚 **业务知识库 & RAG 检索**：支持导入业务资料（PDF、Word、Markdown、FAQ 等），基于企业真实业务事实生成专业应答。
- 🎯 **自动线索识别 (CRM)**：智能捕获客户在私信中留下的微信号、手机号，自动格式化并预填至客服工作台客资区。
- 🔄 **人工反馈自学习**：客服在工作台直接修改的话术可一键反哺给知识库，越用越懂你的业务风格。
- 🔑 **BYOK (Bring Your Own Key)**：支持 DeepSeek、OpenAI、Claude、GLM、Qwen、MiniMax、Moonshot、SiliconFlow、OpenRouter 等任意兼容 OpenAI 接口的模型；API Key 仅保存在浏览器本地，安全可控。
- 🌙 **谨慎的全自动离开值守**：支持时段限制、单会话冷却（防轰炸）、两小时消息时限过滤，以及操作员活动检测（碰触键盘鼠标即刻退出值守）。
# 小红书私信智能副驾 (XHS Copilot Pro)

面向小红书专业号客服工作台的 **AI 私信智能副驾与私域转化系统**。

传统自动回复死板生硬、容易答非所问，而纯全自动 AI 又可能在关键事实和状态上胡编乱造。本项目专为真实业务场景设计：**深度结合多轮上下文、本地知识库与人工反馈机制，白天作为半自动 Copilot 辅助提效，夜间/离开时提供谨慎安全的自动化值守**。

---

## ✨ 核心亮点

- 🛡️ **安全第一的回复策略**：默认采用「半自动副驾」模式（只预填草稿，人工确认发送）；对“加了没、发了吗”等不可核验的外部动作状态自动熔断转人工，坚决不虚假承诺。
- 🧠 **多轮上下文与真实意图理解**：结合前序对话逻辑深度理解客户诉求，避免机械复读与模板化推销。
- 📚 **业务知识库 & RAG 检索**：支持导入业务资料（PDF、Word、Markdown、FAQ 等），基于企业真实业务事实生成专业应答。
- 🎯 **自动线索识别 (CRM)**：智能捕获客户在私信中留下的微信号、手机号，自动格式化并预填至客服工作台客资区。
- 🔄 **人工反馈自学习**：客服在工作台直接修改的话术可一键反哺给知识库，越用越懂你的业务风格。
- 🔑 **BYOK (Bring Your Own Key)**：支持 DeepSeek、OpenAI、Claude、GLM、Qwen、MiniMax、Moonshot、SiliconFlow、OpenRouter 等任意兼容 OpenAI 接口的模型；API Key 仅保存在浏览器本地，安全可控。
- 🌙 **谨慎的全自动离开值守**：支持时段限制、单会话冷却（防轰炸）、两小时消息时限过滤，以及操作员活动检测（碰触键盘鼠标即刻退出值守）。

## 🏗️ 系统架构

本项目由前端 Chrome 扩展与轻量级 Python LLM Bridge 组成：

```
小红书客服网页 (pro.xiaohongshu.com)
       │
       ▼
[ Chrome 扩展 (MV3) ]  ──(携带上下文 / RAG 检索 / 本地 Key)──►  [ LLM Bridge Gateway ]
       │                                                              │
       │                                                              ▼
(DOM 解析 / 智能预填 / 线索捕获)                                [ 大模型服务商 / API ]
```

- **`extension/`**：基于 Chrome Extension Manifest V3 开发的网页插件，提供沉浸式悬浮控制台与 Studio 管理后台。
- **`server/`**：可自托管的轻量级 Python 网关，处理工作区隔离、向量/关键词切片检索、人工案例自学习与回复质量质检。

---

## 🚀 快速上手

### 1. 安装 Chrome 扩展

1. 前往 [Releases 页面](https://github.com/cyhdyx2024-sudo/xhs-private-domain-assistant/releases) 下载最新的 `xhs-private-domain-assistant-v1.0.1.zip` 并解压。
2. 打开 Chrome 浏览器，访问 `chrome://extensions/` 并开启右上角的 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择解压出的 `extension` 文件夹。
4. 打开扩展配置面板（Studio），填写你的大模型 API Key 及店铺基础资料。

### 2. 本地运行 Bridge (可选自托管)

如需自建后端网关，可在服务器或本地启动：

```bash
cd server
cp .env.example .env
# 安装依赖并启动服务
python3 agent.py --port 18195
```

---

## 🧪 质量与测试

代码经过了严格的前端契约测试、安全风控逻辑测试与单元测试覆盖：

```bash
# 前端契约与安全规则测试
cd extension && node test_release.mjs && node test_safety.mjs

# 后端单元测试
cd ../server && python3 -m unittest discover -v
```

---

## ⚠️ 使用边界与免责声明

- 本项目为辅助提效工具，全自动模式需操作员明确在控制台开启。
- 涉及退款、客诉、外部动作状态核实（如“是否已加好友/发资料”）等敏感场景，系统会自动转交人工处理。
- 请遵守小红书平台规则、合规政策及相关法律法规。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。

# Social CRM Copilot for Web Workbenches (Open Source AI Assistant)

[中文文档 (Chinese)](README.md) | [English Documentation](README_EN.md)

An open-source, AI-powered browser copilot designed for web customer service workbenches (specifically adapted for RED / Xiaohongshu Web IM).

> **⚖️ Legal Disclaimer & Non-Affiliation Statement**:
> 1. This project is an independent open-source productivity tool developed and maintained by individual contributors. It is **NOT an official product of RED / Xiaohongshu (XHS)**, and has no official affiliation, endorsement, sponsorship, or association with RED / Xiaohongshu (Xingyin Information Technology / Xiaohongshu Technology Co., Ltd.).
> 2. All trademarks, service marks, and company names mentioned are the property of their respective owners. Any reference to "Xiaohongshu" or "RED" is strictly for describing the objective browser environment for compatibility.
> 3. This tool is strictly intended as a **local browser drafting assistant (similar to an intelligent input method extension)** for operators. It is **strictly prohibited** to use this tool for automated bulk marketing, spamming, scraping, or any actions violating platform community guidelines and terms of service.

---

## ✨ Key Features & Design Principles

Traditional automated reply tools are often rigid and robotic, while purely autonomous AI bots risk hallucinating critical business commitments or verification statuses. This project is designed for authentic customer interactions:

- 🛡️ **Human-in-the-Loop Safety**: Defaults to **Copilot Mode** (pre-fills context-aware drafts in the input box; manual review and send required). Automatically falls back to human operators when encountering unverifiable external action checks (e.g., "Did you add my WeChat?").
- 🧠 **Multi-Turn Context & Intent Parsing**: Understands the ongoing conversation flow to avoid repetitive templates or aggressive push notifications.
- 📚 **Local Knowledge Studio (RAG)**: Upload enterprise materials (PDF, Word, Markdown, FAQ) to ground responses in verified business facts.
- 🎯 **Lead Formatting (CRM)**: Intelligently detects voluntary customer contact info (Phone, WeChat IDs) and formats them into the workbench lead panel.
- 🔄 **Continuous Learning via Feedback**: High-performing replies edited by operators can be instantly stored back into the knowledge base to adapt to your brand voice.
- 🔑 **BYOK (Bring Your Own Key)**: Direct integration with OpenAI, DeepSeek, Claude, GLM, Qwen, MiniMax, Moonshot, SiliconFlow, and OpenRouter. API Keys are stored locally in the Chrome extension storage.
- 🌙 **Safe Operator Away Mode**: Configurable cooldown timers, rate limits, 2-hour message age thresholds, and automatic disarm upon detecting operator mouse/keyboard activity.

---

## 🏗️ Architecture

```
Customer Service Webpage (Browser DOM)
       │
       ▼
[ Chrome Extension (MV3) ]  ──(Context / Knowledge Queries / Local Key)──►  [ LLM Bridge Gateway ]
       │                                                                         │
       │                                                                         ▼
(Draft Suggestion / Lead Extraction)                                      [ LLM Providers / API ]
```

- **`extension/`**: Manifest V3 Chrome Extension providing an unobtrusive floating console and full Studio dashboard.
- **`server/`**: Lightweight self-hostable Python bridge handling workspace isolation, chunk indexing, and response safety verification.

---

## 🚀 Quick Start

### 1. Install Chrome Extension

1. Download the latest `xhs-private-domain-assistant-v1.0.1.zip` from [Releases](https://github.com/cyhdyx2024-sudo/xhs-private-domain-assistant/releases).
2. Unzip the downloaded file.
3. Open Chrome and navigate to `chrome://extensions/`, enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `extension` folder.
5. Open the extension Studio dashboard to configure your API Key and business profile.

### 2. Run Self-Hosted Gateway (Optional)

```bash
cd server
cp .env.example .env
# Install dependencies and start gateway
python3 agent.py --port 18195
```

---

## 🧪 Testing & Quality Assurance

```bash
# Extension contract and safety tests
cd extension && node test_release.mjs && node test_safety.mjs

# Server unit tests
cd ../server && python3 -m unittest discover -v
```

---

## 📄 License

Distributed under the [MIT License](LICENSE).

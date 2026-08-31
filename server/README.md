# 小红书私信智能顾问 Bridge

这是 V1.1.0 的自托管 LLM Bridge。它负责工作区隔离、业务知识检索、人工反馈学习、回复安全校验和模型请求转发。

## 本地启动

```bash
cp .env.example .env
python3 agent.py
```

默认监听 `127.0.0.1:18195`，且 `XHS_PRODUCT_MODE=1` 为安全默认。正式使用前请确认 `/healthz` 返回 `product_mode: true`；远程部署还需配置允许访问的模型主机并通过反向代理提供 HTTPS。

## 工作区令牌恢复

令牌只保存哈希，无法读取原值。服务器所有者可在本机重签：

```bash
python3 agent.py --rotate-token "工作区名称或 tenant ID"
```

将输出的新令牌粘贴到扩展 Studio 的「工作区访问令牌」后重新保存。重签会立即使旧令牌失效。

## 测试

```bash
python3 -m unittest discover -v
```

不要提交 `.env`、SQLite 数据库、访问日志或真实工作区令牌。

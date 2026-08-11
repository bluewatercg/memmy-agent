
<br>
<div align="center">
  <a href="https://memmy.bot/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
      <img alt="Memmy Logo" src="docs/assets/logo-light.svg" width="50%">
    </picture>
  </a>
</div>
<br>
<br>

<div align="center">

## Memmy — 跨 Agent 记忆层，自托管部署

</div>

<div align="center">

[English](README.md) • **简体中文**

</div>

---

本仓库是 [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent) 的二次开发版本，重新定位为 **Docker 优先的自托管部署**。不使用桌面客户端和上游云服务——Memory 服务以独立容器运行，各 Agent（Pi、Codex、Claude Code、OMP、FreeBuff）通过本地 HTTP API 接入。

## 本 Fork 的改动

在上游 MemOS 记忆引擎基础上，本版本聚焦于多 Agent 上下文共享与运维治理：

- **Docker 原生 Memory 服务** — `compose.yaml` + `Memory/Dockerfile` 部署加固容器（Node 24 Debian、只读根文件系统、`cap_drop ALL`、命名卷持久化 SQLite 和模型缓存）。一条 `docker compose up -d` 即可启动记忆层。
- **OMP 与 FreeBuff Agent 源** — 为 Pi 兼容的 OMP 运行时和 FreeBuff 会话历史提供一等适配器，支持 `.agents/skills` 自动安装。
- **权威项目上下文** — 治理层允许按项目钉住权威上下文包。同一项目的所有 Agent 读取相同的权威基线，避免各自漂移。
- **来源追踪（Provenance）** — 每次 Memory 写入记录来源 Agent、适配器 id、请求 id、工作区路径、项目 id、来源 memory id，以及 Git 仓库 / 分支 / commit（可用时）。
- **项目级命名空间隔离** — 不同工作区相互隔离，同一项目内的 Agent 按设计共享上下文。
- **Memory 治理** — Markdown 审计导出/导入、稳定 supersession 关系、读模型中的来源/supersession 字段。
- **结构化会话检查点** — 可恢复的交接状态，支持 Agent 之间的任务传递。
- **上下文包历史与 Token 用量统计** — 可视化上下文如何演进，以及每次合成消耗多少预算。
- **项目级 Review 合成** — 将 Review 讨论提炼为项目级记忆。
- **SQLite Schema 迁移** — 版本化迁移（当前 v5 → v6），暴露迁移身份以便安全升级。
- **独立 Memory 控制台** — Memory 面板扩展为完整管理界面，按 tenant/project 命名空间收敛面板、检索、bundle 导入/导出、worker、API 日志等视图。

## 架构

```
┌─────────────────────────────────────────────────────┐
│                    你的工作站                         │
│                                                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │ Pi/OMP  │  │  Codex  │  │ Claude  │  ...       │
│  │  Agent  │  │  Agent  │  │  Code   │            │
│  └────┬────┘  └────┬────┘  └────┬────┘            │
│       │  skill/hook │  skill     │  skill          │
│       └─────────────┼───────────┘                  │
│                     │ HTTP :18960                   │
│              ┌──────▼──────┐                        │
│              │   Docker    │                        │
│              │   Memory    │                        │
│              │   Service   │                        │
│              │  (MemOS +   │                        │
│              │  SQLite +   │                        │
│              │  ONNX)      │                        │
│              └──────┬──────┘                        │
│                     │                               │
│              ┌──────▼──────┐                        │
│              │  Volumes    │                        │
│              │ memory-data │                        │
│              │ model-cache │                        │
│              └─────────────┘                        │
└─────────────────────────────────────────────────────┘
```

Agent 安装轻量级 skill（或 hook），将记忆读写转发到 Docker 服务。服务负责所有持久化——SQLite 存储结构化记忆，Hugging Face ONNX 模型处理本地 embedding 和摘要。

## 快速开始

### 1. 克隆并配置

```bash
git clone https://github.com/bluewatercg/memmy-agent.git && cd memmy-agent
cp .env.example .env
```

编辑 `.env`：

| 变量 | 必填 | 说明 |
|---|---|---|
| `MEMMY_MEMORY_TOKEN` | **是** | 强随机 token（≥32 随机字节）。所有客户端必须携带此 token。 |
| `MEMMY_MEMORY_HOST_PORT` | 否 | 主机端口绑定。默认 `18960`。 |
| `MEMMY_SUMMARY_PROVIDER` | 否 | 摘要模型 provider。默认 `openai_compatible`。 |
| `MEMMY_SUMMARY_ENDPOINT` | 否 | 摘要/进化模型的 OpenAI 兼容端点。 |
| `MEMMY_SUMMARY_API_KEY` | 否 | 摘要模型端点的 API key。 |
| `MEMMY_SUMMARY_MODEL` | 否 | 模型名称。默认 `auto/best-fast`。 |
| `MEMMY_EVOLUTION_*` | 否 | 同样模式，用于进化/推理模型。 |

### 2. 启动 Memory 服务

```bash
docker compose up -d
```

容器特性：
- 绑定到 `127.0.0.1:18960`（仅本机——LAN 访问需使用反向代理）
- SQLite 持久化到 `memory-data` 卷
- Hugging Face 模型缓存持久化到 `memory-model-cache` 卷
- 以只读方式挂载 `~/.pi/agent/sessions`、`~/.codex/sessions`、`~/.claude/transcripts`、`~/.config/manicode` 作为历史源
- 以非 root `node` 用户运行，只读根文件系统，drop 所有 capabilities

验证：

```bash
curl -H "Authorization: Bearer $MEMMY_MEMORY_TOKEN" http://127.0.0.1:18960/api/v1/health
```

### 3. 安装 Agent Skills

```bash
npx memmy-memory init    # 写入配置并为检测到的 Agent 安装 skill
```

或单独安装：

```bash
memmy-memory init --agent pi       # Pi/OMP hook
memmy-memory init --agent codex    # Codex skill
memmy-memory init --agent claude   # Claude Code skill
```

每个 Agent 现在通过 Docker 服务读写记忆。

### 4. （可选）CLI 访问

```bash
memmy-memory health                         # 服务健康检查
memmy-memory search "项目里的记忆策略"        # 跨所有记忆搜索
memmy-memory add "这是一条需要保存的知识"      # 写入新记忆
memmy-memory stats --workspace              # 按工作区统计
memmy-memory namespace current              # 显示当前命名空间
```

默认连接 `http://127.0.0.1:18960`。可用 `--url`、`--token`、`--config`、`--source`、`--user-id` 指定目标服务、认证、来源与用户命名空间。

## 支持的 Agent 源

| Agent | 历史导入 | 实时 Skill/Hook | 源适配器 |
|---|---|---|---|
| Pi / OMP | ✅ `~/.pi/agent/sessions` | ✅ Hook 模板 | `pi` |
| Codex | ✅ `~/.codex/sessions` | ✅ Skill | `codex` |
| Claude Code | ✅ `~/.claude/transcripts` | ✅ Skill | `claude-code` |
| FreeBuff | ✅ 会话历史 | ✅ `.agents/skills` | `freebuff` |
| Cursor | ✅ 通过上游导入 | — | 上游 |
| OpenCode | ✅ 通过上游导入 | — | 上游 |
| OpenClaw | ✅ 通过上游导入 | — | 上游 |
| Hermes Agent | ✅ 通过上游导入 | — | 上游 |

## 核心概念

- **Memory 服务** — 运行 MemOS 引擎的 Docker 容器。SQLite 支撑的结构化记忆，配合 ONNX embedding、摘要和进化模型。所有 Agent 通过其 HTTP API（`:18960`）读写。
- **项目上下文（Project Context）** — 按项目钉住的权威上下文包。通过给每个 Agent 提供相同的基线理解，防止 Agent 漂移。
- **命名空间（Namespace）** — tenant + project 作用域。不同工作区隔离，同一项目内的 Agent 共享上下文。
- **来源追踪（Provenance）** — 每次记忆写入携带其来源：源 Agent、适配器、工作区、Git 状态。你可以追溯任何记忆的来源。
- **Supersession** — 记忆版本之间的稳定关系。记忆更新时，旧版本被 supersede 而非删除——完整审计轨迹。
- **Agent 源（Agent Source）** — 从外部 Agent 的会话存储读取历史上下文的适配器，并可选安装实时 skill 以持续访问记忆。
- **上下文包（Context Pack）** — 可导出、导入和版本化的项目级知识结构化包。

## LAN / 远程访问

默认绑定 `127.0.0.1:18960`。LAN 或远程访问时，在前面放一个反向代理：

```
Caddyfile 示例：

memory.example.com {
    reverse_proxy 127.0.0.1:18960
    tls internal
}
```

切勿将 18960 端口直接暴露到网络——API 通过 bearer token 认证，但没有传输加密。

## 从源码构建

### 环境要求

- Node.js `>=22`
- npm
- Docker（用于 Memory 服务容器）

### 开发

```bash
npm install

# Memory 服务开发模式（热重载）
npm run memory:serve:dev -- \
  --host 127.0.0.1 --port 18960 \
  --db ~/.memmy/memory-service/memory.sqlite \
  --config ~/.memmy/config.yaml

# 全栈（Memory + Agent API + Gateway + 前端）
bash scripts/dev-start.sh

# 测试
npm run test

# 类型检查
npm run typecheck
```

### 仅 Docker 镜像

```bash
docker compose build    # 重新构建 Memory 镜像
docker compose up -d    # 用新镜像重启
```

## 致谢

本 Fork 基于 [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent)，而上游站在一群优秀的开源项目肩上：

- **[OpenClaw](https://github.com/openclaw/openclaw)** — 开源个人 AI 助手的先行者，它对多平台消息渠道的探索直接启发了 Memmy 的渠道连接设计。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** — Nous Research 打造的自我进化 Agent，它在持久记忆与技能自学习上的实践让我们看到 Agent 可以「越用越懂你」。
- **[nanobot](https://github.com/HKUDS/nanobot)** — 从极简原型生长为功能完备的开源 Agent 平台，它对 Agent 循环与 MCP 集成的工程实践为 Memmy 的核心设计提供了重要参考。

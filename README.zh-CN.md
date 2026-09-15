<br>
<div align="center">
  <a href="https://memmy.cn/">
    <picture>
      <img alt="Memmy Logo" src="docs/assets/banner-zh.png">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.cn/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-64716C?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://memmy.cn/"><img src="https://img.shields.io/badge/Visit-Memmy_官网-006400?labelColor=gray&style=for-the-badge&logo=safari&logoColor=white" alt="Memmy 官网"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases/latest"><img src="https://img.shields.io/badge/News-安装Memmy-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="Memmy 最新版"></a>
    <a href="docs/assets/wechat-code.png"><img src="https://img.shields.io/badge/WeCom-Memmy_社区-07C160?labelColor=gray&style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>
<p align="center">
    <a href="https://www.producthunt.com/products/memmy?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-memmy-agent" target="_blank" rel="noopener noreferrer"><img alt="Memmy Agent - Let every AI remember the same you. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1203499&theme=light&period=daily&t=1786083567983"></a>
</p>

<div align="center">

## 让你的工作在 DeepSeek Harness、Claude Code 和 Codex 等 Agent 之间接着做。

  [项目简介](#memmy-是什么) · [快速开始](#如何使用-memmy) · [技术实现](#memmy-如何实现的) · [路线图](#路线图) · [致谢](#致谢) · [贡献者](#贡献者)

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
### 4. （可选）项目上下文汇总 Skill

`memmy-project-summarize` skill 将多个 Agent 的项目上下文整合到 Memmy 记忆中：

```bash
# 复制 skill 到你的 Agent skill 目录
cp -r skills/memmy-project-summarize ~/.agents/skills/

# 或用于 Claude Code
cp -r skills/memmy-project-summarize ~/.claude/skills/
```

使用方式：

```bash
# 汇总当前项目状态
memmy-project-summarize

# 用当前工作更新项目上下文
memmy-project-summarize --update
```

该 skill 从你的工作区提取决策、经验和验证过的事实，并写入 Memmy 记忆，使项目知识在所有 Agent 间共享。

### 5. （可选）CLI 访问

```bash
memmy-memory health                         # 服务健康检查
memmy-memory search "项目里的记忆策略"        # 跨所有记忆搜索
memmy-memory add "这是一条需要保存的知识"      # 写入新记忆
memmy-memory stats --workspace              # 按工作区统计
memmy-memory namespace current              # 显示当前命名空间
```

默认连接 `http://127.0.0.1:18960`。可用 `--url`、`--token`、`--config`、`--source`、`--user-id` 指定目标服务、认证、来源与用户命名空间。

## 支持的 Agent 源

| Agent | 历史导入 | 实时 Skill/Hook | Source ID |
|---|---|---|---|
| Pi / OMP | ✅ `~/.pi/agent/sessions` | ✅ Hook 模板 | `omp` |
| Codex | ✅ `~/.codex/sessions` | ✅ Skill | `codex` |
| Claude Code | ✅ `~/.claude/transcripts` | ✅ Skill | `claude_code` |
| FreeBuff | ✅ 会话历史 | ✅ `.agents/skills` | `freebuff` |
| Cursor | ✅ `.cursor/` 项目 SQLite | — | `cursor` |
| OpenCode | ✅ State SQLite | — | `opencode` |
| OpenClaw | ✅ Conversation + memos SQLite | — | `openclaw` |
| Hermes Agent | ✅ Rollouts + state DB | — | `hermes` |
| WorkBuddy | ✅ Projects JSONL 会话 | — | `workbuddy` |


#### 4. 源码启动

```bash
git clone https://github.com/MemTensor/memmy-agent.git
cd memmy-agent
cp .env.example .env
npm install
npm run build
bash scripts/dev-start.sh
```

脚本会安装依赖、构建服务并启动开发环境。需要 Node.js `>=22` 和 npm；Windows 请使用 Git Bash。




<a id="architecture"></a>

## Memmy 如何实现的？

架构、记忆服务和接入方式的详细说明见 [Memmy 文档](https://memmy.bot/docs/)。

<p align="center">
  <img src="docs/assets/memmy-architecture-zh.png" alt="Memmy 系统架构：多个 Agent 和入口共享本地 Memory 与 Agent Runtime">
</p>
<br>

## 路线图

Memmy 做的是**个人记忆基础设施**，边界不止于 Coding Agent：

- **更多记忆来源**——从 AI 对话扩展到浏览器行为、本地文档，乃至更多终端与硬件设备。
- **团队协作**——规划中的 Agent 间协作能力，让团队成员的 AI 助手在隐私保护下共享知识。
<br>
## 致谢

本 Fork 基于 [MemTensor/memmy-agent](https://github.com/MemTensor/memmy-agent)，而上游站在一群优秀的开源项目肩上：

- **[OpenClaw](https://github.com/openclaw/openclaw)** — 开源个人 AI 助手的先行者，它对多平台消息渠道的探索直接启发了 Memmy 的渠道连接设计。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** — Nous Research 打造的自我进化 Agent，它在持久记忆与技能自学习上的实践让我们看到 Agent 可以「越用越懂你」。
- **[nanobot](https://github.com/HKUDS/nanobot)** — 从极简原型生长为功能完备的开源 Agent 平台，它对 Agent 循环与 MCP 集成的工程实践为 Memmy 的核心设计提供了重要参考。

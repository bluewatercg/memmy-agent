# DSH Agent Plugin 挂载说明(Phase 2b)

> 设计文档:docs/superpowers/plans/2026-08-15-dsh-realtime-memory-integration-design.md §8 Phase 2
> 状态:已实现,待 DSH 重启验证

## 组成

- `scripts/mcp/dsh-agent-plugin/index.mjs` — agent-plane 插件(Cordis 插件,export apply(ctx))
- `scripts/mcp/dsh-agent-plugin/package.json` — 插件包元数据
- `~/.dsh/.agent-presets/memmy-memory/agent.cordis.yml` — preset 组合(已创建)

## 插件行为

| 事件 | 行为 |
|---|---|
| `agent/created` | 打开 memmy session + claim |
| `agent/pre-step`(waterfall) | 取最后 user 消息 → turns/start → 注入 recall 到进入消息 |
| `agent/turn-stopping`(serial) | turns/complete 写回 |
| `agent/disposed` | 关闭 memmy session + 释放 claim |
| dispose | 兜底关闭所有 session |

热路径安全:所有 memmy 调用包在 try/catch,失败降级(无 recall/无写回),绝不抛给 loop。

## 挂载步骤

1. 环境变量(DSH 启动进程):
   ```sh
   export MEMMY_TOKEN=cg276686433
   export MEMMY_WORKSPACE_PATH=/mnt/d/Project/Miller/memmy-agent
   ```
2. 让 preset 生效:新建会话时在 Model 选择器里选 **memmy-memory** preset(或改 agentPresets.default)
3. 重启 DSH:preset roster 每次调用都重新读取,新会话即可见;重启使默认值生效

## 回滚

- 删除 `~/.dsh/.agent-presets/memmy-memory/` 目录即可;
- 已加入的会话保留其常驻挂载,新会话不再加载。

## 已知边界

- 插件在 DSH 进程内运行,不能单元测试;需真实 DSH 会话验证(Phase 5 smoke);
- pre-step 注入会追加一条 user/message 到 DSH 自身 transcript(设计 §3.3 已注明);
- `agent/turn-stopping` 写回时 query/answer 为占位文本,完整提取留待 Phase 4。

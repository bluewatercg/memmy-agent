# DeepSeek Harness 实时记忆接入设计(修订版 v2.2)

> 状态:交叉评审后修订(4 位评审 agent:DSH 平台/Memmy API/架构/数据完整性)
> 日期:2026-08-15
> 基于对 DSH 运行时与 Memmy 服务的实际侦察(非假设)
> v1 评审结论:needs-revision x2, revise-before-implement x2;v2 复审后补 4 项;v2.1 复审后补 3 处一致性(TTL/reaper 入 Phase 2、mid-turn finalize 入交付、验收 #9/#10)

## 0.5 v2 -> v2.1 修订(复审 4 项)

| # | v2 复审发现 | v2.1 修订 |
|---|---|---|
| C1 | claim 无写入路径(runtime_kv 无 REST 端点) | 新增 POST/GET/DELETE /api/v1/dsh/claims |
| C2 | claim 无 TTL/reaper,崩溃插件冻结 session | expiresAt + 心跳续期 + 过期回收;mid-turn 幂等补 finalize |
| C3 | packed-chunk 行共享 seq,key 歧义 | chunk 段合并导入,eventKey 用 seq0 |
| C4 | 子代理去重"跳过或反之"未锁定;Phase 4 与 2 重叠 | 锁定 spliced 跳过单一规则;Phase 4 只做 reward/演化 |

## 0. 修订记录(v1 -> v2)

| # | v1 问题 | v2 修订 |
|---|---|---|
| R1 | 跨通道幂等 key 分裂(:hist: vs :event:)导致重复 | 统一 eventKey;新增 session 认领(session claim) |
| R2 | Phase 2 误用 agent/request(不能注入消息) | 改用 agent/pre-step(waterfall) |
| R3 | 事件词汇声称 45 种(实际 44),reasoning-chunks 是存储 tag | 修正事件清单与说明 |
| R4 | 热路径(loop 内)失败/延迟未容错 | 新增热路径隔离、降级与重试策略 |
| R5 | 缺少安全考虑(~/.dsh 含敏感内容) | 新增安全与脱敏章节 |
| R6 | checkpoint 字节边界未定义(非 frame 边界续传失败) | 明确 frame 边界约束;文件变短触发全量重扫 |
| R7 | 子代理内容双重导入 | 新增谱系去重规则 |
| R8 | 回滚只停同步,不删数据 | 新增按 sourceAgent 的数据清理策略 |
| R9 | 历史导入无 token/规模预算 | 新增导入预算与摘要策略 |
| R10 | 实时与 MCP 双通道 recall 竞争 | 明确优先级:插件 > MCP(自动 > 手动) |

## 1. 背景与目标

Memmy 已具备通用记忆底座(session/turn/asset/evolution/MCP 手动工具),但缺少 DSH 专用实时接入层:
当前 MCP bridge 只能让模型主动调用搜索/写入工具,不能自动捕获 DSH 的 turn/tool 生命周期。
本设计定义 DSH 实时接入的完整方案:历史导入 + 实时生命周期 + Asset 闭环。

## 2. 侦察结论(Phase 0 实际发现)

### 2.1 DSH session 文件格式(实测)

```text
<DSH_HOME>/sessions/
  --<normalized-cwd>--/          # 项目目录(可读形式,如 --mnt-d-Project-Miller-memmy-agent--)
    <encoded-session-id>/        # 会话目录
      session.jsonl.zstd        # 默认:zstd 多 frame 拼接(header frame + 每批 append 一个 frame)
      session.jsonl             # 仅 compression=none 时
```

- 第一行是不可变 SessionHeader:{ type:'session', version, id, cwd?, createdAt, parentSession?, origin?, delegationDepth?, seedLength?, agentPreset? }
  (注:delegationDepth 磁盘上必需但顶层为 0;seedLength 存在;origin 取值 'subagent')
- 后续每行是一条 SessionEvent JSON,seq 连续(events[i].seq === i)
- packChunks 默认开启:连续 assistant/chunk / reasoning-chunks / tool-call-chunks 打包为一行(seq0/time0 + dt 序列);
  注意 reasoning-chunks / tool-call-chunks 是存储行 tag,不是 SessionEventMap 成员
- zstd 编码:标准 Zstandard frame 拼接,每个 frame 带 checksum;Node 内置 zlib.zstdDecompressSync 逐 frame 可解(实测 608 frames)
- 崩溃恢复:DSH 侧会把最后不完整 frame 截断重编码(文件可能变短);读取侧需支持"文件变短 -> 全量重扫"

### 2.2 事件词汇(44 种类型,实测)

```text
生命周期: turn/start  turn/end  step/start  step/end  session/title  session/end-seed
消息:      user/message  assistant/message  assistant/chunk
工具:      tool/call  tool/result  tool/code-dispatch(-start)  tool-workflow/agent-start|agent-end|run-start|run-end
配置/权限: permission/preset  approval/asked|decided|policy  sandbox/mode  plan/mode
系统:      agent/inbox/spliced  subagent/descriptor  agent-preset/selected  request/header  request/context
          compaction/*  hook/invoked|result  llm/retry*  schedule/change  todo/write  goal/change
          command/run|done  feedback/record  web/deepseek-search-llm-request  session/title-llm-request
```

(共 44 种;session/title-llm-request 与 web/deepseek-search-llm-request 为辅助请求记录)

关键事件实测样例(当前会话日志):

```json
[4]  turn/start {"turn":1}
[6]  step/start {"turn":1,"step":1}
[7]  user/message {"content":[{"type":"text","text":"..."}],"role":"user","id":"a46e..."}
[340] tool/call {"turn":1,"step":1,"callId":"call_00_3B8i...","name":"run_code","arguments":"..."}
[343] tool/result {"turn":1,"step":1,"message":{...}}
[344] step/end {"turn":1,"step":1}
```

### 2.3 DSH 插件能力(实测,含 v2 修正)

- DSH 基于 Cordis 插件系统,profile 可安装普通依赖插件(dsh plugin --profile web add <pkg>)
- ctx.agents 提供 Agent 注册表:register/resume/create/get/list/roots,带 agent/* 实时事件
- **实时事件(修正)**:agent/created、agent/disposed、agent/request、agent/turn-stopping、
  agent/status、agent/session-start、agent/pre-step、agent/error、agent/inbox/*
- **pre-step recall 的正确 hook 是 agent/pre-step(waterfall)**:可替换 step 的进入消息(追加为持久 user/message);
  **agent/request 是 config-only,不能注入消息**(v1 用错,已修正)
- agentCtx 是 agent 作用域上下文,可注册工具/监听器,dispose 时全部撤销
- 工具/结果捕获:实时通道用 session/event 或 turn-stopping 时读 agent.session.events
- MCP 客户端(dsh-mcp-client)已确认可挂载,但工具只能由模型主动调用,不能自动触发

## 3. 架构决策

### 3.1 双通道架构

```text
+----------------------+        +---------------------------+
| DSH 实时通道(Plugin)  |        | DSH 历史通道(Source Adapter) |
| agent/pre-step recall |        | 扫描 ~/.dsh/sessions/**     |
| agent/turn-stopping   |        | -> 解析 JSONL/zstd          |
| session/event capture |        | -> 导入 ConversationMessage |
| -> Memmy REST         |        | -> checkpoint 增量          |
+----------------------+        +---------------------------+
           |                                  |
           +---------------+------------------+
                           v
               Memmy Memory REST / 内部服务
```

- 实时通道(首选):DSH 插件监听 agent/pre-step 与 agent/turn-stopping,自动调用 Memmy API。
- 历史通道:独立 source adapter,负责已有 session 的批量导入与增量同步(可独立验证,先做)。
- MCP bridge(保留):作为手动/故障恢复通道,补齐 session/turn/asset 工具。
- **通道优先级(新增)**:实时插件为自动通道,拥有活动 session 的所有权;历史 importer 跳过被实时通道认领的 session。

### 3.2 为何 Plugin 而非纯 MCP

- 纯 MCP 只能"模型主动调用",无法满足"turn 前自动 recall、turn 后自动写回"的验收;
- DSH 的 agent/pre-step + agent/turn-stopping 提供真实生命周期钩子(已实测确认存在);
- Plugin 与 MCP bridge 可并存:Plugin 负责自动链路,MCP 负责显式调用。

### 3.3 热路径容错(新增,v2)

- agent/pre-step 与 agent/turn-stopping 在 loop 热路径中被 await:监听器抛错会失败该 step/turn;
- **必须**:监听器内部全 try/catch,Memmy 调用失败仅记录并继续(降级为无 recall),绝不抛给 loop;
- **延迟预算**:Memmy 调用设超时(如 800ms),超时返回空 recall,不阻塞 step;
- **Memmy 不可用**:插件进入降级模式(跳过 recall/写回),并记录待重试队列;恢复后补写。

## 4. DSH Session Schema(历史导入的数据模型)

```ts
interface DshSessionArtifact {
  kind: "dsh";
  sessionId: string;              // header.id
  cwd: string;                    // header.cwd
  parentSession?: string;
  origin?: "subagent";
  agentPreset?: string;
  delegationDepth: number;
  seedLength?: number;
  createdAt: number;
  path: string;                   // 绝对文件路径
  compression: "zstd" | "none";
  fileSize: number;               // checkpoint 用(frame 边界)
  mtimeMs: number;                // checkpoint 用
}

interface DshTurn {
  turn: number;
  startSeq: number;
  endSeq?: number;
  userMessages: Array<{ seq: number; text: string; id?: string }>;
  toolCalls: Array<{
    seq: number;
    step: number;
    callId: string;
    name: string;
    arguments: string;
    result?: unknown;
  }>;
  startedAt: number;
  endedAt?: number;
  complete: boolean;              // 是否有 turn/end
}
```

## 5. 事件映射表(DSH SessionEvent -> Memmy)

| DSH 事件 | Memmy 调用 | 说明 |
|---|---|---|
| session header | sessions/open(source=deepseek_harness) | 建会话;幂等用 requestId=sessionKey |
| turn/start | turns/start | 开启 turn;requestId=turnKey |
| agent/pre-step | asset-recalls + memory/search | 实时 recall 注入(waterfall) |
| step/start | (上下文标记) | 记录 step 边界 |
| user/message | 记忆候选 | 用户输入进入注入上下文 |
| tool/call | asset-recalls(如需预配) + 记录 | tool 事件捕获 |
| tool/result | asset-recalls/:id/outcome | used/ignored/failed;eventKey 为 toolEventKey |
| step/end | (turn 内统计) | |
| agent/turn-stopping | turns/complete | 完成 turn,写回记忆 |
| session/title | 会话标题元数据 | |
| subagent/descriptor | parentSession 关联 | 子代理会话谱系(去重用) |

## 6. 幂等键契约(修订 v2)

### 6.1 键派生(统一)

```text
sourceAgent    = "deepseek_harness"
sessionKey     = "deepseek_harness:" + externalSessionId      // externalSessionId = DSH header.id
turnKey        = sessionKey + ":turn:" + externalTurnId
eventKey       = sessionKey + ":event:" + <nativeId else seq>  // 统一!不再分 :hist:/:event:
toolEventKey   = sessionKey + ":tool:" + callId
recallKey      = sessionKey + ":recall:" + turnId + ":" + stepId
```

- **统一 eventKey**:历史通道与实时通道对同一逻辑事件派生相同 key(native id 优先,无 id 用 seq)。
  这是 v1 最严重缺陷(R1)的修复 —— 两通道不会产生重复记忆。
- 每个 Memmy mutation 的幂等键:
  - envelope 类(sessions/open|close、turns/start、memory/search|add):**eventKey 映射为 requestId**
    (Memmy replay key = operation:namespaceScope:adapterId:requestId;RequestEnvelope 无 eventKey 字段,
    以 requestId 承载任意事件键);
  - asset 路由(asset-recalls、outcome):**保留 eventKey 字段**(这些路由要求字面 eventKey)。
- adapterId = "agent-source:deepseek_harness"(对齐现有 agent-source 前缀)。
- **packed-chunk 行(v2.1 新增)**:assistant/chunk、reasoning-chunks、tool-call-chunks 是存储行,
  一行含多个连续 delta 且共享一个 seq0。**不逐块导入**:整段 chunk 行合并为一条记忆/一次事件,eventKey 用段首 seq
  (即 seq0),避免同 seq 多块产生 key 冲突导致数据丢失。

### 6.2 Session 认领(新增,防跨通道重复)

```text
claim = runtime_kv["dsh:claim:" + externalSessionId]
        = { channel: "realtime" | "historical", claimedAt, owner, expiresAt }
规则:
- 实时插件在 session boot 时认领(claim=realtime),优先;
- 历史 importer 扫描到已认领 session 时跳过(不再导入);
- 历史导入先于实时认领的场景:importer 完成导入后由插件接续增量(事件级幂等兜底)。
```

**写入路径(v2.1 新增)**:runtime_kv 无 REST 端点,插件(外部 REST 客户端)无法直接写 claim。
需新增:

```text
POST /api/v1/dsh/claims         # body: { sessionId, channel } ; 原子 CAS(不存在才写入 / TTL 内不覆盖)
GET  /api/v1/dsh/claims/:sessionId
DELETE /api/v1/dsh/claims/:sessionId   # 插件正常 close 时释放
```

(或插件以进程内 API 写入 —— 二选一,设计默认 REST 端点,便于独立部署验证)

**TTL 与回收(v2.1 新增)**:

```text
expiresAt = claimedAt + CLAIM_TTL(默认 24h)
- 实时插件活动时周期续期(心跳),或每次 turn 事件隐式续期;
- 扫描器(历史 importer 或独立 reaper)发现 expired claim -> 清除并接管;
- 插件崩溃遗留的 stale realtime claim 由此可回收,不会永久冻结 session;
- 崩溃 mid-turn 遗留的未完成 turn:恢复时按 turnKey 幂等补 finalize(turns/complete 可重放)。
```

**CAS 仲裁(v2.1 新增)**:claim 写入用 compare-and-set(realtime 优先):

```text
- 无 claim 或已过期 -> 写入成功;
- 已存在且未过期 -> 拒绝(返回 409),调用方按现有 channel 走;
- 不存在竞争写 -> 仅一个成功(数据库原子性保证),另一侧退回事件级幂等兜底。
```

## 7. Checkpoint 模型(修订 v2)

```ts
interface DshImportCheckpoint {
  sourcePath: string;
  frameEndOffset: number;  // 已处理字节数,必须是 zstd frame 边界
  lastFrameIndex: number;  // 已处理 frame 序号
  mtimeMs: number;
  lastSeq: number;         // 已导入最大 seq
  lastEventId: string;
  status: "complete" | "partial" | "corrupt";
  error?: string;
  updatedAt: string;
}
```

- **frame 边界约束(新增)**:checkpoint 只记录在完整 zstd frame 边界;绝不在事件行中间断点(否则续传解压失败);
- **文件变短检测(新增)**:DSH 崩溃恢复会截断重编码使文件变短;size 减小 -> 放弃旧 checkpoint,全量重扫(幂等键保证不重复);
- **同 tick 追加**:mtime + size + frame 边界三重校验,避免同毫秒追加漏读;
- **损坏记录**:单条 JSON 解析失败 -> 跳过并记 corrupt,不阻断其他 session;
- **尾部不完整 frame**:只读完整 frame;最后一个不完整 frame 跳过(不标记 corrupt),下次扫描再读
  (注:importer 只读( :ro),不能执行 DSH README 的截断修复)。

## 8. 分阶段实施计划

### Phase 1:历史导入与 Docker 读取(可独立验证)

```text
[1] compose.yaml: 增加 $HOME/.dsh:/home/node/.dsh:ro 挂载
[2] Memory 新增 DshSourceAdapter:discover -> scan -> parse -> import
[3] zstd 解码器(逐 frame,zlib.zstdDecompressSync + magic 定位)
[4] checkpoint 表(runtime_kv 复用)+ 增量重扫 + 幂等导入
[5] session 认领表(claim)与跳过逻辑
```

验收:
- 默认 ~/.dsh 和 DSH_HOME 都能发现;plain/zstd 都能读;
- 单条损坏记录不阻断其他 session;重跑不重复导入;文件追加可从 frame 边界继续;
- 文件变短触发全量重扫不产生重复;已认领 session 被跳过;
- Docker 容器可读 DSH session,但 :ro 保证不写入原文件。

### Phase 2:实时 DSH Plugin / Adapter

```text
[1] DSH 插件:监听 agent/pre-step(recall)与 agent/turn-stopping(写回)+ session/event(工具捕获)
[2] session boot -> sessions/open + claim(realtime) + 心跳续期(每 turn 隐式续期)
[3] agent/pre-step -> asset-recalls + memory/search,注入进入消息(waterfall)
[4] tool 事件 -> asset-recalls/:id/outcome
[5] agent/turn-stopping -> turns/complete
[6] session close -> sessions/close + 释放 claim
[7] 崩溃恢复:插件重启时检测 stale claim(过期)接管;遗留未完成 turn 按 turnKey 幂等补 finalize
```

- 热路径容错:监听器全 try/catch + 超时 + 降级(见 3.3);
- 若 agent/pre-step 不可用或注入受限,退化为 MCP adapter + 启动 wrapper,标记为降级模式。

### Phase 3:Bridge 完善(兼容/故障恢复通道)

```text
新增工具: memmy_session_open / memmy_turn_start / memmy_turn_complete /
          memmy_session_close / memmy_asset_recall / memmy_asset_outcome
统一身份: sourceAgent / externalSessionId / externalTurnId / externalEventId /
          requestId / adapterId / eventKey(eventKey -> requestId 映射)
进程退出: SIGINT / SIGTERM / beforeExit -> 尝试关闭 session;失败入 retry queue;
新增 MCP 行为测试(tools/list、tools/call、错误路径、session close)。
```

### Phase 4:Asset 闭环(范围界定 v2.1)

> 本阶段**只做 Phase 2 未覆盖的新增部分**:reward 与演化激活。recall/outcome 链路已在 Phase 2 交付,不重述。

```text
episode 完成  -> asset-rewards/episodes/:id -> 跨任务演化
              -> 资产 validation 统计更新
              -> 生命周期晋升(active/deprecated)按现有 Asset 规则
```

- Asset 工具携带:agentId=deepseek_harness / namespace / eventKey / episodeId / taskId / projectId / taskType / signals;
- 注意:asset-rewards 路由 body 仅接受 targetTaskReward(实测),eventKey/signals 需经 requestId 或元数据扩展;
- **recall/outcome 部分由 Phase 2 的 agent/pre-step + agent/turn-stopping 交付**,Phase 4 仅补充 reward/演化,避免重复实现。

### Phase 5:测试与 Smoke

单元/契约:session discovery / plain+zstd parser / malformed recovery / checkpoint resume /
frame 边界续传 / 文件变短重扫 / idempotent replay / 跨通道去重 / session claim /
MCP tools+call / signal close / asset outcome / namespace isolation / 热路径降级。

端到端 Smoke:
```text
1. 启动 Memmy;2. 启动 DSH;3. 创建测试记忆;4. 启动 DSH session;
5. 执行一次 turn;6. 确认 DSH 自动收到 Memmy recall(agent/pre-step);
7. 执行 tool call;8. 完成 turn;9. 关闭 DSH;10. 重新 search 确认 turn 和记忆可检索;
11. 确认 Asset outcome 已记录;12. 历史 importer 重扫已认领 session 不重复导入。
```

## 9. 验收标准(非 Memory 测试)

```text
1. 真实 DSH turn 前能自动收到 Memmy recall(经 agent/pre-step,非手动);
2. 真实 DSH turn 后能自动写回 Memmy(经 agent/turn-stopping);
3. 重启或重复扫描不产生重复记忆(统一 eventKey + session claim);
4. 历史 session 可批量导入且增量同步(frame 边界续传);
5. Docker 内 Memmy 能读宿主机 DSH session(:ro);
6. Asset recall/outcome 在真实 DSH 链路上闭合;
7. Memmy 不可用时插件降级不阻塞 DSH turn,恢复后补写(新增);
8. 历史导入有 token/规模预算,不无限膨胀(新增);
9. 插件崩溃后:过期 claim 可被回收,遗留未完成 turn 按 turnKey 幂等补 finalize,不产生重复(新增 v2.2);
10. 心跳续期:活动 session 的 claim 不因 TTL 误回收;静默 session 的 claim 按 TTL 过期释放(新增 v2.2)。
```

## 10. 安全与隐私(新增 v2)

- ~/.dsh session 包含提示词、文件路径、工具参数(可能含密钥/敏感内容);
- **脱敏**:导入前对 user/message 与 tool/result 做敏感项掩码(API key、token、路径中的凭据);
- **挂载范围**:Docker 挂载 ~/.dsh 为 :ro;若担心敏感面,可只挂载 ~/.dsh/sessions(不含凭据存储);
- **权限**:Memmy 侧数据标记 source=deepseek_harness,查询侧可按 source 过滤;不越权暴露。

## 11. 回滚与数据清理(修订 v2)

```text
停用: 移除插件条目 + 恢复 compose.yaml(停止同步);
清理: 删除 runtime_kv 中的 dsh:claim:* 与 dsh:checkpoint:* 停止同步;
数据: 已导入记忆/资产按 sourceAgent=deepseek_harness 删除(软删除),
      或保留并标记来源供审计;asset 演化奖励按 provenance 回滚策略单独处置。
```

## 12. 风险与取舍(修订 v2)

- agent/pre-step 热路径:监听器抛错/延迟会阻塞 step -> 全 try/catch + 超时 + 降级(已设计);
- zstd 多 frame 解析:逐 frame 可行;超大 session 性能需评估,可加 frame 缓存;
- session id 转义:需转义为安全路径段,导入保留原始 id 供幂等;
- 子代理去重(v2.1 锁定单一规则):子会话(origin=subagent)独立导入并标记 subagent-scoped;
  **父日志的 agent/inbox/spliced 摘要一律跳过**(不导入),避免与子会话完整日志双计数;
  此规则对实时插件与历史 importer 都强制一致(单一模式,无"或反之"分支);
- 历史导入规模:全量历史可能很大 -> 按 session 预算(如每 session 上限 token)、摘要导入旧内容;
- 写入权限:Docker :ro,实时通道经 Memmy REST 写入,不直接写 DSH 文件;
- 双通道竞争:session claim + 统一 eventKey 兜底(已设计)。

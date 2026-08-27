# teamEvolver DreamCycle vs Memmy Inactive Memory Lifecycle 调研

- 日期：2026-08-25
- 调研对象：https://github.com/leoriczhang/teamEvolver （MIT，Python/FastAPI）
  - 本地源码快照：`.tmp/teamEvolver/`
- 关联：同日完成的 True Replay 移植可行性分析（对话记录）；本文聚焦 Memory 维护侧。

## 1. 一句话结论

DreamCycle 是**主动的记忆减熵循环**（定期合并、归档、去重、可发现性检查，且每次变更可回放验证）；Memmy 现有的 inactive lifecycle 只是**读侧过滤器**。两者互补：建议把 DreamCycle 的"语义去重三档判定 + 变更账本 + 批量上限 + 写前查重策略"移植为 Memmy evolution 的一个新 maintenance pipeline。

## 2. DreamCycle 机制拆解

### 2.1 Job 调度（`dreamcycle/scheduler.py`, `jobs/`）

| Job | 优先级 | 职责 |
|---|---|---|
| deduplication | 20 | 合并语义重复记忆 |
| cleanup | 30 | 归档过时/被取代内容 |
| onboarding_check | 40 | 模拟新人搜索，验证可发现性 |
| consolidation | 50（机会性） | 跨成员共性提炼（≥2 人独立出现才沉淀） |

每个 job 是一个 ReAct agent 循环，系统提示词里硬编码维护策略。

### 2.2 语义去重（`dreamcycle/semantic.py`）

`SemanticMatcher` 用 embedding 余弦相似度做**三档判定**：

```
cosine >= 0.86 → merge    （真重复，合并）
cosine >= 0.72 → warn     （相关，放行但暴露出来）
otherwise      → distinct （真新增）
embedding 不可用 → unknown （交给 LLM 判断，绝不静默降级到词面重叠）
```

关键设计：**缺失 embedding 后端时返回 `unknown` 让 LLM 兜底，而不是退化为词法比较**——避免"看起来不像就放过"的假阴性。向量按 sha1(text) 缓存。

### 2.3 变更账本（`dreamcycle/memory_changes.py`）

`MemoryChangeLedger` 为每次 mutation 记录：
- `before_oid / after_oid`（存储层 snapshot commit）+ blob sha256
- `diff_hash`（before→after diff 文本的哈希）+ `change_type`
- `source_refs`（来源引用哈希化，团队空间引用保留 URI，外部来源只存 hash 保护隐私）
- outcome 支持 `applied / partial / noop / failed`，`noop` 时 after=before
- 账本本身不可变（create_if_absent），持久化失败不影响 mutation 结果（`ledger_status=failed` 但操作已生效）

### 2.4 Memory Replay（`dreamcycle/memory_replay.py`）

清理/合并决策本身要过验证：把 **before/after 两版记忆内容作为唯一分支差异**跑双分支回放（复用 True Replay 的 checklist + 效率比较），确认维护操作没有降低检索质量后才算完成。支持 adhoc 模式（未保存的草稿 vs 存储版本直接 A/B）。

### 2.5 维护策略常量（`dreamcycle/policy.py` + 各 job 提示词）

- **写前查重**："先搜索/浏览同主题；已有可更新文档必须用 target_uri 改原文，不新增并行版本"
- **新增门禁**：新建文档必须填 `allow_create_reason`
- **批量上限防过度清理**：cleanup 每轮 ≤8 条；consolidation 每轮 ≤1 条，"没有足够高价值的共性宁可不写"
- **归档白名单**：唯一组织结构信息、长期有效 SOP、人员信息不归档
- **临时产物不入库**：检查报告、诊断过程走 report 通道，不进长期记忆
- **维护痕迹不可见**：标题/正文/元数据不得出现维护项目名或维护 agent 名

## 3. Memmy 现状

### 3.1 已有

- `evolution-memory-lifecycle.ts`：22 行的 `isInactiveEvolutionMemory()` 谓词——status 为 archived/deleted，或 L2 policy / Skill 元数据 status=archived 即视为不活跃。
- 该谓词被 6 个进化管线（span/reward/policy-induction/skill/world-model/negative-experience）在**读取侧**统一引用：不活跃记忆不参与归纳、不被选为进化目标。
- `repos.runtime.appendChange()` 已有变更审计日志（changeType/op/entityId/before-after）。
- 写入幂等：idempotency key 防重复写入（见 409 冲突修复）。
- L1→L2→L3/Skill 的晋升链路自带冷却与证据门槛。

### 3.2 缺口

1. **没有主动维护循环**：archived 之后没有任何机制回头合并/清理活跃记忆；L1 层随导入无限增长。
2. **没有语义级去重**：现有去重全靠确定性 id/hash（dedupKey、requestId），对"同一件事换措辞写两次"无能为力。
3. **归档决策不可验证**：policy/skill 归档后没有"确认归档没伤害检索质量"的回路。
4. **appendChange 无 diff 哈希与快照引用**：审计能看懂发生了什么，但不能精确重建 before/after 内容做回放。

## 4. 可借鉴策略（按优先级）

### P0 — 语义去重三档判定（移植成本最低，收益最大）

在 Memory 中新增 `SemanticDedupService`：
- 复用现有 embedding 能力（`Xenova/all-MiniLM-L6-v2` 已在依赖里）实现 merge(≥0.86)/warn(≥0.72)/distinct 三档；
- embedding 不可用时返回 `unknown` 并交由 summary LLM 兜底判定，**禁止词面兜底**；
- 落点 A：`ingestion-service` 写入前对同 namespace 同 layer 做近邻检索，warn 以上进人工/LLM 审核队列而非直接写；
- 落点 B：作为新 maintenance job 定期扫描存量。

### P1 — Maintenance Pipeline（挂进现有 evolution-job-processor）

仿照 DreamCycle 四类 job 建 Memmy 版：
- `memory.dedup`：用 P0 判定找重复组 → 合并为权威版本 + 归档其余（replaces 字段记录被合并者）；
- `memory.cleanup`：归档超时/被取代条目，**每轮批量上限**（建议 8）+ 归档白名单（唯一事实来源、长期 SOP 不动）;
- `memory.discoverability`：模拟典型检索 query 验证关键主题可召回（对应 onboarding_check；Memmy 场景即"agent 开工所需上下文能否被 intent 检索命中"）。
- 全部通过 `evolution-job-processor` 现有调度与日志通道运行。

### P2 — 变更账本增强（改造 appendChange）

给 lifecycle 相关 change 记录补充：
- `beforeHash/afterHash`（内容哈希）与 `diffHash`；
- `replaces[]`（合并/归档的被取代 id 列表），使"合并后归档"成为一等公民；
- `noop` 语义：维护 job 判定无需变更时也记账，便于统计命中率。

### P3 — Lifecycle 决策回放验证（依赖 True Replay Phase 1-2）

对高风险维护动作（合并、批量归档）用 before/after 内容做 A/B 检索质量验证：同一组查询分别在两版记忆上执行，checklist = 关键事实可召回。可先做轻量版（纯检索对比，不起 agent 分支），后续接入 True Replay 移植的决策协议。

### 明确不照搬

- ReAct agent 维护员形态：DreamCycle 用 LLM agent + 工具循环执行维护；Memmy 的管线是确定性代码 + 受控 LLM 调用，保持这个风格更符合现有架构，策略提示词可以吸收但其工程形态不搬。
- 多成员个人/团队空间隔离与去个人化约束：Memmy 单用户本地优先，暂无此需求。
- OpenViking snapshot 体系：用 SQLite 内的版本字段 + appendChange 哈希即可达成同等能力。

## 5. 风险与开放问题

1. **误合并风险**：0.86 阈值来自团队记忆场景，Memmy 的 L1 会话记忆粒度不同，阈值需要实测校准；merge 档初期建议只入审核队列不自动合并。
2. **embedding 成本**：全量存量扫描需分批 + 向量缓存（它按 sha1 缓存的做法直接抄）。
3. **归档与检索层的联动**：Memmy 最近刚做过"L1 排除出 turn-start/intent 检索"，maintenance 归档需同步考虑各检索层可见性，避免出现"归档了但还能召回"的中间态。

## 6. 参考源码索引

| 主题 | 路径（相对 `.tmp/teamEvolver/teamEvolver/`） |
|---|---|
| 语义三档判定 | `dreamcycle/semantic.py` |
| 变更账本 | `dreamcycle/memory_changes.py` |
| 去重/清理/整合/新人检查 job | `dreamcycle/jobs/{dedup,cleanup,consolidate,onboarding}.py` |
| 维护策略提示词 | `dreamcycle/policy.py` |
| Memory 回放验证 | `dreamcycle/memory_replay.py` |
| 调度器 | `dreamcycle/scheduler.py` |

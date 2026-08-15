# Agent Memory Assets & Cross-Task Evolution 详细设计

## 1. 文档定位

本文定义 Memmy 后续阶段的 Agent 记忆资产化与跨任务能力演化设计。

本阶段不修改当前正在开发的以下能力：

- Context Pack / Plan Groups：Goal、Plan、Work Item、Observed Group、Compiled Truth、Evidence Timeline。
- Topic Multi-Agent Decision：Decision Session、Evidence Snapshot、Agent Position、Debate Round、Action Proposal、Execution Run。
- 现有 L1/L2/L3 Memory、Episode、Reward Pipeline、Policy Induction、Skill Pipeline 的基本语义。

本文的目标是规定后续能力如何复用上述对象，而不是重新定义项目意图、任务状态或 Topic 决策流程。

## 2. 背景与问题

当前 Memmy 已能保存 Memory、Episode、Trace、Feedback、Reward 和 Skill candidate，但“记忆记录”和“可被 Agent 使用的能力资产”仍没有完全分离：

- 一条 Memory 缺少明确的资产类型、版本、Owner、可见性和验证历史。
- Skill candidate 生成后，来源、适用边界、实际使用效果和版本晋升关系不够统一。
- 多个 Agent 可以共享 namespace，但缺少显式的 Agent Loadout，无法控制某个 Agent 实际允许使用哪些资产。
- 后续任务的成功只能作为 Episode reward，不能可靠证明前序 Skill 或记忆资产产生了迁移价值。
- Topic 相似度可以发现候选关联，但不能作为跨任务 credit assignment 的充分依据。
- 项目推进后，旧 Memory 可能仍然语义相关，但其事实、阶段或依赖条件已不再适用于当前任务；现有 `createdAt` / `updatedAt` 不能表达内容有效性。

SkillRise 提供“任务序列 + 后续任务验证前序技能”的跨任务演化思想。TencentDB Agent Memory 提供“分层记忆 + 资产生命周期 + Agent 装配 + 按需使用”的工程模型。本设计吸收二者的边界，不引入完整 RL trainer 或替换 Memmy 现有存储模型。

## 3. 设计目标

### 3.1 目标

1. 将可复用经验建模为受治理的 Memory Asset。
2. 为 Skill 建立 candidate、review、active、deprecated、rejected 生命周期。
3. 通过 Agent Loadout 控制 Agent 可使用的资产和版本。
4. 记录每次资产召回、绑定和实际使用结果。
5. 支持显式 Experience Sequence，并把后续任务结果作为 Transfer Evidence。
6. 在不破坏现有 Reward Pipeline 的前提下增加 transfer reward 和 risk penalty。
7. 保留完整来源、版本、权限和 reward provenance，支持审计和回滚。
8. 允许后续接入 Wiki Asset 和 CodeGraph Asset，但不要求第一阶段实现它们。
9. 将存储生命周期与内容时效性分离，维护当前结论、待复核结论和历史证据三个视图。
10. 在召回前执行作用域、有效期、失效信号和 supersession 资格过滤，避免“过去正确”被当作“现在适用”。

### 3.2 非目标

本阶段不做：

- 替换 SQLite 或现有 Memory 表。
- 重写 L1/L2/L3 分层语义。
- 把所有 Memory 自动转换成 Skill。
- 仅凭 embedding 相似度自动建立任务序列。
- 构建完整在线 RL 训练器、模型参数更新或独立训练集群。
- 实现完整 Wiki 内容管理系统。
- 实现完整代码索引、AST 图谱或代码搜索服务。
- 在没有验证证据时自动将 Skill 晋升为 active。
- 改变 Topic Inbox 的 ingest、match、candidate decision、merge、split 语义。
- 给所有 Memory 设置统一 TTL，或仅凭年龄自动删除、归档、降级事实与决策。
- 改变 Topic Multi-Agent Decision 的最多三轮辩论、证据冻结和审批规则。

## 4. 核心概念与权威边界

### 4.1 Episode

Episode 是一次任务执行及其 Trace、Feedback、Reward 的运行证据。Episode 仍由现有 runtime/reward 模型负责，不被 Asset 取代。

### 4.2 Experience Sequence

Experience Sequence 描述多个 Episode 之间的显式跨任务学习关系：任务先后顺序、任务身份和 Episode 在序列中的角色。

它是 reward credit assignment 的依据，不是项目计划，也不是 Topic 分组。

```ts
interface ExperienceSequenceRef {
  sequenceId: string;
  position: number;
  taskId?: string;
  planId?: string;
  workItemId?: string;
  topicId?: string;
  role: "solve" | "curate" | "verify";
}
```

约束：

- `sequenceId + position` 在一个 namespace 内唯一。
- `position` 必须是非负整数。
- 一个 Episode 最多属于一个 Experience Sequence。
- `role=curate` 表示从前序经验整理资产，不代表资产已经生效。
- `role=verify` 表示使用或评估前序资产，不代表任务一定成功。
- `planId`、`workItemId` 只引用现有计划对象，不改变其状态和所有权。
- `topicId` 只表示来源或上下文关联，不能单独授权 reward 回传。

### 4.3 Memory Asset

Memory Asset 是可被 Agent 绑定、召回、使用和验证的复用单元。它可以由一个或多个 Memory、Episode 或 Trace 产生。

```ts
interface MemoryAssetRecord {
  id: string;
  namespaceId: string;
  assetType: "chat_memory" | "skill" | "wiki" | "code_graph";
  stableKey: string;
  version: number;
  status: "candidate" | "reviewing" | "active" | "deprecated" | "rejected";
  title: string;
  summary: string;
  contentRef: string;
  ownerId: string;
  visibility: "private" | "team" | "restricted" | "agent";
  allowedAgentIds: string[];
  sourceMemoryIds: string[];
  sourceEpisodeIds: string[];
  sourceTraceIds: string[];
  sourceTopicIds: string[];
  applicability: AssetApplicability;
  validation: AssetValidationStats;
  provenance: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface AssetApplicability {
  scope: "work_item" | "plan" | "project" | "namespace" | "global";
  taskTypes: string[];
  projectIds: string[];
  planIds: string[];
  workItemIds: string[];
  requiredSignals: string[];
  excludedSignals: string[];
  invocationHints: string[];
  validFrom?: string;
  validUntil?: string;
  retireWhen: "work_item_completed" | "plan_completed" | "project_completed" | "explicit" | "never";
}

interface AssetValidationStats {
  attempts: number;
  successes: number;
  failures: number;
  unknowns: number;
  transferRewardSum: number;
  riskPenaltySum: number;
  lastUsedAt?: string;
  lastValidatedAt?: string;
}
```

Asset 是 read model 和治理边界。现有 MemoryRow、Skill memory 和 Episode 仍然是证据源；第一阶段可以通过关联表或投影建立 Asset，而不要求立即迁移物理存储。

### 4.4 Memory 时效性

`MemoryStatus` 继续表示存储生命周期；内容是否仍适用于当前项目由独立的时效投影表达。第一阶段不要求修改 `MemoryRow` 物理结构，可以通过关联表或 read model 保存：

```ts
type MemoryFreshness =
  | "current"
  | "review_due"
  | "stale"
  | "superseded"
  | "historical";

interface MemoryTemporalValidity {
  memoryId: string;
  observedAt: string;
  effectiveFrom?: string;
  effectiveUntil?: string;
  reviewAfter?: string;
  freshness: MemoryFreshness;
  invalidationKeys: string[];
  invalidatedAt?: string;
  invalidationReason?: string;
  supersededByMemoryId?: string;
  lastReviewedAt?: string;
  version: number;
}
```

时间字段语义：

- `createdAt`：记录写入 Memmy 的时间，不证明内容当时或现在有效。
- `updatedAt`：存储记录最后变更时间；embedding、reward 或维护更新不得刷新事实有效期。
- `observedAt`：证据对应的项目状态被观察到的时间。
- `effectiveFrom/effectiveUntil`：已知的内容有效区间。
- `reviewAfter`：到期后需要复核，不表示内容已被证明错误。
- `lastReviewedAt`：最近一次基于权威来源完成复核的时间。

`freshness` 是证据和项目状态的派生结果：

- `current`：可作为当前结论参与召回。
- `review_due`：尚未证明失效，但已到复核点；不得自动 bootstrap，高风险动作不得直接采用。
- `stale`：依赖、作用域或权威来源发生变化；只作为历史候选，重新验证前不得指导执行。
- `superseded`：已有明确的新 Memory 替代；必须指向替代记录并退出当前视图。
- `historical`：仍是真实历史，但所属 Work Item、Plan、Goal 或 Project 阶段已结束。

系统必须维护三个逻辑视图：

```text
Current Truth       = activated + current + scope/effective interval matched
Review Queue        = review_due or invalidation signal pending verification
Historical Evidence = stale, superseded or historical records retained for audit
```

不同 Memory 类型使用不同策略：

| 类型 | 时效规则 |
|---|---|
| Episode / Trace / 工具结果 | 永久保留为历史证据；普通召回可衰减，但精确错误、组件或审计查询仍可命中 |
| Goal / Plan / Work Item 状态 | 状态或阶段变化后立即退出 Current Truth，不做平滑时间衰减 |
| 决策与约束 | 不因年龄自动衰减，只由显式 supersession、复核或权威来源变化改变 freshness |
| 环境事实、外部 API、依赖版本 | 使用 `reviewAfter` 和 `invalidationKeys`；到期进入 Review Queue |
| L2 Policy / L3 World Model | 由新证据、矛盾和复核结果驱动；单纯未使用不判 stale |
| Skill | 由 applicability、固定版本、阶段退役和验证结果决定，不按年龄自动弃用 |

失效信号优先采用事件驱动：Work Item/Plan/Goal 完成、Project 归档、受跟踪文件或内容哈希变化、依赖/API/schema 版本变化、显式 supersession、新证据冲突、持续执行失败和人工复核。`reviewAfter` 只负责把记录送入 Review Queue；单纯时间流逝不能自动证明 Memory 错误。

### 4.5 Skill Asset

Skill 是一种特殊的 Memory Asset，必须包含可执行的结构化内容：

- `invocationGuide`
- `procedureJson`
- `applicability`
- `acceptanceRules`
- `rollbackRules`
- `sourcePolicyIds`
- `evidenceAnchorIds`
- `support`、`gain`、`eta`
- trial 和 reward 统计

Skill 的内容版本不可变。更新必须生成新版本，旧版本保留审计记录；active 版本切换通过原子指针或版本状态变更完成。

### 4.6 Agent Loadout

Agent Loadout 是 Agent 使用资产的显式装配清单。

```ts
interface AgentLoadoutEntry {
  id: string;
  namespaceId: string;
  agentId: string;
  assetId: string;
  assetVersion: number;
  mode: "bootstrap" | "recall" | "tool";
  priority: number;
  enabled: boolean;
  projectId?: string;
  planId?: string;
  workItemId?: string;
  taskTypes: string[];
  createdAt: string;
  updatedAt: string;
}
```

Loadout 约束：

- Agent 只能使用本 namespace 内且通过可见性检查的资产。
- `assetVersion` 固定后，资产新版本不会静默替换当前 Agent 的版本。
- deprecated 或 rejected 资产不能新建绑定；既有 deprecated 绑定只允许审计读取或显式迁移。
- `bootstrap` 用于有限的 L2/L3 上下文恢复；`recall` 用于任务内检索；`tool` 用于 Wiki/CodeGraph 等按需展开。
- Loadout 不是项目计划，不得覆盖 Goal、Plan、Work Item 的声明字段。

Loadout 是否可用是运行时派生结果，不是新的资产生命周期状态：

```text
available = asset.status == active
         && loadout.enabled
         && applicability scope matches execution context
         && validFrom/validUntil matches current time
         && retireWhen condition has not occurred
```

`active + unavailable` 表示资产仍可信但当前任务不适用。它不得进入 bootstrap 或普通 recall，但仍可通过审计查询读取。

## 5. 资产生命周期

### 5.1 通用生命周期

```text
candidate -> reviewing -> active -> deprecated
    |           |
    +-----------+-----> rejected

deprecated -> active 仅允许显式恢复并重新验证
```

允许的转换：

| 当前状态 | 允许转换 | 触发条件 |
|---|---|---|
| candidate | reviewing | 进入结构和来源审核 |
| candidate | rejected | 来源不足、验证失败或违反策略 |
| reviewing | active | 审核通过且满足最低验证要求 |
| reviewing | rejected | 审核拒绝 |
| active | deprecated | 新版本替代、长期失败、内容过时 |
| deprecated | active | 显式恢复并产生新的重新验证事件 |

`active -> rejected` 不允许直接发生；需要先 deprecated，保留为何不能继续使用的记录。`rejected` 是审核终态，不能恢复或绑定。

### 5.2 阶段性退役与作用域晋升

Skill 初次生成时必须采用证据支持的最窄作用域。模型不得仅因内容看起来通用而直接创建 namespace 或 global Skill。

当 `retireWhen` 对应的 Work Item、Plan 或 Project 完成时，系统必须：

1. 禁用匹配范围内的 Loadout binding。
2. 停止该绑定进入 bootstrap 和普通 recall。
3. 追加 retirement audit event，不修改原始使用与验证证据。
4. 保持 Asset 为 active，除非内容本身已错误、过时或被新版本替代。
5. 允许未来在新的匹配范围内创建绑定，但必须重新检查 applicability；跨项目使用必须重新验证。

长期未使用不构成失败、风险惩罚或 deprecated 条件。低使用率只影响召回排序和维护提示；资产是否 deprecated 取决于内容失效、持续失败、新版本替代或显式治理决定。

作用域只能根据实际复用证据逐级晋升：

```text
work_item -> plan -> project -> namespace -> global
```

- Work Item 到 Plan：在同一 Plan 的不同 Work Item 中成功使用。
- Plan 到 Project：在同一 Project 的不同 Plan 中成功使用。
- Project 到 Namespace：在不同 Project 中成功使用，且不存在项目私有依赖。
- Namespace 到 Global：通过多环境验证、权限与风险复审，并由人工或显式授权策略批准。

晋升创建新版本并保留旧作用域版本；不得原地扩大 applicability。

### 5.3 Skill 晋升为 active 的要求

Skill candidate 进入 active 至少需要：

1. 来源 Episode、Trace 或 Policy 可追溯。
2. 结构化 procedure 能通过 schema 校验。
3. 适用范围和排除范围不为空，或明确标记为通用技能并通过更严格审核。
4. 没有未处理的高风险冲突。
5. 至少一次验证 trial，且结果不低于配置阈值。
6. 若涉及外部写操作，必须存在 acceptance 和 rollback 规则。
7. 通过人工或明确授权的自动审批策略。

## 6. 端到端数据流

```text
Episode closed
  -> RewardPipeline records task reward
  -> eligible evidence is selected
  -> SkillPipeline / policy induction creates candidate Asset
  -> source and applicability are stored
  -> review or validation trial
  -> Asset version becomes active
  -> Agent Loadout binds fixed version
  -> next Episode loads or recalls asset
  -> RecallEvent records usage
  -> next reward resolves validation outcome
  -> asset validation stats and lifecycle may update
```

### 6.1 资产候选生成

候选生成复用现有 `SkillPipeline` 和 `PolicyInduction`：

- 现有 eligibility、support、gain、eta、counter-example 逻辑继续有效。
- 新增 Asset metadata 和 provenance，不把现有 `info` / `internal` 字段作为长期唯一契约。
- candidate 生成失败仍按现有 evolution logging 记录，不创建空资产。
- 一个 Episode 可以产生多个候选资产，但每个候选必须有独立 stableKey 和来源集合。

### 6.2 召回、时效资格与使用

召回流程：

1. 校验 principal、namespace、agent、project 和 task type。
2. 读取启用的 Loadout entries 和候选 Memory。
3. 过滤存储状态、版本、可见性、applicability 和 supersession。
4. 根据当前 Goal、Plan、Work Item、时间区间和 `invalidationKeys` 派生 freshness。
5. `current` 才能进入自动 bootstrap 和普通 current-truth recall；`review_due` 仅允许带状态提示的低风险检索；`stale`、`superseded`、`historical` 仅进入显式历史或审计查询。
6. 对通过资格过滤的记录按 mode、语义相关度、验证置信度和类型化新鲜度策略排序。
7. 记录召回结果、资产版本和召回时使用的 freshness/version，防止事后状态变化篡改证据语义。
8. Agent 是否实际使用由 runtime 事件或显式工具调用确认，不以“返回给模型”作为使用成功。

禁止使用统一的 `semanticSimilarity * timeDecay` 处理所有 Memory。Episode/Trace 可以使用类型化时间衰减；决策、约束和 Skill 不得仅因年龄降低有效性。

## 7. RecallEvent 与验证证据

```ts
interface RecallEventRecord {
  id: string;
  namespaceId: string;
  assetId: string;
  assetVersion: number;
  agentId: string;
  episodeId?: string;
  taskId?: string;
  loadoutEntryId?: string;
  mode: "bootstrap" | "recall" | "tool";
  outcome: "offered" | "used" | "ignored" | "failed";
  temporalValidityVersion: number;
  freshnessAtRecall: MemoryFreshness;
  eligibilityEvaluatedAt: string;
  evidenceIds: string[];
  createdAt: string;
}
```

验证判断必须区分：

- `offered`：资产被提供给 Agent。
- `used`：运行记录证明 Agent 使用了资产。
- `ignored`：资产被提供但未使用。
- `failed`：资产读取或执行失败。

只有 `used` 且后续 Episode 具有可评价结果时，才可形成 transfer evidence。单纯 recall 不增加 Skill 成功率。

## 8. 跨任务 Reward 设计

现有 `rTask` 保持当前任务结果语义。新增 reward 轴不覆盖旧值：

```ts
interface AssetRewardDetail {
  rTask: number;
  rHuman: number;
  rTransfer: number;
  rRisk: number;
  sourceEpisodeId?: string;
  targetEpisodeId?: string;
  assetId?: string;
  assetVersion?: number;
  relation: "explicit_sequence" | "asset_usage" | "plan_work_item" | "none";
  confidence: number;
  reason: string;
  evidenceIds: string[];
}
```

建议计算：

```text
rTransfer = targetTaskReward
          × usageFactor
          × relationConfidence
          × applicabilityFactor
```

其中：

- `usageFactor`：used=1，offered=0，ignored=0，failed 为负向风险信号。
- `relationConfidence`：显式 Experience Sequence 最高；仅 Plan/Work Item 关联次之；Topic 或语义相似不能单独产生 transfer reward。
- `applicabilityFactor`：资产适用范围与目标任务匹配程度。
- `rRisk`：错误召回、错误执行、过时资产或敏感资产越权造成的惩罚。

未召回、阶段完成后未使用或长期无匹配任务均不产生负 reward。只有资产被实际 `used` 后造成失败、越权、错误结果或无效执行，才可形成 `rRisk`。

第一阶段只需持久化 reward provenance 和统计，不要求改变模型训练参数。

## 9. 与现有模块的集成边界

### 9.1 Context Pack / Plan Groups

- Plan 和 Work Item 可以作为 Experience Sequence 的外部引用。
- Context Group 的 compiledTruth 不包含未经审核的 Asset candidate。
- Asset 验证证据可以作为 execution evidence 展示，但不能覆盖 Plan declaredStatus。
- Agent Activity 可以引用 Episode、RecallEvent 和 Asset 使用情况，但不得改变计划权威字段。
- Context Pack 只消费 `Current Truth`；完成或归档的 Plan/Work Item 相关 Memory 进入 Historical Evidence，除非仍有独立有效的项目级约束或决策。
- Goal、Plan、Work Item 的状态变化可以触发 freshness 重算，但 Asset/Memory 时效投影不得反向修改这些权威状态。

### 9.2 Topic Multi-Agent Decision

- Topic Decision 的 Evidence Snapshot 可以引用 Asset 和 RecallEvent 作为证据。
- Decision Session 可以提出“创建 Skill candidate”“绑定 Loadout”“验证某版本 Skill”等 Action Proposal。
- candidate promotion、active 绑定和高层 Memory 写入仍遵守现有二次确认规则。
- Topic 相似度只用于发现资产候选或提供证据，不自动建立 Experience Sequence。
- Topic session 的 stale 状态优先于资产操作；证据快照变化时，尚未执行的 Asset mutation 必须停止。
- Topic session 的 stale 与 Memory freshness 是不同状态：前者表示证据快照变化，后者表示单条 Memory 的当前适用性；两者都必须阻止未经复核的自动 mutation。

### 9.3 Reward Pipeline

- 保留现有 `rTask`、`rHuman`、trace backpropagation 和 negative experience 逻辑。
- 在 reward detail 中增加 Asset 关联和 transfer provenance。
- 负面 Episode 可以降低资产 validation stats，并触发现有 negative experience 流程。
- Reward 不能直接修改 Goal、Plan、Work Item 状态。

### 9.4 Skill Pipeline

- 保留现有 skill draft、counter-example、verify draft、cooldown 和 drift 逻辑。
- SkillPipeline 负责生成和更新 candidate 内容。
- Asset lifecycle service 负责状态转换、版本、Loadout 影响和审计。
- 两者通过明确的 `assetId/version` 关联，不通过任意 `info` 字段推断当前 active 版本。

### 9.5 Memory Repository 与 Supersession

- 保留现有 `MemoryStatus` 与 `supersedes` 关系；显式 supersession 继续归档旧记录并建立可追溯替代链。
- Temporal Validity 是正交 read model，不用 `updatedAt` 推断 freshness，也不把 `review_due` 映射为 archived。
- 搜索 repository 先做时效资格过滤，再做相关度排序；不得先截取“最近更新的 N 条”而导致长期有效决策被排除。
- 维护性更新不得改变 `observedAt`、`effectiveFrom`、`reviewAfter` 或 `lastReviewedAt`。

## 10. 权限、安全与数据隔离

资产操作必须同时检查：

1. principal 是否属于 namespace。
2. asset visibility 是否允许当前 Agent 使用。
3. restricted 资产是否命中 ACL。
4. agent-specific 资产是否命中 `allowedAgentIds`。
5. project/task scope 是否匹配。
6. 当前操作是否需要人工确认。

安全要求：

- RecallEvent、Asset provenance 和审计日志不得保存原始 secret。
- provider raw response 保持在现有 audit/logging substrate，不进入 Asset read model。
- 外部写操作的 Skill 必须声明 effect class、permission、acceptance 和 rollback。
- 资产内容中的提示词不得覆盖系统权限、namespace 边界或确认策略。
- deprecated 资产不应继续自动出现在 bootstrap context。

## 11. API 边界

API 名称可按现有 namespace-scoped contract 风格落地，概念操作包括：

### Asset

- 创建或读取 Asset candidate。
- 查询 Asset 版本和来源。
- 提交审核、批准、拒绝、弃用或恢复。
- 查询 Asset validation stats。

### Temporal Validity

- 查询 Current Truth、Review Queue 和 Historical Evidence，支持按 Memory 类型、作用域和失效信号过滤。
- 以 `memoryId + version` 提交复核结论，将 `review_due` 恢复为 `current` 或转为 `stale`，并记录 actor、reason、evidenceIds 和项目状态引用。
- 写入显式失效、historical 或 supersession 事件；supersession 必须校验替代 Memory 可见且不存在关系环。
- 读取某 Memory 的 validity 版本历史和 freshness 重算依据。

### Loadout

- 为 Agent 绑定或解绑 Asset version。
- 修改 mode、priority、scope 和 enabled 状态。
- 查询某 Agent 当前有效 Loadout。

### Experience Sequence

- 创建或复用 namespace 内的 sequence。
- 将 Episode 关联到 sequence position。
- 查询 sequence 内 Episode、Asset 和 reward provenance。

### Recall / Validation

- 写入 RecallEvent。
- 查询某资产的使用历史。
- 触发或读取一次验证结果。

所有 mutation 必须支持 namespace scope、optimistic concurrency 和幂等键。Asset、Loadout、Sequence 的审计操作不得复用 Topic candidate audit 的实体类型，但可以复用现有审计基础设施。

## 12. 一致性、并发和幂等

- Asset version 内容不可变；更新创建新版本。
- active 版本切换和旧版本 deprecated 必须在同一事务内完成。
- Loadout 绑定不存在或不可见的版本时拒绝提交。
- 删除资产采用逻辑状态转换，不物理删除来源和审计记录。
- 同一个 RecallEvent 的幂等键由 `namespaceId + episodeId + assetId + assetVersion + mode + eventKey` 构成。
- 同一个 Episode 不能重复占用同一 sequence position。
- 新的 Topic evidence、Plan version 或 Work Item version 不会静默修改已有 Experience Sequence；需要显式更新并记录 provenance。
- 资产验证统计允许追加事件后重算，但不得改写原始 RecallEvent 或 reward evidence。
- Temporal Validity mutation 使用 `memoryId + version` 乐观并发；复核、失效和 supersession 事件必须保留 actor、reason、evidenceIds 和发生时的项目状态引用。
- freshness 可以由事件重算，但不得改写原始 Memory、RecallEvent 或历史 validity 版本。

## 13. 分阶段落地

### Phase A：Asset 与 Temporal Read Model

范围：

- Asset record 和版本查询。
- 来源 Episode/Trace/Memory 关联。
- lifecycle status。
- Skill candidate 映射。
- Memory Temporal Validity、Current Truth、Review Queue 和 Historical Evidence 投影。
- 基础审计。
- Temporal Validity 查询、复核、失效和 supersession 操作。

不做 Agent Loadout，不改变召回行为。

### Phase B：Skill Lifecycle

范围：

- candidate/reviewing/active/deprecated/rejected 状态机。
- 结构校验、来源校验和最低验证要求。
- active 版本切换和回滚。
- 现有 SkillPipeline 接入 Asset ID/version。

### Phase C：Agent Loadout 与 RecallEvent

范围：

- Agent 资产绑定。
- bootstrap/recall/tool mode。
- 召回权限和 scope 过滤。
- RecallEvent 和实际使用状态。
- freshness、有效区间和失效信号过滤。
- RecallEvent 固化召回时的 temporal validity version。

### Phase D：Experience Sequence 与 Transfer Reward

范围：

- sequence metadata。
- solve/curate/verify 角色。
- asset usage 与后续 Episode 关联。
- transfer reward provenance。
- validation stats 更新和风险惩罚。

### Phase E：Wiki / CodeGraph 扩展

范围：

- Wiki asset 的按需读取接口。
- CodeGraph asset 的符号、调用方、被调用方和影响路径接口。
- 统一接入 Loadout、RecallEvent 和权限检查。

## 14. 验收标准

1. Asset 能记录类型、版本、状态、Owner、可见性和来源证据。
2. Skill candidate 不经过生命周期校验不能自动成为 active。
3. active Skill 更新后生成新版本，旧版本仍可审计和回滚。
4. Agent 只能读取其 namespace 和 Loadout 允许的资产版本。
5. 召回事件能区分 offered、used、ignored 和 failed。
6. 只有实际 used 的资产才能获得 transfer validation evidence。
7. Experience Sequence 能表达 Episode 的 position、task 引用和 solve/curate/verify 角色。
8. 仅 Topic 相似度或 embedding 相似度不能单独触发跨任务 reward 回传。
9. 现有 Episode `rTask` 语义保持不变，新增 transfer/risk 信息具有独立 provenance。
10. 负面验证结果能降低资产验证统计，并保留原始失败证据。
11. Context Pack 的 Goal、Plan、Work Item 权威字段不被 Asset 或 reward 自动覆盖。
12. Topic Decision 的证据冻结、stale、审批和二次确认规则继续有效。
13. 所有资产、绑定、序列和召回 mutation 具备 namespace 校验、乐观并发和幂等保护。
14. 审计可以从 active Asset 追溯到版本、来源 Episode、Trace、RecallEvent 和验证 reward。
15. Wiki 和 CodeGraph 未实现时，Asset 类型扩展不影响已有 ChatMemory/Skill 流程。
16. Skill 初次生成采用证据支持的最窄 work_item、plan、project、namespace 或 global 作用域。
17. Work Item、Plan 或 Project 完成后，命中 `retireWhen` 的 binding 自动禁用且不再进入默认召回。
18. 阶段性退役不修改 Asset 的可信状态，不删除来源、验证或审计证据。
19. 长期未使用不会单独降低验证统计、产生风险惩罚或触发 deprecated。
20. 作用域扩大必须生成新版本，并由目标范围内的实际成功复用证据支持。
21. `createdAt`、`updatedAt`、`observedAt`、有效区间和复核时间具有独立语义，维护性更新不会刷新内容有效期。
22. Current Truth 只包含当前作用域、有效区间、失效信号和 supersession 检查均通过的 Memory。
23. `review_due` 不进入自动 bootstrap，高风险操作不能直接使用；复核后可以恢复为 `current` 或转为 `stale`。
24. `stale`、`superseded` 和 `historical` 不指导当前执行，但原始内容、替代链和审计证据仍可查询。
25. 决策、约束和 Skill 不因单纯年龄或未使用自动失效；Episode/Trace 的时间衰减不影响精确审计检索。
26. Work Item、Plan、Goal 状态变化和 Project 归档能触发关联 Memory 的 freshness 重算，且不会反向修改项目权威状态。
27. 搜索在相关度排序前执行时效资格过滤，不依赖 `updatedAt` 代表内容新鲜度。
28. RecallEvent 固化召回时的 `temporalValidityVersion`、`freshnessAtRecall` 和资格评估时间；后续 freshness 变化不改写历史事件。
29. Review Queue 操作使用 `memoryId + version` 乐观并发，并完整记录复核 actor、reason、evidenceIds 和项目状态引用。
30. supersession 拒绝不可见的替代 Memory 和关系环，成功后旧 Memory 退出 Current Truth 且替代链可审计。

## 15. 风险与取舍

### 风险：资产数量快速增长

处理：stableKey、版本合并策略、cooldown、生命周期清理和 validation-based deprecation。

### 风险：错误 Skill 跨 Agent 扩散

处理：candidate 默认不可绑定；Loadout 固定版本；高风险动作需要确认；失败验证产生 risk penalty。

### 风险：相似任务被误判为可迁移

处理：显式 sequence 和实际 asset usage 才能形成 transfer evidence；相似度只做候选发现。

### 风险：与现有 Memory 字段重复

处理：Asset 作为治理 read model；现有 MemoryRow 继续作为事实来源，不立即破坏旧字段和导入导出格式。

### 风险：上下文注入过量

处理：L2/L3 只用于 bootstrap；L1 通过 recall；Wiki/CodeGraph 通过 tool 按需读取；Loadout 设置 priority 和 scope。

### 风险：旧 Memory 继续指导当前执行

处理：分离存储状态与 freshness；维护 Current Truth、Review Queue、Historical Evidence；召回前检查有效区间、失效信号、作用域和 supersession。

### 风险：统一 TTL 误删长期有效知识

处理：时间只触发复核，不自动证明错误；决策、约束和 Skill 采用事件与证据驱动，历史记录逻辑保留。

## 16. 后续实施前置条件

开始实现前必须确认：

- 当前 Context Pack / Plan Groups 迁移已完成并通过其 contract tests。
- 当前 Topic Multi-Agent Decision 的 persistence 和 API contract 已稳定，或明确指定兼容版本。
- Episode、Reward、Skill trial 的现有字段和事件命名已冻结一版。
- 资产级权限的 principal、namespace 和 agent identity 来源已确定。
- 首个接入的 Asset 类型确定为 Skill，Wiki 和 CodeGraph 不得提前扩大 Phase B 范围。

本文是后续阶段设计，不构成当前开发任务的变更请求。任何实现前的需求变化必须重新检查与上述两份进行中设计的同步关系。

## 17. 相关契约文档与实现基线

后续实施计划必须以以下当前文件为兼容基线：

- `docs/superpowers/specs/2026-08-12-context-pack-plan-groups-design.md`
- `docs/superpowers/specs/2026-08-12-topic-multi-agent-decision-design.md`
- `Memory/src/service/evolution/reward-pipeline.ts`
- `Memory/src/service/evolution/skill-pipeline.ts`
- `Memory/src/service/evolution/policy-induction.ts`
- `Memory/src/service/topic-inbox/topic-inbox-types.ts`
- `Memory/src/storage/repositories.ts`
- `Memory/src/types.ts` 中 `MemoryStatus`、`MemoryRow`、`MemoryRelation` 和现有 `supersedes` 语义。

若上述设计或实现契约在本阶段启动前发生变化，必须先更新本文的集成边界和验收标准，再编写实施计划。

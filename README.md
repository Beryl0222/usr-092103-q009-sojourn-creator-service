# 旅创人才服务接续（连续案件系统）

旅居创业者从人才库登记到正式开业，依次经历**项目合作 → 经营主体注册 → 社保 → 用工 → 贷款 → 法律咨询**。本仓库保存这条连续案件的**领域词汇、公共事件外壳、事件流不变量与中文联调样例**，让：

- **申请人**看到每个事项由谁处理、尚缺什么、承诺时限；
- **管理者**分辨服务究竟卡在**转介**（发出后无人受理）还是**回执**（已受理但结果未回到主理窗口）；
- 人才档案、技能意向、居住阶段、项目提案、政策资格、材料声明、部门转介、办理结果在同一事件外壳下衔接。

## 资料结构

- `contracts/domain.schema.json`：公共事件信封、稳定枚举与每种事件的 payload 条件契约（JSON Schema 2020-12）。
- `src/validator.js`：
  - `validateEvent(e)` 单事件信封/payload 校验；
  - `validateStream(events, now?)` 事件流不变量校验，返回 `{ errors, warnings }`；
  - `caseTimeline(events, caseId)` 申请人只读视图（事项、承办人、时限、缺件、证明、资格）；
  - `bottlenecks(events, now?)` 管理者只读视图（转介滞留 / 回执滞留 / 时限预警）。
- `data/sample.json`：最小登记样例；`data/lifecycle.json`：一条完整连续案件（登记→六事项→开业→跨城迁移）。
- `tests/`：样例、不变量与两个视图的测试。

## 事件与聚合

| 阶段 | 主要事件 |
| --- | --- |
| 人才档案 | `PROFILE_REGISTERED`、`SKILLS_INTENT_UPDATED`、`RESIDENCE_STAGE_CHANGED` |
| 连续案件 | `CASE_OPENED`、`CASE_COMPLETED` |
| 项目与政策 | `PROJECT_PROPOSAL_SUBMITTED`、`POLICY_HINTED`、`ELIGIBILITY_CONFIRMED/DENIED/EXPIRED/REVOKED`、`PROJECT_SELECTION_DECIDED` |
| 材料与授权 | `DOCUMENT_DECLARED`、`CONSENT_GRANTED/REVOKED`、`DOCUMENT_SHARED`、`DOCUMENT_EXPIRED`、`DOCUMENT_USE_BLOCKED` |
| 转介与办理 | `REFERRAL_ISSUED/ACCEPTED/DECLINED/RETURNED/CLOSED_LOOP`、`TASK_ASSIGNED/STAGE_CHANGED/SLA_BREACHED`、`SUPPLEMENT_REQUESTED/RECEIVED` |
| 机构决定 | `REGISTRATION_DECIDED`、`LOAN_DECIDED`、`LEGAL_OPINION_ISSUED` |
| 跨城迁移 | `PROFILING_CONSENT_UPDATED`、`CASE_EXPORT_REQUESTED`、`CASE_EXPORTED` |

聚合类型：`talent_profile`、`service_case`、`project_proposal`、`policy_eligibility`、`document_assertion`、`consent_grant`、`agency_receipt`、`service_task`、`case_transfer`。

## 公共语义（由 `validateStream` 强制）

1. **规则只提示，机构才决定**：`POLICY_HINTED` 不得携带 `decision/approved/decided_by`；资格以 `ELIGIBILITY_CONFIRMED` 为准；遴选、注册、贷款分别由文旅、市场监管、银行等责任机构以 `*_DECIDED` 作出。
2. **同一证明按用途授权复用**：`DOCUMENT_SHARED` 必须命中一份有效的 `CONSENT_GRANTED`（用途相符、未撤回、未到期），否则判错；证明本身过期或授权撤回后立即拒绝新办理（`DOCUMENT_USE_BLOCKED`），阻断未解除时任务不得推进，补交有效材料后恢复。
3. **连续可见**：任务携带承办机构/经办人与 `sla_due_at`，缺件经 `SUPPLEMENT_*` 跟踪；资格/证明过期主动通知后续环节，转介链必须"发出→受理→回执闭环"。
4. **跨城随案本人选择**：导出须先有本人 `CASE_EXPORT_REQUESTED` 勾选，`CASE_EXPORTED.included_aggregates` 不得超出勾选；原机构仅保留审计记录并声明 `audit_retention_until`。
5. **画像用途隔离**：未经 `PROFILING_CONSENT_UPDATED` 显式同意，任何证明不得用于 `INVESTMENT_SCREENING`（招商筛选）。

`warnings` 不阻断联调，但标示治理隐患：转介超承诺时限未受理（卡转介）、受理后无回执（卡回执）、补正未办结、超时推进等。

## 本地检查

```bash
npm test
```

也可用 JSON Schema 直接校验单条事件（需 Node 18+ 与 ajv-cli）：

```bash
npx ajv-cli --spec=draft2020 --strict=false validate \
  -s contracts/domain.schema.json -d '某事件.json'
```

本仓库只规定跨模块交换的契约与联调样例，不包含存储与接口实现。

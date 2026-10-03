# 旅创人才服务接续：连续案件

一名旅居创业者从人才库登记到真正开业，依次经过**项目合作、经营主体注册、社保、用工、贷款、法律咨询**。本仓库把这条链路建模为一个**连续案件**（service_case）：申请人不再每个窗口重交材料，资格过期主动通知下一环节；申请人能看到事项由谁处理、尚缺什么、承诺时限；管理者能看出服务究竟卡在转介、回执还是机构内部办理。

本仓库只规定跨机构交换的**领域事件契约、序列不变量与读模型**，不绑定存储、传输或具体接口实现。贷款、注册和项目遴选始终由各责任机构独立决定。

## 资料结构

| 路径 | 内容 |
| --- | --- |
| `contracts/domain.schema.json` | 领域事件的公共信封与稳定枚举（30 种事件、14 类聚合、7 个阶段） |
| `src/catalog.js` | 事件类型、聚合、阶段、授权用途、决定结论的**单一枚举事实源** |
| `src/validator.js` | 单条事件公共字段校验 |
| `src/sequence.js` | 序列不变量 + 三个读模型（申请人视图、管理者转介视图、过期预警） |
| `data/sample.json` | 最小事件样例 |
| `data/continuous-case.sequence.json` | 从登记到跨城迁移的 78 个事件全流程联调样例 |
| `tests/contract.test.js` | 契约与规则的 14 项自动化检查 |

## 案件阶段与对象衔接

七个阶段按固定顺序推进（`CASE_STAGE_ADVANCED` 只能到紧邻的下一阶段，且前一阶段必须已有办理结果）：

```
talent_registry → project_cooperation → business_registration → social_insurance
               → employment → loan → legal_consulting
```

领域对象全部挂在公共事件信封下，以同一 `case_id` / `person_id` 衔接：人才档案（talent_profile）、技能意向（skill_intent）、居住阶段（residence_stage）、项目提案（project_proposal）、政策资格（policy_eligibility）、材料声明（document_assertion）、授权（consent_grant）、部门转介（agency_referral）、受理回执（agency_receipt）、案件任务（case_task）、机构决定（agency_decision）、办理结果（handling_result）、跨城迁移（case_transfer）。

## 规则只提示，机构才决定

- `SERVICE_MATCHED` 只能由 `actor_kind = rule_engine` 产生，只携带 `eligibility_code` 与匹配理由，**禁止携带 outcome**。
- `POLICY_ELIGIBILITY_DECIDED`、`PROJECT_SELECTION_DECIDED`、`REGISTRATION_DECIDED`、`LOAN_DECIDED` 只能由 `responsible_agency` 产生；资格决定必须能回溯到一条规则提示，但提示不构成资格。
- 样例中贴息资格审核通过，银行仍独立作出拒贷决定——单项被拒不终止连续案件，案件继续推进到法律咨询。

## 证明按用途授权复用

同一份材料在各窗口不再重交，但复用受四条约束（见 `validateSequence`）：

1. **用途绑定**：授权（`CONSENT_GRANTED`）逐用途授予（project_selection / business_registration / social_insurance / employment_filing / loan_review / legal_aid / case_transfer），事件以 `used_documents` 复用时用途必须相符。
2. **收件机构绑定**：授权指定 `recipient_agency`，授给 A 机构的不能被 B 机构使用。
3. **限期**：每条授权必须有 `valid_until`，无期限授权直接判为非法序列；授权可 `CONSENT_REVOKED`。
4. **即时失效**：材料 `DOCUMENT_WITHDRAWN` 撤回、`DOCUMENT_EXPIRED` 过期或授权撤回/到期后，之后任何新办理使用该材料立即报错。

## 转介、回执与办理

任务生命周期：`REFERRAL_ISSUED → REFERRAL_ACCEPTED → TASK_ASSIGNED → RECEIPT_ISSUED → TASK_DEADLINE_PROMISED / TASK_MATERIAL_REQUESTED → MATERIAL_SUBMITTED → HANDLING_RESULT_RECORDED`。

- 未受理不能出回执，未出回执不能登记办理结果；有未补齐的缺件不能办结。
- 每步时间戳落事件，停留时长可量化。

## 两种视图（读模型）

```js
import { caseOverview, referralTimeline, expiryWatch } from "./src/sequence.js";

caseOverview(events, { asOf: "2026-09-27T00:00:00+08:00" });
// 每个在办事项：stage / agency_id / assignee_id（谁在办）
// state: awaiting_receipt | awaiting_materials | in_progress | done
// missing_materials（尚缺什么）、promised_deadline、overdue（承诺时限）

referralTimeline(events, { asOf: "..." });
// 逐笔转介：referral_dwell_ms（卡在转介）、receipt_dwell_ms（卡在回执）、
// handling_dwell_ms（卡在办理）、bottleneck 与瓶颈计数

expiryWatch(events, { asOf: "...", lead_days: 30 });
// 材料与授权的 expired / expiring 预警，材料项给出尚未使用过它的下游阶段，
// 用于"一项资格过期主动通知下一环节"。
```

## 跨城迁移与画像边界

- `CASE_TRANSFER_REQUESTED` 只能由**申请人本人**发起，并在 `selected_documents` 中勾选随案资料；机构不得替申请人选择。
- `CASE_TRANSFER_EXPORTED` 导出的每一份资料都必须在勾选清单内（样例中资产证明与银行流水未随迁）。
- 迁入城市接收（`CASE_TRANSFER_IMPORTED`）后，原机构写入 `CASE_EXPORT_LOCKED`：案件锁定、停止一切新办理，只保留至 `retention_until` 的必要审计记录。
- `investment_screening` 用途存在于枚举中但**没有任何默认授权**：未经同意的技能意向、居住阶段等个人画像不得转作招商筛选；画像数据只能在申请人明确授予的用途内使用。

## 版本语义

- 同一 `aggregate_id` 的 `version` 严格递增，用于乐观并发与回放。
- 序列必须按 `occurred_at` 递增；立案后的所有事件携带同一 `case_id`，且 `person_id` 全序列一致。
- schema 允许 `additionalProperties`：新增事件字段不破坏旧消费方；新增事件类型/阶段需同时改 `src/catalog.js` 与 schema（有测试强制两者一致）。

## 本地检查

```bash
npm test
```

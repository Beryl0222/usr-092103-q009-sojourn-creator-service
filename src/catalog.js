// 连续案件领域目录：事件类型、聚合类型、案件阶段、授权用途与决定结论的唯一枚举源。
// 契约（contracts/domain.schema.json）与序列校验（src/sequence.js）都从这里取值。

export const STAGES = Object.freeze({
  TALENT_REGISTRY: "talent_registry", // 人才库登记
  PROJECT_COOPERATION: "project_cooperation", // 项目合作
  BUSINESS_REGISTRATION: "business_registration", // 经营主体注册
  SOCIAL_INSURANCE: "social_insurance", // 社保
  EMPLOYMENT: "employment", // 用工
  LOAN: "loan", // 贷款
  LEGAL_CONSULTING: "legal_consulting", // 法律咨询
});

// 阶段的承诺办理顺序；案件只能向前推进，允许并行补正，不允许回退到已完成阶段。
export const STAGE_ORDER = Object.freeze([
  STAGES.TALENT_REGISTRY,
  STAGES.PROJECT_COOPERATION,
  STAGES.BUSINESS_REGISTRATION,
  STAGES.SOCIAL_INSURANCE,
  STAGES.EMPLOYMENT,
  STAGES.LOAN,
  STAGES.LEGAL_CONSULTING,
]);

export const EVENT_TYPES = Object.freeze({
  PROFILE_REGISTERED: "PROFILE_REGISTERED", // 人才档案登记
  SKILL_INTENT_RECORDED: "SKILL_INTENT_RECORDED", // 技能意向登记
  RESIDENCE_STAGE_CHANGED: "RESIDENCE_STAGE_CHANGED", // 居住阶段变化
  PROJECT_PROPOSAL_SUBMITTED: "PROJECT_PROPOSAL_SUBMITTED", // 项目提案提交
  SERVICE_CASE_OPENED: "SERVICE_CASE_OPENED", // 连续案件开立
  SERVICE_MATCHED: "SERVICE_MATCHED", // 规则引擎提示可能适用的政策（仅建议）
  POLICY_ELIGIBILITY_DECIDED: "POLICY_ELIGIBILITY_DECIDED", // 责任机构作出资格决定
  DOCUMENT_DECLARED: "DOCUMENT_DECLARED", // 材料声明
  DOCUMENT_EXPIRED: "DOCUMENT_EXPIRED", // 材料/资格过期
  DOCUMENT_WITHDRAWN: "DOCUMENT_WITHDRAWN", // 申请人撤回材料
  CONSENT_GRANTED: "CONSENT_GRANTED", // 按用途授权复用证明
  CONSENT_REVOKED: "CONSENT_REVOKED", // 撤回授权
  REFERRAL_ISSUED: "REFERRAL_ISSUED", // 部门转介发出
  REFERRAL_ACCEPTED: "REFERRAL_ACCEPTED", // 转入机构受理
  REFERRAL_REJECTED: "REFERRAL_REJECTED", // 转入机构退回
  RECEIPT_ISSUED: "RECEIPT_ISSUED", // 受理回执
  TASK_ASSIGNED: "TASK_ASSIGNED", // 事项指派到承办人
  TASK_DEADLINE_PROMISED: "TASK_DEADLINE_PROMISED", // 承诺办理时限
  TASK_MATERIAL_REQUESTED: "TASK_MATERIAL_REQUESTED", // 通知尚缺材料
  MATERIAL_SUBMITTED: "MATERIAL_SUBMITTED", // 补齐材料
  PROJECT_SELECTION_DECIDED: "PROJECT_SELECTION_DECIDED", // 项目遴选决定（责任机构）
  REGISTRATION_DECIDED: "REGISTRATION_DECIDED", // 经营主体注册决定（登记机关）
  LOAN_DECIDED: "LOAN_DECIDED", // 贷款决定（授信机构）
  HANDLING_RESULT_RECORDED: "HANDLING_RESULT_RECORDED", // 办理结果归档
  CASE_STAGE_ADVANCED: "CASE_STAGE_ADVANCED", // 案件进入下一阶段
  CASE_COMPLETED: "CASE_COMPLETED", // 案件办结
  CASE_TRANSFER_REQUESTED: "CASE_TRANSFER_REQUESTED", // 申请人发起跨城迁移并勾选随案资料
  CASE_TRANSFER_EXPORTED: "CASE_TRANSFER_EXPORTED", // 原机构导出随案资料
  CASE_TRANSFER_IMPORTED: "CASE_TRANSFER_IMPORTED", // 迁入城市接收
  CASE_EXPORT_LOCKED: "CASE_EXPORT_LOCKED", // 导出后原机构仅保留审计记录、停止新办理
});

export const AGGREGATE_TYPES = Object.freeze({
  TALENT_PROFILE: "talent_profile",
  SKILL_INTENT: "skill_intent",
  RESIDENCE_STAGE: "residence_stage",
  PROJECT_PROPOSAL: "project_proposal",
  SERVICE_CASE: "service_case",
  POLICY_ELIGIBILITY: "policy_eligibility",
  DOCUMENT_ASSERTION: "document_assertion",
  CONSENT_GRANT: "consent_grant",
  AGENCY_REFERRAL: "agency_referral",
  AGENCY_RECEIPT: "agency_receipt",
  CASE_TASK: "case_task",
  AGENCY_DECISION: "agency_decision",
  HANDLING_RESULT: "handling_result",
  CASE_TRANSFER: "case_transfer",
});

// 同一证明按用途授权；用途与阶段对应，但授权本身逐条授予、逐条可撤回。
export const CONSENT_PURPOSES = Object.freeze({
  PROJECT_SELECTION: "project_selection", // 项目遴选
  BUSINESS_REGISTRATION: "business_registration", // 注册登记
  SOCIAL_INSURANCE: "social_insurance", // 社保参保
  EMPLOYMENT_FILING: "employment_filing", // 用工备案
  LOAN_REVIEW: "loan_review", // 贷款审查
  LEGAL_AID: "legal_aid", // 法律援助/咨询
  CASE_TRANSFER: "case_transfer", // 随案迁移
  INVESTMENT_SCREENING: "investment_screening", // 招商筛选：默认无授权，画像数据不得转作此用途
});

// 机构决定结论。规则引擎只能产出 SERVICE_MATCHED 建议，不得使用本枚举。
export const DECISION_OUTCOMES = Object.freeze({
  APPROVED: "approved",
  REJECTED: "rejected",
  SUPPLEMENT_REQUIRED: "supplement_required", // 需补正
});

export const REFERRAL_STATUS = Object.freeze({
  ISSUED: "issued",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
});

// 需要机构对人作出决定、且必须先有有效授权与受理回执的闸门事件。
export const DECISION_EVENTS = Object.freeze(new Set([
  EVENT_TYPES.POLICY_ELIGIBILITY_DECIDED,
  EVENT_TYPES.PROJECT_SELECTION_DECIDED,
  EVENT_TYPES.REGISTRATION_DECIDED,
  EVENT_TYPES.LOAN_DECIDED,
]));

// 闸门事件消费证明时必须持有的授权用途；未列入的用途不得从共享材料中推断。
export const EVENT_REQUIRED_PURPOSE = Object.freeze({
  PROJECT_PROPOSAL_SUBMITTED: CONSENT_PURPOSES.PROJECT_SELECTION,
  PROJECT_SELECTION_DECIDED: CONSENT_PURPOSES.PROJECT_SELECTION,
  REGISTRATION_DECIDED: CONSENT_PURPOSES.BUSINESS_REGISTRATION,
  LOAN_DECIDED: CONSENT_PURPOSES.LOAN_REVIEW,
  HANDLING_RESULT_RECORDED: null, // 结果按所属任务的既有授权，不单独消费
});

export const EVENT_TYPE_VALUES = Object.freeze(Object.values(EVENT_TYPES));
export const AGGREGATE_TYPE_VALUES = Object.freeze(Object.values(AGGREGATE_TYPES));
export const STAGE_VALUES = Object.freeze(Object.values(STAGES));
export const CONSENT_PURPOSE_VALUES = Object.freeze(Object.values(CONSENT_PURPOSES));
export const DECISION_OUTCOME_VALUES = Object.freeze(Object.values(DECISION_OUTCOMES));

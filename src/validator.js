import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const schema = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../contracts/domain.schema.json"), "utf8"),
);

const EVENT_TYPES = schema.$defs.event_type.enum;
const AGGREGATE_TYPES = schema.$defs.aggregate_type.enum;
// 各事件 payload 中需要枚举校验的字段（未列出的 reason 等为自由文本）
const PAYLOAD_ENUMS = {
  PROFILE_REGISTERED: { residence_stage: "residence_stage" },
  RESIDENCE_STAGE_CHANGED: { from_stage: "residence_stage", to_stage: "residence_stage" },
  CASE_OPENED: { service_items: "service_item[]" },
  POLICY_HINTED: { suggested_service_items: "service_item[]" },
  PROJECT_SELECTION_DECIDED: { decision: ["SELECTED", "NOT_SELECTED"] },
  CONSENT_GRANTED: { purposes: "document_purpose[]" },
  DOCUMENT_SHARED: { purpose: "document_purpose" },
  DOCUMENT_USE_BLOCKED: { attempted_purpose: "document_purpose", reason: "block_reason" },
  REFERRAL_ISSUED: { service_item: "service_item" },
  TASK_ASSIGNED: { service_item: "service_item" },
  TASK_STAGE_CHANGED: { status: "task_status" },
  REGISTRATION_DECIDED: { decision: ["GRANTED", "REJECTED"] },
  LOAN_DECIDED: { decision: ["APPROVED", "REJECTED"] },
  CASE_EXPORT_REQUESTED: { selected_aggregates: "aggregate_type[]" },
  CASE_EXPORTED: { included_aggregates: "aggregate_type[]", excluded_aggregates: "aggregate_type[]" },
};

function enumAllowed(spec) {
  if (Array.isArray(spec)) return spec;
  if (spec.endsWith("[]")) return schema.$defs[spec.slice(0, -2)].enum;
  return schema.$defs[spec].enum;
}

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];
const PERSON_LEVEL_EVENTS = new Set([
  "PROFILE_REGISTERED",
  "SKILLS_INTENT_UPDATED",
  "RESIDENCE_STAGE_CHANGED",
  "PROFILING_CONSENT_UPDATED",
]);
const PAYLOAD_REQUIRED = {
  PROFILE_REGISTERED: ["person_id", "residence_stage"],
  SKILLS_INTENT_UPDATED: ["skills", "intent"],
  RESIDENCE_STAGE_CHANGED: ["from_stage", "to_stage"],
  CASE_OPENED: ["person_id", "service_items"],
  PROJECT_PROPOSAL_SUBMITTED: ["proposal_id", "title"],
  POLICY_HINTED: ["policy_code", "matched_basis"],
  ELIGIBILITY_CONFIRMED: ["policy_code", "agency", "valid_until"],
  ELIGIBILITY_DENIED: ["policy_code", "agency", "reason"],
  ELIGIBILITY_EXPIRED: ["policy_code"],
  ELIGIBILITY_REVOKED: ["policy_code", "agency", "reason"],
  PROJECT_SELECTION_DECIDED: ["proposal_id", "agency", "decision"],
  DOCUMENT_DECLARED: ["document_id", "doc_type", "issued_by"],
  CONSENT_GRANTED: ["consent_id", "document_id", "purposes"],
  CONSENT_REVOKED: ["consent_id", "document_id"],
  DOCUMENT_SHARED: ["document_id", "purpose", "target_agency"],
  DOCUMENT_EXPIRED: ["document_id"],
  DOCUMENT_USE_BLOCKED: ["document_id", "reason"],
  REFERRAL_ISSUED: ["referral_id", "from_agency", "to_agency", "service_item"],
  REFERRAL_ACCEPTED: ["referral_id"],
  REFERRAL_DECLINED: ["referral_id", "reason"],
  REFERRAL_RETURNED: ["referral_id", "missing_items"],
  REFERRAL_CLOSED_LOOP: ["referral_id", "result"],
  TASK_ASSIGNED: ["task_id", "service_item", "agency", "sla_due_at"],
  TASK_STAGE_CHANGED: ["task_id", "status"],
  TASK_SLA_BREACHED: ["task_id", "sla_due_at"],
  SUPPLEMENT_REQUESTED: ["task_id", "missing_items"],
  SUPPLEMENT_RECEIVED: ["task_id", "items"],
  REGISTRATION_DECIDED: ["agency", "decision"],
  LOAN_DECIDED: ["agency", "decision"],
  LEGAL_OPINION_ISSUED: ["opinion_id", "agency"],
  PROFILING_CONSENT_UPDATED: ["investment_screening_allowed"],
  CASE_EXPORT_REQUESTED: ["destination_city", "selected_aggregates"],
  CASE_EXPORTED: ["export_id", "destination_city", "included_aggregates", "audit_retention_until"],
};
// 规则匹配只能提示，不得夹带批准结论
const HINT_FORBIDDEN_KEYS = new Set(["decision", "approved", "decided_by"]);

// 授权失效后不得继续推进的办理动作
const PROGRESS_STATUSES = new Set(["IN_PROGRESS", "DONE"]);

/** 单条事件的信封与 payload 结构校验 */
export function validateEvent(record) {
  const errors = REQUIRED.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if (record.version !== undefined && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if (record.event_type !== undefined && !EVENT_TYPES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if (record.aggregate_type !== undefined && !AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if (record.occurred_at !== undefined && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  const p = record.payload;
  if (PAYLOAD_REQUIRED[record.event_type]) {
    if (!p || typeof p !== "object") {
      errors.push(`${record.event_type} 必须携带 payload`);
    } else {
      for (const key of PAYLOAD_REQUIRED[record.event_type]) {
        if (!(key in p)) errors.push(`${record.event_type}.payload 缺少字段：${key}`);
      }
      for (const [key, spec] of Object.entries(PAYLOAD_ENUMS[record.event_type] ?? {})) {
        const allowed = enumAllowed(spec);
        const values = Array.isArray(p[key]) && typeof spec === "string" && spec.endsWith("[]") ? p[key] : [p[key]];
        for (const v of values) {
          if (v !== undefined && !allowed.includes(v)) errors.push(`payload.${key} 取值非法：${v}`);
        }
      }
      if (record.event_type === "POLICY_HINTED") {
        for (const key of HINT_FORBIDDEN_KEYS) {
          if (key in p) errors.push(`POLICY_HINTED 只是政策提示，不得携带 ${key}`);
        }
      }
      if (record.event_type === "CASE_EXPORTED") {
        for (const agg of p.included_aggregates ?? []) {
          if (!AGGREGATE_TYPES.includes(agg)) errors.push(`导出包含未知聚合：${agg}`);
        }
      }
    }
  }
  return errors;
}

/**
 * 事件流不变量校验。
 * 返回 { errors, warnings }：errors 表示违反公共契约（授权复用、失效停办、
 * 建议/决定边界、转介链、导出范围、招商画像同意），warnings 表示时限与闭环隐患。
 */
export function validateStream(events, now = new Date().toISOString()) {
  const errors = [];
  const warnings = [];
  const fail = (e, msg) => errors.push(`${e.event_id ?? "?"} ${e.event_type ?? "?"}：${msg}`);
  const warn = (e, msg) => warnings.push(`${e.event_id ?? "?"} ${e.event_type ?? "?"}：${msg}`);

  for (const e of events) {
    const structural = validateEvent(e);
    if (structural.length) errors.push(...structural.map((m) => `${e.event_id ?? "?"}：${m}`));
  }

  const ordered = [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const seenEventIds = new Set();
  const aggVersion = new Map();
  const declaredDocs = new Map(); // document_id -> 事件
  const liveConsents = new Map(); // consent_id -> {document_id, purposes, expires_at, revoked}
  const docBlockedAt = new Map(); // document_id -> 失效时间（过期或授权撤回）
  const blockedTasks = new Map(); // task_id -> 阻断原因
  const proposals = new Set();
  const referrals = new Map(); // referral_id -> 状态
  const tasks = new Map(); // task_id -> 任务状态
  const supplementMissing = new Map(); // task_id -> 待补材料集合
  const openedCases = new Set();
  const completedCases = new Set();
  const exportRequests = new Map(); // case_id -> 选中聚合
  let profilingAllowedAt = null; // {at, allowed}

  for (const e of ordered) {
    const t = Date.parse(e.occurred_at);
    const p = e.payload ?? {};

    if (seenEventIds.has(e.event_id)) fail(e, "event_id 重复");
    seenEventIds.add(e.event_id);

    // 同一聚合内版本严格递增
    const lastVersion = aggVersion.get(e.aggregate_id);
    if (lastVersion !== undefined && e.version <= lastVersion) {
      fail(e, `聚合 ${e.aggregate_id} 版本未严格递增（上一版本 ${lastVersion}）`);
    }
    if (lastVersion === undefined && e.version !== 1) fail(e, "聚合首个事件 version 必须为 1");
    aggVersion.set(e.aggregate_id, e.version);

    // 案件内事件应有 case_id；案件须先开立、结案后不得再办理
    if (!PERSON_LEVEL_EVENTS.has(e.event_type)) {
      if (!e.case_id) warn(e, "案件内事件建议携带 case_id 以便串联");
      if (e.case_id && completedCases.has(e.case_id) && !e.event_type.startsWith("CASE_EXPORT")) {
        fail(e, `案件 ${e.case_id} 已结案，不得再产生办理事件`);
      }
    }

    switch (e.event_type) {
      case "CASE_OPENED":
        openedCases.add(e.case_id ?? e.aggregate_id);
        break;
      case "CASE_COMPLETED":
        completedCases.add(e.case_id ?? e.aggregate_id);
        break;
      case "PROJECT_PROPOSAL_SUBMITTED":
        proposals.add(p.proposal_id);
        break;
      case "PROJECT_SELECTION_DECIDED":
        if (!proposals.has(p.proposal_id)) fail(e, "遴选决定缺少对应的项目提案");
        break;
      case "DOCUMENT_DECLARED":
        declaredDocs.set(p.document_id, e);
        break;
      case "CONSENT_GRANTED": {
        if (!declaredDocs.has(p.document_id)) fail(e, "授权指向未登记的材料声明");
        liveConsents.set(p.consent_id, {
          document_id: p.document_id,
          purposes: new Set(p.purposes),
          expires_at: p.expires_at ? Date.parse(p.expires_at) : null,
          revoked: false,
        });
        break;
      }
      case "CONSENT_REVOKED": {
        const consent = liveConsents.get(p.consent_id);
        if (!consent || consent.document_id !== p.document_id) fail(e, "撤回的授权不存在或材料不匹配");
        if (consent) consent.revoked = true;
        docBlockedAt.set(p.document_id, t);
        break;
      }
      case "DOCUMENT_EXPIRED":
        if (!declaredDocs.has(p.document_id)) fail(e, "过期事件指向未登记的材料");
        docBlockedAt.set(p.document_id, t);
        break;
      case "DOCUMENT_SHARED": {
        const doc = declaredDocs.get(p.document_id);
        if (!doc) {
          fail(e, "复用了未登记的材料");
          break;
        }
        const docUntil = doc.payload.valid_until ? Date.parse(doc.payload.valid_until) : null;
        if (docUntil !== null && docUntil <= t) fail(e, "证明已过期，不得继续复用");
        if (docBlockedAt.has(p.document_id) && docBlockedAt.get(p.document_id) <= t) {
          fail(e, "证明已过期或授权已撤回，新办理必须立即停止");
        }
        const covering = [...liveConsents.values()].find(
          (c) =>
            c.document_id === p.document_id &&
            c.purposes.has(p.purpose) &&
            !c.revoked &&
            (c.expires_at === null || c.expires_at > t),
        );
        if (!covering) fail(e, `用途 ${p.purpose} 未经有效授权，禁止超目的复用`);
        if (p.purpose === "INVESTMENT_SCREENING" && !(profilingAllowedAt?.allowed && profilingAllowedAt.at <= t)) {
          fail(e, "未经本人同意，个人画像不得转作招商筛选");
        }
        if (p.task_id) blockedTasks.delete(p.task_id); // 补交有效材料后解除阻断
        break;
      }
      case "DOCUMENT_USE_BLOCKED":
        if (p.attempted_task_id) blockedTasks.set(p.attempted_task_id, p.reason);
        break;
      case "PROFILING_CONSENT_UPDATED":
        profilingAllowedAt = { at: t, allowed: Boolean(p.investment_screening_allowed) };
        break;
      case "REFERRAL_ISSUED":
        referrals.set(p.referral_id, { status: "ISSUED", at: t, payload: p });
        break;
      case "REFERRAL_ACCEPTED": {
        const r = referrals.get(p.referral_id);
        if (!r) fail(e, "回执动作缺少对应的转介发出事件");
        else if (r.status === "CLOSED") fail(e, "已闭环的转介不能再被接收");
        else r.status = "ACCEPTED";
        break;
      }
      case "REFERRAL_DECLINED":
      case "REFERRAL_RETURNED": {
        const r = referrals.get(p.referral_id);
        if (!r) fail(e, "回执动作缺少对应的转介发出事件");
        else r.status = e.event_type === "REFERRAL_DECLINED" ? "DECLINED" : "RETURNED";
        break;
      }
      case "REFERRAL_CLOSED_LOOP": {
        const r = referrals.get(p.referral_id);
        if (!r) fail(e, "闭环事件缺少对应的转介");
        else if (r.status !== "ACCEPTED") fail(e, "转介未经接收机构受理，不能闭环");
        else r.status = "CLOSED";
        break;
      }
      case "TASK_ASSIGNED": {
        if (p.referral_id && !referrals.has(p.referral_id)) fail(e, "任务引用了不存在的转介");
        tasks.set(p.task_id, { ...p, status: "PENDING", assignedAt: t });
        break;
      }
      case "TASK_STAGE_CHANGED": {
        const task = tasks.get(p.task_id);
        if (!task) {
          fail(e, "任务状态变更缺少 TASK_ASSIGNED");
          break;
        }
        if (blockedTasks.has(p.task_id) && PROGRESS_STATUSES.has(p.status)) {
          fail(e, `材料阻断未解除（${blockedTasks.get(p.task_id)}），任务不得继续推进`);
        }
        if (PROGRESS_STATUSES.has(p.status) && task.sla_due_at && Date.parse(task.sla_due_at) < t) {
          warn(e, "任务已超出承诺时限才推进，应先记录 TASK_SLA_BREACHED");
        }
        task.status = p.status;
        break;
      }
      case "TASK_SLA_BREACHED": {
        const task = tasks.get(p.task_id);
        if (!task) warn(e, "超时事件缺少对应任务");
        else task.breached = true;
        break;
      }
      case "SUPPLEMENT_REQUESTED":
        supplementMissing.set(p.task_id, new Set(p.missing_items));
        break;
      case "SUPPLEMENT_RECEIVED": {
        if (!supplementMissing.has(p.task_id)) fail(e, "补交材料缺少对应的补正通知");
        break;
      }
      case "CASE_EXPORT_REQUESTED":
        exportRequests.set(e.case_id ?? e.aggregate_id, new Set(p.selected_aggregates));
        break;
      case "CASE_EXPORTED": {
        const requested = exportRequests.get(e.case_id ?? e.aggregate_id);
        if (!requested) fail(e, "导出缺少本人的 CASE_EXPORT_REQUESTED 勾选");
        else {
          for (const agg of p.included_aggregates) {
            if (!requested.has(agg)) fail(e, `导出超出本人勾选范围：${agg}`);
          }
        }
        if (!p.audit_retention_until) fail(e, "原机构须声明仅保留必要审计记录的期限");
        break;
      }
      default:
        break;
    }
  }

  // 流末隐患：超期未受理的转介、受理后无回执、补正未回
  const nowAt = Date.parse(now);
  for (const [id, r] of referrals) {
    const respondBy = r.payload.expected_response_days
      ? r.at + r.payload.expected_response_days * 86400000
      : null;
    if (r.status === "ISSUED" && respondBy !== null && nowAt > respondBy) {
      warnings.push(`转介 ${id}：超过承诺受理时限仍未被接收（卡在转介环节）`);
    }
    if (r.status === "ACCEPTED") warnings.push(`转介 ${id}：已受理但回执未回到主理窗口（卡在回执环节）`);
  }
  for (const [taskId] of supplementMissing) {
    const task = tasks.get(taskId);
    if (task && task.status !== "DONE") warnings.push(`任务 ${taskId}：补正通知后尚未办结`);
  }
  return { errors, warnings };
}

/**
 * 申请人视图：每个事项由谁处理、当前状态、尚缺材料、承诺时限，
 * 以及可复用证明与政策资格状态。
 */
export function caseTimeline(events, caseId) {
  const inCase = events
    .filter((e) => (e.case_id ?? e.aggregate_id) === caseId)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

  const tasks = new Map();
  const referrals = new Map();
  const documents = new Map();
  const eligibility = new Map();

  for (const e of inCase) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "TASK_ASSIGNED":
        tasks.set(p.task_id, {
          task_id: p.task_id,
          service_item: p.service_item,
          agency: p.agency,
          assignee: p.assignee ?? null,
          status: "PENDING",
          sla_due_at: p.sla_due_at,
          breached: false,
          missing_items: [],
        });
        break;
      case "REFERRAL_ISSUED":
        referrals.set(p.referral_id, { referral_id: p.referral_id, ...p, status: "ISSUED" });
        break;
      case "REFERRAL_ACCEPTED":
      case "REFERRAL_DECLINED":
      case "REFERRAL_RETURNED":
      case "REFERRAL_CLOSED_LOOP":
        if (referrals.get(p.referral_id)) {
          referrals.get(p.referral_id).status = e.event_type.replace("REFERRAL_", "");
        }
        break;
      case "TASK_STAGE_CHANGED": {
        const task = tasks.get(p.task_id);
        if (task) {
          task.status = p.status;
          if (p.missing_items) task.missing_items = p.missing_items;
        }
        break;
      }
      case "TASK_SLA_BREACHED":
        if (tasks.get(p.task_id)) tasks.get(p.task_id).breached = true;
        break;
      case "SUPPLEMENT_REQUESTED":
        if (tasks.get(p.task_id)) tasks.get(p.task_id).missing_items = p.missing_items;
        break;
      case "SUPPLEMENT_RECEIVED":
        if (tasks.get(p.task_id)) tasks.get(p.task_id).missing_items = [];
        break;
      case "DOCUMENT_DECLARED":
        documents.set(p.document_id, { document_id: p.document_id, doc_type: p.doc_type, valid_until: p.valid_until ?? null, purposes: [], blocked: false });
        break;
      case "CONSENT_GRANTED":
        if (documents.get(p.document_id)) {
          documents.get(p.document_id).purposes.push(...p.purposes);
        }
        break;
      case "DOCUMENT_EXPIRED":
      case "CONSENT_REVOKED":
        if (documents.get(p.document_id)) documents.get(p.document_id).blocked = true;
        break;
      case "POLICY_HINTED":
        eligibility.set(p.policy_code, { policy_code: p.policy_code, state: "HINTED", agency: null, valid_until: null });
        break;
      case "ELIGIBILITY_CONFIRMED":
        eligibility.set(p.policy_code, { policy_code: p.policy_code, state: "CONFIRMED", agency: p.agency, valid_until: p.valid_until });
        break;
      case "ELIGIBILITY_DENIED":
        eligibility.set(p.policy_code, { policy_code: p.policy_code, state: "DENIED", agency: p.agency, valid_until: null });
        break;
      case "ELIGIBILITY_EXPIRED":
      case "ELIGIBILITY_REVOKED":
        if (eligibility.get(p.policy_code)) eligibility.get(p.policy_code).state = "INACTIVE";
        break;
      default:
        break;
    }
  }

  return {
    case_id: caseId,
    tasks: [...tasks.values()],
    referrals: [...referrals.values()],
    documents: [...documents.values()],
    eligibility: [...eligibility.values()],
    completed: inCase.some((e) => e.event_type === "CASE_COMPLETED"),
  };
}

/**
 * 管理者视图：区分服务究竟卡在"转介"（发出后无人受理）
 * 还是"回执"（受理/办完后结果未回到主理窗口），并列示时限与补正滞留。
 */
export function bottlenecks(events, now = new Date().toISOString()) {
  const at = Date.parse(now);
  const referrals = new Map();
  const tasks = new Map();

  for (const e of [...events].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "REFERRAL_ISSUED":
        referrals.set(p.referral_id, { issued: e, accepted: null, closed: null, returned: 0 });
        break;
      case "REFERRAL_ACCEPTED":
        if (referrals.get(p.referral_id)) referrals.get(p.referral_id).accepted = e;
        break;
      case "REFERRAL_RETURNED":
        if (referrals.get(p.referral_id)) referrals.get(p.referral_id).returned += 1;
        break;
      case "REFERRAL_CLOSED_LOOP":
        if (referrals.get(p.referral_id)) referrals.get(p.referral_id).closed = e;
        break;
      case "TASK_ASSIGNED":
        tasks.set(p.task_id, { assigned: e, stage: "PENDING", breached: false });
        break;
      case "TASK_STAGE_CHANGED":
        if (tasks.get(p.task_id)) tasks.get(p.task_id).stage = p.status;
        break;
      case "TASK_SLA_BREACHED":
        if (tasks.get(p.task_id)) tasks.get(p.task_id).breached = true;
        break;
      default:
        break;
    }
  }

  const stuckAtReferral = [];
  const stuckAtReceipt = [];
  for (const [id, r] of referrals) {
    if (!r.accepted) {
      const days = r.issued.payload.expected_response_days;
      const overdue = !days || Date.parse(r.issued.occurred_at) + days * 86400000 < at;
      if (overdue) stuckAtReferral.push({ referral_id: id, to_agency: r.issued.payload.to_agency });
    } else if (!r.closed) {
      stuckAtReceipt.push({ referral_id: id, from_agency: r.issued.payload.from_agency, returned: r.returned });
    }
  }

  const taskAlerts = [...tasks.values()]
    .filter((t) => t.breached || ["AWAITING_SUPPLEMENT", "SUSPENDED", "PENDING", "IN_PROGRESS"].includes(t.stage))
    .map((t) => ({
      task_id: t.assigned.payload.task_id,
      service_item: t.assigned.payload.service_item,
      agency: t.assigned.payload.agency,
      stage: t.stage,
      breached: t.breached,
      sla_due_at: t.assigned.payload.sla_due_at,
    }));

  return {
    stuck_at_referral: stuckAtReferral,
    stuck_at_receipt: stuckAtReceipt,
    task_alerts: taskAlerts,
    summary: {
      referral_count: referrals.size,
      stuck_referral: stuckAtReferral.length,
      stuck_receipt: stuckAtReceipt.length,
      open_or_overdue_tasks: taskAlerts.length,
    },
  };
}

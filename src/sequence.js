import {
  DECISION_EVENTS,
  EVENT_TYPES,
  STAGE_ORDER,
  STAGES,
} from "./catalog.js";
import { validateEvent } from "./validator.js";

const {
  SERVICE_CASE_OPENED,
  SERVICE_MATCHED,
  POLICY_ELIGIBILITY_DECIDED,
  DOCUMENT_DECLARED,
  DOCUMENT_EXPIRED,
  DOCUMENT_WITHDRAWN,
  CONSENT_GRANTED,
  CONSENT_REVOKED,
  REFERRAL_ISSUED,
  REFERRAL_ACCEPTED,
  REFERRAL_REJECTED,
  RECEIPT_ISSUED,
  TASK_ASSIGNED,
  TASK_DEADLINE_PROMISED,
  TASK_MATERIAL_REQUESTED,
  MATERIAL_SUBMITTED,
  HANDLING_RESULT_RECORDED,
  CASE_STAGE_ADVANCED,
  CASE_COMPLETED,
  CASE_TRANSFER_REQUESTED,
  CASE_TRANSFER_EXPORTED,
  CASE_EXPORT_LOCKED,
} = EVENT_TYPES;

// 阶段消费证明时对应的授权用途（按用途授权，不得跨用途挪用）。
const STAGE_PURPOSE = {
  [STAGES.PROJECT_COOPERATION]: "project_selection",
  [STAGES.BUSINESS_REGISTRATION]: "business_registration",
  [STAGES.SOCIAL_INSURANCE]: "social_insurance",
  [STAGES.EMPLOYMENT]: "employment_filing",
  [STAGES.LOAN]: "loan_review",
  [STAGES.LEGAL_CONSULTING]: "legal_aid",
};

// 导出锁定之后，原机构不得再发生的“新办理”事件。
const NEW_HANDLING_EVENTS = new Set([
  REFERRAL_ISSUED,
  REFERRAL_ACCEPTED,
  RECEIPT_ISSUED,
  TASK_ASSIGNED,
  TASK_DEADLINE_PROMISED,
  TASK_MATERIAL_REQUESTED,
  POLICY_ELIGIBILITY_DECIDED,
  EVENT_TYPES.PROJECT_SELECTION_DECIDED,
  EVENT_TYPES.REGISTRATION_DECIDED,
  EVENT_TYPES.LOAN_DECIDED,
  HANDLING_RESULT_RECORDED,
]);

function parseTime(value) {
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// ---------------------------------------------------------------------------
// 序列不变量校验
// ---------------------------------------------------------------------------

export function validateSequence(events) {
  const errors = [];
  const push = (i, message) => errors.push({ index: i, event_id: events[i]?.event_id ?? null, message });

  if (!Array.isArray(events)) return [{ index: null, event_id: null, message: "事件序列必须是数组" }];

  const seenEventIds = new Set();
  const versions = new Map(); // aggregate_id -> 上一个 version
  const prevTime = { value: null };

  let caseId = null;
  let personId = null;

  const documents = new Map(); // document_id -> {validUntil, expiredAt, withdrawnAt, stages: Set}
  const grants = new Map(); // consent_id -> grant
  const suggestions = new Map(); // eligibility_code -> matched 事件序号
  const referrals = new Map(); // referral_id -> {issued, acceptedAt, rejectedAt}
  const tasks = new Map(); // task_id -> {stage, agencyId, assignedAt, receiptAt, resultAt, missing:Set, submitted:Set}
  const transfer = { requested: false, selected: new Set(), exported: false, lockedAt: null };

  events.forEach((e, i) => {
    const at = parseTime(e?.occurred_at);

    for (const msg of validateEvent(e)) push(i, msg);

    if (e?.event_id !== undefined) {
      if (seenEventIds.has(e.event_id)) push(i, `event_id 重复：${e.event_id}`);
      seenEventIds.add(e.event_id);
    }

    // 时间与版本
    if (at !== null) {
      if (prevTime.value !== null && at < prevTime.value) push(i, "occurred_at 早于前一事件，日志必须按时间递增");
      prevTime.value = at;
    }
    if (e?.aggregate_id && versions.has(e.aggregate_id) && e.version <= versions.get(e.aggregate_id)) {
      push(i, `聚合 ${e.aggregate_id} 的 version 必须严格递增`);
    }
    if (e?.aggregate_id) versions.set(e.aggregate_id, e.version);

    // 申请人与连续案件归属
    if (e?.person_id) {
      if (personId && personId !== e.person_id) push(i, "序列中的 person_id 不一致");
      personId = e.person_id;
    } else {
      push(i, "缺少 person_id");
    }
    if (caseId) {
      if (!e.case_id) push(i, "立案后的事件必须携带 case_id");
      else if (e.case_id !== caseId) push(i, `case_id 与案件 ${caseId} 不一致`);
    } else if (e.event_type === SERVICE_CASE_OPENED) {
      if (!e.case_id) push(i, "SERVICE_CASE_OPENED 必须携带 case_id");
      caseId = e.case_id;
    }

    const p = e?.payload ?? {};
    const actorAgency = e?.actor?.agency_id ?? p.recipient_agency ?? p.agency_id ?? null;

    // -- 材料声明 / 过期 / 撤回 -------------------------------------------------
    if (e?.event_type === DOCUMENT_DECLARED) {
      if (!p.document_id) push(i, "DOCUMENT_DECLARED 缺少 payload.document_id");
      else if (!documents.has(p.document_id)) {
        documents.set(p.document_id, {
          validUntil: p.valid_until ? parseTime(p.valid_until) : null,
          expiredAt: null,
          withdrawnAt: null,
          stages: new Set(),
        });
      }
    }
    if (e?.event_type === DOCUMENT_EXPIRED || e?.event_type === DOCUMENT_WITHDRAWN) {
      const doc = documents.get(p.document_id);
      if (!doc) {
        push(i, `${e.event_type} 引用了未声明的材料：${p.document_id}`);
      } else if (e.event_type === DOCUMENT_EXPIRED) {
        doc.expiredAt = at;
      } else {
        if (doc.withdrawnAt) push(i, `材料已撤回，不能重复撤回：${p.document_id}`);
        doc.withdrawnAt = at;
      }
    }

    // -- 授权：按用途、按收件机构、限期、可撤回 ----------------------------------
    if (e?.event_type === CONSENT_GRANTED) {
      const validUntil = parseTime(p.valid_until);
      if (!p.consent_id) push(i, "CONSENT_GRANTED 缺少 payload.consent_id");
      if (!p.purpose) push(i, "CONSENT_GRANTED 缺少 payload.purpose");
      if (!actorAgency) push(i, "CONSENT_GRANTED 缺少收件机构 agency_id");
      if (!Array.isArray(p.document_ids) || p.document_ids.length === 0) {
        push(i, "CONSENT_GRANTED 必须明确授权复用的 document_ids");
      } else {
        for (const id of p.document_ids) {
          if (!documents.has(id)) push(i, `授权引用了未声明的材料：${id}`);
        }
      }
      if (validUntil === null) push(i, "授权必须给出 valid_until，证明不得被无期限复用");
      if (at !== null && validUntil !== null && validUntil <= at) push(i, "授权有效期必须晚于授权时间");
      if (p.consent_id && !grants.has(p.consent_id)) {
        grants.set(p.consent_id, {
          documentIds: new Set(p.document_ids ?? []),
          purpose: p.purpose,
          recipientAgency: actorAgency,
          grantedAt: at,
          validUntil,
          revokedAt: null,
        });
      }
    }
    if (e?.event_type === CONSENT_REVOKED) {
      const g = grants.get(p.consent_id);
      if (!g) push(i, `撤回引用了不存在的授权：${p.consent_id}`);
      else if (g.revokedAt) push(i, `授权已撤回，不能重复撤回：${p.consent_id}`);
      else g.revokedAt = at;
    }

    // -- 规则引擎只能建议，机构才能决定 ------------------------------------------
    if (e?.event_type === SERVICE_MATCHED) {
      if (e.actor?.actor_kind !== "rule_engine") push(i, "SERVICE_MATCHED 只能由 rule_engine 产生");
      if ("outcome" in p) push(i, "规则匹配不得携带决定结论 outcome，它只能提示可能适用的政策");
      if (!p.eligibility_code) push(i, "SERVICE_MATCHED 缺少 payload.eligibility_code");
      if (p.eligibility_code) suggestions.set(p.eligibility_code, i);
    }
    if (DECISION_EVENTS.has(e?.event_type)) {
      if (e.actor?.actor_kind !== "responsible_agency") {
        push(i, `${e.event_type} 必须由 responsible_agency 决定，规则引擎或窗口无权决定`);
      }
      if (!p.outcome) push(i, `${e.event_type} 缺少 payload.outcome`);
      if (!actorAgency) push(i, `${e.event_type} 缺少决定机构 agency_id`);
      if (e.event_type === POLICY_ELIGIBILITY_DECIDED) {
        if (!suggestions.has(p.eligibility_code)) {
          push(i, `资格决定缺少对应的规则提示：${p.eligibility_code}（提示仍不构成资格）`);
        }
      }
    }

    // -- 授权闸门：机构办理时复用证明，必须用途相符、授权有效、材料可用 ------------
    if (Array.isArray(p.used_documents) && p.used_documents.length > 0) {
      const purpose = p.purpose ?? STAGE_PURPOSE[e?.case_stage];
      if (!purpose) {
        push(i, "复用材料时缺少 payload.purpose");
      } else if (!actorAgency) {
        push(i, "复用材料时缺少办理机构 agency_id");
      } else {
        for (const docId of p.used_documents) {
          const doc = documents.get(docId);
          if (!doc) {
            push(i, `办理使用了未声明的材料：${docId}`);
            continue;
          }
          doc.stages.add(e.case_stage);
          if (doc.withdrawnAt !== null) {
            push(i, `材料 ${docId} 已被申请人撤回，必须立即停止新办理`);
            continue;
          }
          if (doc.expiredAt !== null || (doc.validUntil !== null && doc.validUntil <= at)) {
            push(i, `材料 ${docId} 已过期，必须立即停止新办理`);
            continue;
          }
          const cover = [...grants.values()].find(
            (g) =>
              g.documentIds.has(docId) &&
              g.purpose === purpose &&
              g.recipientAgency === actorAgency &&
              g.grantedAt <= at &&
              g.revokedAt === null &&
              g.validUntil > at,
          );
          if (!cover) {
            push(i, `材料 ${docId} 未经 ${purpose} 用途对 ${actorAgency} 的有效授权，不得复用`);
          }
        }
      }
    }

    // -- 转介与回执生命周期 ------------------------------------------------------
    if (e?.event_type === REFERRAL_ISSUED) {
      if (!p.referral_id) push(i, "REFERRAL_ISSUED 缺少 referral_id");
      else referrals.set(p.referral_id, { issuedAt: at, acceptedAt: null, rejectedAt: null });
    }
    if (e?.event_type === REFERRAL_ACCEPTED || e?.event_type === REFERRAL_REJECTED) {
      const r = referrals.get(p.referral_id);
      if (!r) push(i, `${e.event_type} 引用了未发出的转介：${p.referral_id}`);
      else if (r.acceptedAt || r.rejectedAt) push(i, `转介 ${p.referral_id} 已受理/退回，不能重复处理`);
      else if (e.event_type === REFERRAL_ACCEPTED) r.acceptedAt = at;
      else r.rejectedAt = at;
    }
    if (e?.event_type === RECEIPT_ISSUED) {
      if (p.referral_id) {
        const r = referrals.get(p.referral_id);
        if (!r) push(i, `回执引用了未发出的转介：${p.referral_id}`);
        else if (!r.acceptedAt) push(i, `转介 ${p.referral_id} 尚未受理，不能出具回执`);
        else if (r.rejectedAt) push(i, `转介 ${p.referral_id} 已被退回，不能出具回执`);
      }
      if (p.task_id && tasks.has(p.task_id)) tasks.get(p.task_id).receiptAt = at;
    }

    // -- 任务生命周期：指派 -> 回执 -> 补材料/承诺时限 -> 办理结果 ------------------
    if (e?.event_type === TASK_ASSIGNED) {
      if (!p.task_id) push(i, "TASK_ASSIGNED 缺少 task_id");
      else tasks.set(p.task_id, {
        stage: e.case_stage,
        agencyId: actorAgency,
        assigneeId: p.assignee_id ?? null,
        assignedAt: at,
        promisedDeadline: null,
        receiptAt: null,
        resultAt: null,
        missing: new Set(),
        submitted: new Set(),
      });
    }
    const task = p.task_id ? tasks.get(p.task_id) : null;
    if ([TASK_DEADLINE_PROMISED, TASK_MATERIAL_REQUESTED, MATERIAL_SUBMITTED, HANDLING_RESULT_RECORDED].includes(e?.event_type)) {
      if (!task) {
        push(i, `${e.event_type} 引用了未指派的任务：${p.task_id}`);
      }
    }
    if (task) {
      if (e.event_type === TASK_DEADLINE_PROMISED) {
        if (!p.promised_deadline) push(i, "TASK_DEADLINE_PROMISED 缺少 promised_deadline");
        else task.promisedDeadline = parseTime(p.promised_deadline);
      }
      if (e.event_type === TASK_MATERIAL_REQUESTED) {
        for (const m of p.missing_materials ?? []) task.missing.add(m);
      }
      if (e.event_type === MATERIAL_SUBMITTED) {
        for (const id of p.document_ids ?? []) {
          task.submitted.add(id);
          task.missing.delete(id);
        }
      }
      if (e.event_type === HANDLING_RESULT_RECORDED) {
        if (!task.receiptAt) push(i, `任务 ${p.task_id} 未出具受理回执，不能登记办理结果`);
        if (task.missing.size > 0) push(i, `任务 ${p.task_id} 尚有缺件未补齐：${[...task.missing].join("、")}`);
        task.resultAt = at;
      }
    }

    // -- 阶段推进：顺序固定，且前一阶段须有办理结果 -------------------------------
    if (e?.event_type === CASE_STAGE_ADVANCED) {
      const cur = STAGE_ORDER.indexOf(p.from_stage);
      const nxt = STAGE_ORDER.indexOf(p.to_stage);
      if (cur < 0 || nxt < 0) push(i, "阶段推进引用了未知阶段");
      else if (nxt !== cur + 1) push(i, `阶段只能推进到紧邻的下一阶段：${p.from_stage} -> ${p.to_stage}`);
      else {
        const stageDone = [...tasks.values()].some((t) => t.stage === p.from_stage && t.resultAt !== null);
        if (!stageDone) push(i, `阶段 ${p.from_stage} 尚无办理结果，不能进入 ${p.to_stage}`);
      }
    }

    // -- 跨城迁移：本人勾选 -> 导出子集 -> 原机构锁定仅留审计 ----------------------
    if (e?.event_type === CASE_TRANSFER_REQUESTED) {
      if (e.actor?.actor_kind !== "applicant") push(i, "跨城迁移必须由申请人本人发起");
      if (!Array.isArray(p.selected_documents)) push(i, "迁移必须由本人选择随案资料 selected_documents");
      else for (const id of p.selected_documents) {
        if (!documents.has(id)) push(i, `随案资料引用了未声明的材料：${id}`);
        transfer.selected.add(id);
      }
      if (!p.destination_city) push(i, "迁移缺少 destination_city");
      transfer.requested = true;
    }
    if (e?.event_type === CASE_TRANSFER_EXPORTED) {
      if (!transfer.requested) push(i, "未经申请人迁移请求，不能导出随案资料");
      for (const id of p.document_ids ?? []) {
        if (!transfer.selected.has(id)) push(i, `导出了申请人未勾选的资料：${id}`);
      }
      transfer.exported = true;
    }
    if (e?.event_type === CASE_EXPORT_LOCKED) {
      transfer.lockedAt = at;
    }
    if (transfer.lockedAt !== null && NEW_HANDLING_EVENTS.has(e?.event_type) && at >= transfer.lockedAt) {
      push(i, "案件已随迁导出并锁定，原机构只能保留审计记录，不得开展新办理");
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// 读模型：申请人看“谁在办、缺什么、时限”；管理者看“卡在转介还是回执”
// ---------------------------------------------------------------------------

export function buildCaseState(events, options = {}) {
  const asOf = options.asOf ? Date.parse(options.asOf) : (events.length ? Date.parse(events[events.length - 1].occurred_at) : Date.now());

  const tasks = new Map();
  const referrals = new Map();
  const grants = new Map();
  const documents = new Map();
  const suggestions = [];
  let caseId = null;
  let personId = null;
  let currentStage = STAGES.TALENT_REGISTRY;
  let status = "open";
  const transfer = { requested: false, exported: false, lockedAt: null, destinationCity: null, selected: [] };

  for (const e of events) {
    const p = e.payload ?? {};
    const at = Date.parse(e.occurred_at);
    if (at > asOf) break; // 事件按时间递增；视图只回放截至 asOf 的事实
    if (e.case_id) caseId = e.case_id;
    if (e.person_id) personId = e.person_id;
    const agencyId = e.actor?.agency_id ?? p.agency_id ?? p.recipient_agency ?? null;

    switch (e.event_type) {
      case DOCUMENT_DECLARED:
        documents.set(p.document_id, { document_id: p.document_id, validUntil: p.valid_until ?? null });
        break;
      case CONSENT_GRANTED:
        grants.set(p.consent_id, { ...p, granted_at: e.occurred_at });
        break;
      case SERVICE_MATCHED:
        suggestions.push({ eligibility_code: p.eligibility_code, reason: p.reason ?? null, decided: null });
        break;
      case POLICY_ELIGIBILITY_DECIDED: {
        const s = suggestions.find((x) => x.eligibility_code === p.eligibility_code);
        if (s) s.decided = { outcome: p.outcome, by: p.decision_agency ?? agencyId };
        break;
      }
      case REFERRAL_ISSUED:
        referrals.set(p.referral_id, {
          referral_id: p.referral_id,
          from_agency: p.from_agency,
          to_agency: p.to_agency,
          stage: e.case_stage,
          issued_at: e.occurred_at,
          accepted_at: null,
          rejected_at: null,
          receipt_at: null,
          first_result_at: null,
        });
        break;
      case REFERRAL_ACCEPTED:
        if (referrals.has(p.referral_id)) referrals.get(p.referral_id).accepted_at = e.occurred_at;
        break;
      case REFERRAL_REJECTED:
        if (referrals.has(p.referral_id)) referrals.get(p.referral_id).rejected_at = e.occurred_at;
        break;
      case RECEIPT_ISSUED:
        if (p.referral_id && referrals.has(p.referral_id)) referrals.get(p.referral_id).receipt_at = e.occurred_at;
        if (p.task_id && tasks.has(p.task_id)) {
          const t = tasks.get(p.task_id);
          t.receipt_at = e.occurred_at;
          t.referral_id = p.referral_id ?? t.referral_id ?? null;
        }
        break;
      case TASK_ASSIGNED:
        tasks.set(p.task_id, {
          task_id: p.task_id,
          stage: e.case_stage,
          agency_id: agencyId,
          assignee_id: p.assignee_id ?? null,
          assigned_at: e.occurred_at,
          promised_deadline: null,
          receipt_at: null,
          result_at: null,
          outcome: null,
          referral_id: null,
          missing_materials: [],
          submitted_documents: [],
        });
        break;
      case TASK_DEADLINE_PROMISED:
        if (tasks.has(p.task_id)) tasks.get(p.task_id).promised_deadline = p.promised_deadline;
        break;
      case TASK_MATERIAL_REQUESTED:
        if (tasks.has(p.task_id)) {
          for (const m of p.missing_materials ?? []) {
            const t = tasks.get(p.task_id);
            if (!t.missing_materials.includes(m)) t.missing_materials.push(m);
          }
        }
        break;
      case MATERIAL_SUBMITTED:
        if (tasks.has(p.task_id)) {
          const t = tasks.get(p.task_id);
          for (const id of p.document_ids ?? []) {
            t.submitted_documents.push(id);
            t.missing_materials = t.missing_materials.filter((m) => m !== id);
          }
        }
        break;
      case HANDLING_RESULT_RECORDED: {
        const t = tasks.get(p.task_id);
        if (t) {
          t.result_at = e.occurred_at;
          t.outcome = p.outcome ?? t.outcome;
          if (!t.receipt_at && p.referral_id && referrals.has(p.referral_id)) {
            t.receipt_at = referrals.get(p.referral_id).receipt_at;
          }
        }
        // 办理结果事件本身不重复携带 referral_id 时，经由任务上的回执关联回填首笔结果时间。
        const referralId = p.referral_id ?? t?.referral_id ?? null;
        if (referralId && referrals.has(referralId) && !referrals.get(referralId).first_result_at) {
          referrals.get(referralId).first_result_at = e.occurred_at;
        }
        break;
      }
      case CASE_STAGE_ADVANCED:
        currentStage = p.to_stage;
        break;
      case CASE_COMPLETED:
        status = "completed";
        break;
      case CASE_TRANSFER_REQUESTED:
        transfer.requested = true;
        transfer.destinationCity = p.destination_city;
        transfer.selected = [...(p.selected_documents ?? [])];
        break;
      case CASE_TRANSFER_EXPORTED:
        transfer.exported = true;
        break;
      case CASE_EXPORT_LOCKED:
        transfer.lockedAt = e.occurred_at;
        status = "transferred";
        break;
      default:
        break;
    }
  }

  return { tasks, referrals, grants, documents, suggestions, caseId, personId, currentStage, status, transfer, asOf };
}

// 申请人视图：每个在办事项由谁处理、尚缺什么、承诺时限与是否超期。
export function caseOverview(events, options) {
  const s = buildCaseState(events, options);
  const taskList = [...s.tasks.values()].map((t) => {
    const deadline = t.promised_deadline ? Date.parse(t.promised_deadline) : null;
    let state;
    if (t.result_at) state = "done";
    else if (t.missing_materials.length > 0) state = "awaiting_materials";
    else if (!t.receipt_at) state = "awaiting_receipt";
    else state = "in_progress";
    return {
      task_id: t.task_id,
      stage: t.stage,
      agency_id: t.agency_id,
      assignee_id: t.assignee_id,
      state,
      missing_materials: t.missing_materials,
      promised_deadline: t.promised_deadline,
      overdue: deadline !== null && !t.result_at && deadline < s.asOf,
      receipt_at: t.receipt_at,
      result_at: t.result_at,
    };
  });

  return {
    case_id: s.caseId,
    person_id: s.personId,
    current_stage: s.currentStage,
    status: s.status,
    tasks: taskList,
    open_missing: taskList.filter((t) => t.state === "awaiting_materials"),
    overdue_tasks: taskList.filter((t) => t.overdue),
    transfer: s.transfer,
  };
}

// 管理者视图：逐笔转介的停留时长与卡点分类；并汇总瓶颈计数。
export function referralTimeline(events, options) {
  const s = buildCaseState(events, options);
  const rows = [...s.referrals.values()].map((r) => {
    const issued = Date.parse(r.issued_at);
    const accepted = r.accepted_at ? Date.parse(r.accepted_at) : null;
    const receipt = r.receipt_at ? Date.parse(r.receipt_at) : null;
    const result = r.first_result_at ? Date.parse(r.first_result_at) : null;
    const rejected = r.rejected_at ? Date.parse(r.rejected_at) : null;

    // 卡点：被退回 / 转介后未受理 / 已受理未回执 / 已回执未出结果 / 已办结
    let bottleneck = null;
    if (rejected) bottleneck = "rejected";
    else if (!accepted) bottleneck = "referral";
    else if (!receipt) bottleneck = "receipt";
    else if (!result) bottleneck = "handling";

    return {
      referral_id: r.referral_id,
      stage: r.stage,
      from_agency: r.from_agency,
      to_agency: r.to_agency,
      issued_at: r.issued_at,
      accepted_at: r.accepted_at,
      rejected_at: r.rejected_at,
      receipt_at: r.receipt_at,
      first_result_at: r.first_result_at,
      referral_dwell_ms: accepted ? accepted - issued : s.asOf - issued, // 卡在转介
      receipt_dwell_ms: accepted && receipt ? receipt - accepted : null, // 卡在回执
      handling_dwell_ms: receipt && result ? result - receipt : null,
      bottleneck,
    };
  });

  const bottleneck_counts = rows.reduce((acc, r) => {
    if (r.bottleneck) acc[r.bottleneck] = (acc[r.bottleneck] ?? 0) + 1;
    return acc;
  }, {});

  return { rows, bottleneck_counts, as_of: new Date(s.asOf).toISOString() };
}

// 资格/材料过期监视：过期项通知尚未办理的下游阶段，避免“过期无人通知下一环节”。
export function expiryWatch(events, options = {}) {
  const s = buildCaseState(events, options);
  const leadMs = (options.lead_days ?? 30) * 24 * 60 * 60 * 1000;
  const alerts = [];

  // 重建材料被使用过的阶段（buildCaseState 未保留该集合，这里从事件再扫一次）
  const usedStages = new Map();
  for (const e of events) {
    if (Date.parse(e.occurred_at) > s.asOf) break;
    for (const id of e.payload?.used_documents ?? []) {
      if (!usedStages.has(id)) usedStages.set(id, new Set());
      usedStages.get(id).add(e.case_stage);
    }
  }

  for (const [id, doc] of s.documents) {
    if (!doc.validUntil) continue;
    const until = Date.parse(doc.validUntil);
    let level;
    if (until <= s.asOf) level = "expired";
    else if (until - s.asOf <= leadMs) level = "expiring";
    else continue;

    const knownStageIndex = Math.max(-1, ...[...(usedStages.get(id) ?? [])].map((st) => STAGE_ORDER.indexOf(st)));
    const notify_stages = STAGE_ORDER.slice(knownStageIndex + 1);
    alerts.push({ document_id: id, level, valid_until: doc.validUntil, notify_stages });
  }

  for (const g of s.grants.values()) {
    if (!g.valid_until) continue;
    const until = Date.parse(g.valid_until);
    let gLevel;
    if (until <= s.asOf) gLevel = "expired";
    else if (until - s.asOf <= leadMs) gLevel = "expiring";
    else continue;
    alerts.push({
      consent_id: g.consent_id,
      level: gLevel,
      purpose: g.purpose,
      recipient_agency: g.recipient_agency,
      valid_until: g.valid_until,
    });
  }

  return alerts;
}

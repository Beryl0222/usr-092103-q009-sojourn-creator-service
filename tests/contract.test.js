import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";
import {
  buildCaseState,
  caseOverview,
  expiryWatch,
  referralTimeline,
  validateSequence,
} from "../src/sequence.js";
import { EVENT_TYPES } from "../src/catalog.js";

const load = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));

// 在指定 event_id 后插入或替换事件的辅助函数，便于构造违规序列。
function clone(events) {
  return events.map((e) => structuredClone(e));
}
function afterId(events, id, patch) {
  const i = events.findIndex((e) => e.event_id === id);
  const next = clone(events);
  next.splice(i + 1, 0, { ...structuredClone(next[i]), version: next[i].version + 1, occurred_at: next[i].occurred_at, ...patch });
  return next;
}

test("最小样例符合公共信封约定", async () => {
  const sample = await load("../data/sample.json");
  assert.deepEqual(validateEvent(sample), []);
});

test("全流程连续案件样例通过全部序列不变量", async () => {
  const seq = await load("../data/continuous-case.sequence.json");
  for (const e of seq) assert.deepEqual(validateEvent(e), [], `事件 ${e.event_id} 信封校验失败`);
  assert.deepEqual(validateSequence(seq), []);
});

test("规则引擎只能建议，资格/注册/贷款由责任机构决定", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  // 规则引擎不得直接作资格决定
  const engineDecides = afterId(seq, "e10", {
    event_id: "x1",
    event_type: EVENT_TYPES.POLICY_ELIGIBILITY_DECIDED,
    aggregate_type: "policy_eligibility",
    aggregate_id: "ELIG-PROJ-01",
    actor: { actor_kind: "rule_engine" },
    payload: { eligibility_code: "ELIG-PROJ-01", outcome: "approved" },
  });
  const errs1 = validateSequence(engineDecides).map((e) => e.message);
  assert.ok(errs1.some((m) => m.includes("responsible_agency")), "规则引擎决定必须被拒");

  // 规则提示不得带结论
  const suggestWithOutcome = clone(seq);
  suggestWithOutcome.find((e) => e.event_id === "e10").payload.outcome = "approved";
  const errs2 = validateSequence(suggestWithOutcome).map((e) => e.message);
  assert.ok(errs2.some((m) => m.includes("不得携带决定结论")));

  // 机构决定必须先有对应规则提示
  const noMatch = clone(seq);
  noMatch.find((e) => e.event_id === "e20").payload.eligibility_code = "ELIG-UNKNOWN";
  const errs3 = validateSequence(noMatch).map((e) => e.message);
  assert.ok(errs3.some((m) => m.includes("缺少对应的规则提示")));
});

test("同一证明按用途与收件机构授权复用，跨用途或无授权即拒", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  // 项目材料授权不能挪作贷款用途：把银行的身份材料授权删掉
  const noLoanConsent = clone(seq).filter((e) => e.event_id !== "e52");
  const errs = validateSequence(noLoanConsent).map((e) => e.message);
  assert.ok(
    errs.some((m) => m.includes("DOC-01") && m.includes("loan_review")),
    "缺少贷款用途授权时应拒绝复用 DOC-01",
  );

  // 授权给 AG-PROJ 不能被 AG-MR 使用：替换注册环节的授权收件机构
  const wrongAgency = clone(seq);
  const regConsent = wrongAgency.find((e) => e.event_id === "e25");
  regConsent.payload.recipient_agency = "AG-PROJ";
  const errs2 = validateSequence(wrongAgency).map((e) => e.message);
  assert.ok(errs2.some((m) => m.includes("未经") && m.includes("business_registration")));

  // 无 valid_until 的无限期授权必须被拒
  const forever = clone(seq);
  delete forever.find((e) => e.event_id === "e11").payload.valid_until;
  const errs3 = validateSequence(forever).map((e) => e.message);
  assert.ok(errs3.some((m) => m.includes("不得被无期限复用")));
});

test("材料撤回或过期后立即阻断新办理", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  // 在社保办理前撤回身证明授权依赖的材料（e34 授权之后、e40 结果之前）
  const withdrawn = afterId(seq, "e34", {
    event_id: "x-withdraw",
    event_type: EVENT_TYPES.DOCUMENT_WITHDRAWN,
    aggregate_type: "document_assertion",
    aggregate_id: "DOC-01",
    summary: "申请人撤回身份证明",
    payload: { document_id: "DOC-01" },
  });
  const errs = validateSequence(withdrawn).map((e) => e.message);
  assert.ok(errs.some((m) => m.includes("DOC-01") && m.includes("撤回")));

  // 资格过期：把场所证明有效期改到注册之前
  const expired = clone(seq);
  expired.find((e) => e.event_id === "e07").payload.valid_until = "2026-08-01T00:00:00+08:00";
  const errs2 = validateSequence(expired).map((e) => e.message);
  assert.ok(errs2.some((m) => m.includes("DOC-04") && m.includes("过期")));
});

test("授权撤回立即生效，不能重复撤回", async () => {
  const seq = await load("../data/continuous-case.sequence.json");
  const doubleRevoke = afterId(seq, "e11", {
    event_id: "x-revoke",
    event_type: EVENT_TYPES.CONSENT_REVOKED,
    aggregate_type: "consent_grant",
    aggregate_id: "CONSENT-PROJ-1",
    summary: "撤回项目授权",
    payload: { consent_id: "CONSENT-PROJ-1" },
  });
  const errs = validateSequence(doubleRevoke).map((e) => e.message);
  // 撤回后后续项目遴选使用材料必须被阻断
  assert.ok(errs.some((m) => m.includes("未经") || m.includes("有效授权")));
});

test("未经申请人勾选的资料不得随案导出，导出锁定后原机构停办", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  // 尝试导出本人未勾选的资产证明
  const overExport = clone(seq);
  overExport.find((e) => e.event_id === "e76").payload.document_ids.push("DOC-05");
  overExport.find((e) => e.event_id === "e76").payload.used_documents.push("DOC-05");
  const errs = validateSequence(overExport).map((e) => e.message);
  assert.ok(errs.some((m) => m.includes("未勾选")));

  // 迁移必须本人发起
  const staffMoves = clone(seq);
  staffMoves.find((e) => e.event_id === "e74").actor = { actor_kind: "window_staff", agency_id: "AG-WINDOW" };
  const errs2 = validateSequence(staffMoves).map((e) => e.message);
  assert.ok(errs2.some((m) => m.includes("申请人本人发起")));

  // 锁定后再指派新任务必须被拒
  const afterLock = afterId(seq, "e78", {
    event_id: "x-newtask",
    event_type: EVENT_TYPES.TASK_ASSIGNED,
    aggregate_type: "case_task",
    aggregate_id: "TASK-FORBIDDEN",
    case_stage: "legal_consulting",
    summary: "锁定后原机构试图新办",
    actor: { actor_kind: "responsible_agency", agency_id: "AG-WINDOW" },
    payload: { task_id: "TASK-FORBIDDEN" },
  });
  const errs3 = validateSequence(afterLock).map((e) => e.message);
  assert.ok(errs3.some((m) => m.includes("锁定")));
});

test("阶段不可跳步，前一阶段无办理结果不能推进", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  const skip = clone(seq);
  const advance = skip.find((e) => e.event_id === "e33");
  advance.payload.from_stage = "business_registration";
  advance.payload.to_stage = "loan";
  const errs = validateSequence(skip).map((e) => e.message);
  assert.ok(errs.some((m) => m.includes("紧邻的下一阶段")));

  const noResult = clone(seq).filter((e) => e.event_id !== "e32");
  const errs2 = validateSequence(noResult).map((e) => e.message);
  assert.ok(errs2.some((m) => m.includes("尚无办理结果")));
});

test("无回执不能登记办理结果、未受理不能出回执", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  const noReceipt = clone(seq).filter((e) => e.event_id !== "e29");
  const errs = validateSequence(noReceipt).map((e) => e.message);
  assert.ok(errs.some((m) => m.includes("未出具受理回执")));

  const earlyReceipt = clone(seq).filter((e) => e.event_id !== "e27");
  const errs2 = validateSequence(earlyReceipt).map((e) => e.message);
  assert.ok(errs2.some((m) => m.includes("尚未受理")));
});

test("申请人视图：承办人、缺件、承诺时限与超期", async () => {
  const seq = await load("../data/continuous-case.sequence.json");

  // 截至贷款补件通知之后、补齐之前：应当看到缺件且未超期
  const view = caseOverview(seq, { asOf: "2026-09-27T00:00:00+08:00" });
  const loan = view.tasks.find((t) => t.task_id === "TASK-LOAN");
  assert.equal(loan.state, "awaiting_materials");
  assert.deepEqual(loan.missing_materials, ["DOC-07"]);
  assert.equal(loan.assignee_id, "staff-bank-03");
  assert.equal(loan.overdue, false);

  // 时间推进到承诺时限之后且结果未出：标记超期
  const overdueView = caseOverview(
    seq.filter((e) => !["e59", "e60", "e61", "e62", "e63", "e64", "e65"].includes(e.event_id)),
    { asOf: "2026-10-16T00:00:00+08:00" },
  );
  assert.ok(overdueView.overdue_tasks.some((t) => t.task_id === "TASK-LOAN"));

  // 终态视图：贷款被拒但案件办结，各环节承办机构齐全
  const done = caseOverview(seq);
  assert.equal(done.status, "transferred"); // 样例以跨城迁移收尾
  const loanDone = done.tasks.find((t) => t.task_id === "TASK-LOAN");
  assert.equal(loanDone.state, "done");
  assert.equal(loanDone.agency_id, "AG-BANK");
});

test("管理者视图：区分卡在转介、回执与已办结", async () => {
  const seq = await load("../data/continuous-case.sequence.json");
  const tl = referralTimeline(seq, { asOf: "2026-09-20T08:50:00+08:00" });

  const byId = Object.fromEntries(tl.rows.map((r) => [r.referral_id, r]));
  // 社保转介 9/20 08:40 已受理、09:05 才出回执 → 卡在回执；项目环节已办结
  assert.equal(byId["REF-SI-1"].bottleneck, "receipt");
  assert.equal(byId["REF-PROJ-1"].bottleneck, null);
  assert.ok(tl.bottleneck_counts.receipt >= 1);

  // 中午回执已出、结果未出 → 卡点转为办理
  const handling = referralTimeline(seq, { asOf: "2026-09-20T12:00:00+08:00" });
  assert.equal(handling.rows.find((r) => r.referral_id === "REF-SI-1").bottleneck, "handling");

  // 在转介已发出、未受理的时间点，卡点是 referral
  const early = referralTimeline(seq, { asOf: "2026-09-11T12:00:00+08:00" });
  assert.equal(early.rows.find((r) => r.referral_id === "REF-PROJ-1").bottleneck, "referral");
  assert.ok(early.rows.find((r) => r.referral_id === "REF-PROJ-1").referral_dwell_ms > 0);
});

test("过期预警通知尚未办理的下游阶段", async () => {
  const seq = await load("../data/continuous-case.sequence.json");
  // 2026-10-01：注册授权 10-31 临近、项目授权 12-31 尚远；资产证明 2027-06 不预警
  const alerts = expiryWatch(seq, { asOf: "2026-10-01T00:00:00+08:00", lead_days: 45 });
  const regConsent = alerts.find((a) => a.consent_id === "CONSENT-REG-1");
  assert.ok(regConsent, "临近到期的注册授权应被预警");

  // 到 2026-11-01，注册授权已过期：标记 expired
  const later = expiryWatch(seq, { asOf: "2026-11-01T00:00:00+08:00", lead_days: 45 });
  assert.equal(later.find((a) => a.consent_id === "CONSENT-REG-1").level, "expired");
});

test("JSON 契约与枚举目录保持一致", async () => {
  const schema = await load("../contracts/domain.schema.json");
  const catalog = await import("../src/catalog.js");
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...catalog.EVENT_TYPE_VALUES].sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), [...catalog.AGGREGATE_TYPE_VALUES].sort());
  assert.deepEqual([...schema.properties.case_stage.enum].sort(), [...catalog.STAGE_VALUES].sort());
});

test("读模型保留规则建议与机构决定的区别：贴息通过但银行仍可拒贷", async () => {
  const seq = await load("../data/continuous-case.sequence.json");
  const state = buildCaseState(seq);
  const loanSuggestion = state.suggestions.find((s) => s.eligibility_code === "ELIG-LOAN-01");
  assert.equal(loanSuggestion.decided.outcome, "approved"); // 贴息资格通过
  const loanTask = [...state.tasks.values()].find((t) => t.task_id === "TASK-LOAN");
  assert.equal(loanTask.outcome, "rejected"); // 授信决定独立：拒贷
});

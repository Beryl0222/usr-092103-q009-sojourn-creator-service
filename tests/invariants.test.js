import assert from "node:assert/strict";
import test from "node:test";

import { bottlenecks, validateEvent, validateStream } from "../src/validator.js";

let seq = 0;
function evt(over = {}) {
  seq += 1;
  return {
    event_id: `N-${seq}`,
    event_type: "DOCUMENT_SHARED",
    aggregate_type: "document_assertion",
    aggregate_id: `A-${seq}`,
    occurred_at: "2026-09-10T10:00:00+08:00",
    version: 1,
    summary: "测试事件",
    case_id: "C-1",
    person_id: "P-1",
    payload: {},
    ...over,
  };
}

const profile = () =>
  evt({
    event_type: "PROFILE_REGISTERED",
    aggregate_type: "talent_profile",
    aggregate_id: "P-1",
    payload: { person_id: "P-1", skills: ["扎染"], residence_stage: "TEMP_RESIDENCE" },
  });

const declared = (id = "D-1", validUntil = "2026-12-31T23:59:59+08:00") =>
  evt({
    event_type: "DOCUMENT_DECLARED",
    aggregate_id: id,
    payload: { document_id: id, doc_type: "证明", issued_by: "某部门", valid_until: validUntil },
  });

const consent = (id = "K-1", doc = "D-1", purposes = ["LOAN"], expiresAt = null) =>
  evt({
    event_type: "CONSENT_GRANTED",
    aggregate_type: "consent_grant",
    aggregate_id: id,
    payload: { consent_id: id, document_id: doc, purposes, expires_at: expiresAt },
  });

test("POLICY_HINTED 不得夹带批准结论，且遴选必须由机构决定", () => {
  const bad = validateEvent(
    evt({
      event_type: "POLICY_HINTED",
      aggregate_type: "policy_eligibility",
      aggregate_id: "PE-1",
      payload: { policy_code: "PC-1", matched_basis: ["命中标签"], decision: "APPROVED" },
    }),
  );
  assert.ok(bad.some((m) => m.includes("不得携带 decision")));

  const decided = [
    profile(),
    evt({
      event_type: "PROJECT_PROPOSAL_SUBMITTED",
      aggregate_type: "project_proposal",
      aggregate_id: "PP-1",
      payload: { proposal_id: "PP-1", title: "方案" },
    }),
  ];
  assert.deepEqual(validateStream(decided).errors, []);

  const ghost = [
    ...decided,
    evt({
      event_type: "PROJECT_SELECTION_DECIDED",
      aggregate_type: "project_proposal",
      aggregate_id: "PP-9",
      payload: { proposal_id: "PP-GHOST", agency: "CULTURE_TOURISM", decision: "SELECTED" },
    }),
  ];
  assert.ok(validateStream(ghost).errors.some((m) => m.includes("缺少对应的项目提案")));
});

test("同一证明按用途授权复用：无授权、超目的、过期、撤回一律拦截", () => {
  // 无授权直接复用
  assert.ok(
    validateStream([profile(), declared(), evt({ aggregate_id: "D-1", payload: { document_id: "D-1", purpose: "LOAN", target_agency: "RURAL_BANK" } })]).errors
      .some((m) => m.includes("未经有效授权")),
  );

  // 授权用途不含该用途
  const wrongPurpose = [
    profile(),
    declared(),
    consent("K-1", "D-1", ["SOCIAL_INSURANCE"]),
    evt({ aggregate_id: "D-1", version: 2, payload: { document_id: "D-1", purpose: "LOAN", target_agency: "RURAL_BANK" } }),
  ];
  assert.ok(validateStream(wrongPurpose).errors.some((m) => m.includes("禁止超目的复用")));

  // 证明已过期：过期事件之后任何复用都必须停止
  const expired = [
    profile(),
    evt({ ...declared("D-1", "2026-09-01T23:59:59+08:00"), occurred_at: "2026-08-25T10:00:00+08:00" }),
    evt({ ...consent(), occurred_at: "2026-08-25T10:05:00+08:00" }),
    evt({ event_type: "DOCUMENT_EXPIRED", aggregate_id: "D-1", version: 2, payload: { document_id: "D-1" }, occurred_at: "2026-09-02T00:00:00+08:00" }),
    evt({ aggregate_id: "D-1", version: 3, occurred_at: "2026-09-03T00:00:00+08:00", payload: { document_id: "D-1", purpose: "LOAN", target_agency: "RURAL_BANK" } }),
  ];
  assert.ok(validateStream(expired).errors.some((m) => m.includes("已过期或授权已撤回")));

  // 授权被撤回：立即停止新办理
  const revoked = [
    profile(),
    declared(),
    consent(),
    evt({ event_type: "CONSENT_REVOKED", aggregate_id: "K-1", version: 2, payload: { consent_id: "K-1", document_id: "D-1" }, occurred_at: "2026-09-11T00:00:00+08:00" }),
    evt({ aggregate_id: "D-1", version: 2, occurred_at: "2026-09-12T00:00:00+08:00", payload: { document_id: "D-1", purpose: "LOAN", target_agency: "RURAL_BANK" } }),
  ];
  assert.ok(validateStream(revoked).errors.some((m) => m.includes("已过期或授权已撤回")));

  // 授权自身有期限，到期后不能无期限复制
  const consentExpired = [
    profile(),
    declared(),
    consent("K-1", "D-1", ["LOAN"], "2026-09-01T00:00:00+08:00"),
    evt({ aggregate_id: "D-1", version: 2, occurred_at: "2026-09-12T00:00:00+08:00", payload: { document_id: "D-1", purpose: "LOAN", target_agency: "RURAL_BANK" } }),
  ];
  assert.ok(validateStream(consentExpired).errors.some((m) => m.includes("未经有效授权")));
});

test("阻断未解除时任务不得继续推进", () => {
  const blocked = [
    profile(),
    declared(),
    consent(),
    evt({
      event_type: "TASK_ASSIGNED",
      aggregate_type: "service_task",
      aggregate_id: "T-1",
      payload: { task_id: "T-1", service_item: "LOAN", agency: "RURAL_BANK", sla_due_at: "2026-09-30T18:00:00+08:00" },
    }),
    evt({
      event_type: "DOCUMENT_USE_BLOCKED",
      aggregate_id: "D-1",
      version: 2,
      payload: { document_id: "D-1", attempted_task_id: "T-1", attempted_purpose: "LOAN", reason: "REVOKED" },
    }),
    evt({
      event_type: "TASK_STAGE_CHANGED",
      aggregate_type: "service_task",
      aggregate_id: "T-1",
      version: 2,
      payload: { task_id: "T-1", status: "IN_PROGRESS" },
    }),
  ];
  assert.ok(validateStream(blocked).errors.some((m) => m.includes("材料阻断未解除")));
});

test("未经本人同意，个人画像不得用于招商筛选", () => {
  const noConsent = [
    profile(),
    declared(),
    consent("K-1", "D-1", ["INVESTMENT_SCREENING"]),
    evt({ aggregate_id: "D-1", version: 2, payload: { document_id: "D-1", purpose: "INVESTMENT_SCREENING", target_agency: "INVESTMENT_BUREAU" } }),
  ];
  assert.ok(validateStream(noConsent).errors.some((m) => m.includes("招商筛选")));

  // 明确同意后可以
  const allowed = [
    ...noConsent.slice(0, 3),
    evt({
      event_type: "PROFILING_CONSENT_UPDATED",
      aggregate_type: "talent_profile",
      aggregate_id: "P-1",
      version: 2,
      payload: { investment_screening_allowed: true },
    }),
    noConsent[3],
  ];
  assert.deepEqual(validateStream(allowed).errors, []);
});

test("跨城导出：本人勾选为边界，原机构只保留审计记录", () => {
  const request = evt({
    event_type: "CASE_EXPORT_REQUESTED",
    aggregate_type: "case_transfer",
    aggregate_id: "X-1",
    payload: { destination_city: "成都", selected_aggregates: ["talent_profile"] },
  });
  const overScope = [
    request,
    evt({
      event_type: "CASE_EXPORTED",
      aggregate_type: "case_transfer",
      aggregate_id: "X-1",
      version: 2,
      payload: {
        export_id: "E-1",
        destination_city: "成都",
        included_aggregates: ["talent_profile", "policy_eligibility"],
        audit_retention_until: "2031-10-03T23:59:59+08:00",
      },
    }),
  ];
  assert.ok(validateStream(overScope).errors.some((m) => m.includes("超出本人勾选范围")));

  const missingRetention = [
    request,
    evt({
      event_type: "CASE_EXPORTED",
      aggregate_type: "case_transfer",
      aggregate_id: "X-1",
      version: 2,
      payload: { export_id: "E-1", destination_city: "成都", included_aggregates: ["talent_profile"] },
    }),
  ];
  assert.ok(validateStream(missingRetention).errors.some((m) => m.includes("审计记录")));

  const withoutRequest = [
    evt({
      event_type: "CASE_EXPORTED",
      aggregate_type: "case_transfer",
      aggregate_id: "X-2",
      payload: {
        export_id: "E-2",
        destination_city: "成都",
        included_aggregates: ["talent_profile"],
        audit_retention_until: "2031-10-03T23:59:59+08:00",
      },
    }),
  ];
  assert.ok(validateStream(withoutRequest).errors.some((m) => m.includes("CASE_EXPORT_REQUESTED")));
});

test("转介链：未受理不得闭环；未发出不得回执", () => {
  const closeDirectly = [
    evt({
      event_type: "REFERRAL_CLOSED_LOOP",
      aggregate_type: "agency_receipt",
      aggregate_id: "R-1",
      payload: { referral_id: "R-X", result: "已办结" },
    }),
  ];
  assert.ok(validateStream(closeDirectly).errors.some((m) => m.includes("缺少对应的转介")));

  const closed = [
    evt({ event_type: "REFERRAL_ISSUED", aggregate_id: "R-1", payload: { referral_id: "R-1", from_agency: "CULTURE_TOURISM", to_agency: "BANK", service_item: "LOAN", expected_response_days: 2 }, occurred_at: "2026-09-01T09:00:00+08:00" }),
    evt({ event_type: "REFERRAL_ACCEPTED", aggregate_id: "R-1", version: 2, payload: { referral_id: "R-1" }, occurred_at: "2026-09-01T10:00:00+08:00" }),
    evt({ event_type: "REFERRAL_CLOSED_LOOP", aggregate_id: "R-1", version: 3, payload: { referral_id: "R-1", result: "完成" }, occurred_at: "2026-09-02T10:00:00+08:00" }),
    evt({ event_type: "REFERRAL_ACCEPTED", aggregate_id: "R-1", version: 4, payload: { referral_id: "R-1" }, occurred_at: "2026-09-03T10:00:00+08:00" }),
  ];
  assert.ok(validateStream(closed).errors.some((m) => m.includes("已闭环")));
});

test("管理者能区分卡在转介还是卡在回执", () => {
  const events = [
    // 卡在转介：发出后超过承诺时限无人受理
    evt({ event_type: "REFERRAL_ISSUED", aggregate_id: "R-A", occurred_at: "2026-09-01T09:00:00+08:00", payload: { referral_id: "R-A", from_agency: "CULTURE_TOURISM", to_agency: "MARKET_REGULATION", service_item: "BUSINESS_REGISTRATION", expected_response_days: 2 } }),
    // 卡在回执：已受理但结果没回到主理窗口
    evt({ event_type: "REFERRAL_ISSUED", aggregate_id: "R-B", occurred_at: "2026-09-01T09:00:00+08:00", payload: { referral_id: "R-B", from_agency: "CULTURE_TOURISM", to_agency: "RURAL_BANK", service_item: "LOAN", expected_response_days: 5 } }),
    evt({ event_type: "REFERRAL_ACCEPTED", aggregate_id: "R-B", version: 2, occurred_at: "2026-09-02T09:00:00+08:00", payload: { referral_id: "R-B" } }),
  ];
  const b = bottlenecks(events, "2026-09-10T09:00:00+08:00");
  assert.deepEqual(b.stuck_at_referral.map((x) => x.referral_id), ["R-A"]);
  assert.deepEqual(b.stuck_at_receipt.map((x) => x.referral_id), ["R-B"]);
  assert.equal(b.summary.stuck_referral, 1);
  assert.equal(b.summary.stuck_receipt, 1);

  // 同样的滞留经事件流校验也会给出警告
  const { warnings } = validateStream(events, "2026-09-10T09:00:00+08:00");
  assert.ok(warnings.some((w) => w.includes("R-A") && w.includes("卡在转介")));
  assert.ok(warnings.some((w) => w.includes("R-B") && w.includes("卡在回执")));
});

test("版本、时间与结案后不可再办理等基础约束", () => {
  const dupVersion = [
    profile(),
    evt({ event_type: "CASE_OPENED", aggregate_type: "service_case", aggregate_id: "C-1", payload: { person_id: "P-1", service_items: ["LOAN"] } }),
  ];
  assert.deepEqual(validateStream(dupVersion).errors, []);

  const afterComplete = [
    ...dupVersion,
    evt({ event_type: "CASE_COMPLETED", aggregate_type: "service_case", aggregate_id: "C-1", version: 2, payload: {} }),
    evt({ event_type: "TASK_ASSIGNED", aggregate_type: "service_task", aggregate_id: "T-9", version: 1, payload: { task_id: "T-9", service_item: "LOAN", agency: "RURAL_BANK", sla_due_at: "2026-09-30T18:00:00+08:00" } }),
  ];
  assert.ok(validateStream(afterComplete).errors.some((m) => m.includes("已结案")));

  assert.ok(validateEvent({ event_id: "x" }).some((m) => m.includes("缺少字段")));
});

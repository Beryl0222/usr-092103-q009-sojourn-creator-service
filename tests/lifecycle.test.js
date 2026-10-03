import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bottlenecks, caseTimeline, validateStream } from "../src/validator.js";

const lifecycle = JSON.parse(
  await readFile(new URL("../data/lifecycle.json", import.meta.url), "utf8"),
);

test("全流程样例通过事件流契约（无错误、无警告）", () => {
  const { errors, warnings } = validateStream(lifecycle);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("申请人视图：事项、承办机构、时限、尚缺材料与办结状态齐全", () => {
  const view = caseTimeline(lifecycle, "CASE-2026-0901");
  const byItem = Object.fromEntries(view.tasks.map((t) => [t.service_item, t]));

  for (const item of ["BUSINESS_REGISTRATION", "SOCIAL_INSURANCE", "EMPLOYMENT", "LOAN", "LEGAL_CONSULTATION"]) {
    assert.equal(byItem[item].status, "DONE", `${item} 应已办结`);
    assert.ok(byItem[item].agency, `${item} 应有承办机构`);
    assert.ok(byItem[item].sla_due_at, `${item} 应有承诺时限`);
  }
  // 所有任务最终都不再缺材料
  assert.deepEqual(view.tasks.flatMap((t) => t.missing_items), []);
  // 5 次转介全部闭环
  assert.equal(view.referrals.length, 5);
  assert.ok(view.referrals.every((r) => r.status === "CLOSED_LOOP"));
  // 旧暂住证明已阻断，新证明可用
  const old = view.documents.find((d) => d.document_id === "D-RESIDENCE");
  const renewed = view.documents.find((d) => d.document_id === "D-RESIDENCE-2");
  assert.equal(old.blocked, true);
  assert.equal(renewed.blocked, false);
  // 政策提示最终由责任机构确认
  assert.equal(view.eligibility[0].state, "CONFIRMED");
  assert.equal(view.eligibility[0].agency, "HUMAN_RESOURCES");
  assert.equal(view.completed, true);
});

test("管理者视图：无滞留转介与回执时统计归零", () => {
  const b = bottlenecks(lifecycle, "2026-10-03T18:00:00+08:00");
  assert.deepEqual(b.summary, {
    referral_count: 5,
    stuck_referral: 0,
    stuck_receipt: 0,
    open_or_overdue_tasks: 0,
  });
});

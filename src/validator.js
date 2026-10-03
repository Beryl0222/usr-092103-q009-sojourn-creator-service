import {
  AGGREGATE_TYPE_VALUES,
  CONSENT_PURPOSE_VALUES,
  DECISION_OUTCOME_VALUES,
  EVENT_TYPE_VALUES,
  STAGE_VALUES,
} from "./catalog.js";

const REQUIRED = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];
const ACTOR_KINDS = ["applicant", "window_staff", "responsible_agency", "rule_engine", "system"];

// 单条事件的公共信封校验：只看字段本身，不看序列上下文。
export function validateEvent(record) {
  const errors = [];
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    return ["事件必须是对象"];
  }
  for (const name of REQUIRED) {
    if (!(name in record)) errors.push(`缺少字段：${name}`);
  }
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_type" in record && !EVENT_TYPE_VALUES.includes(record.event_type)) {
    errors.push(`未知事件类型：${record.event_type}`);
  }
  if ("aggregate_type" in record && !AGGREGATE_TYPE_VALUES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法的 date-time");
  }
  if ("summary" in record && (typeof record.summary !== "string" || record.summary.length === 0)) {
    errors.push("summary 必须是非空字符串");
  }
  if ("case_stage" in record && !STAGE_VALUES.includes(record.case_stage)) {
    errors.push(`未知案件阶段：${record.case_stage}`);
  }
  if ("actor" in record) {
    const actor = record.actor;
    if (actor === null || typeof actor !== "object" || Array.isArray(actor)) {
      errors.push("actor 必须是对象");
    } else if (!ACTOR_KINDS.includes(actor.actor_kind)) {
      errors.push(`未知 actor_kind：${actor.actor_kind}`);
    }
  }
  const purpose = record?.payload?.purpose;
  if (purpose !== undefined && !CONSENT_PURPOSE_VALUES.includes(purpose)) {
    errors.push(`未知授权用途：${purpose}`);
  }
  const outcome = record?.payload?.outcome;
  if (outcome !== undefined && !DECISION_OUTCOME_VALUES.includes(outcome)) {
    errors.push(`未知决定结论：${outcome}`);
  }
  return errors;
}

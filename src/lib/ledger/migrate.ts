/**
 * 本地旧数据（a11y-audit-v1）升级到事件账本。
 *
 * 旧结构是「最终状态快照」：issues + events。升级时把每个问题还原成
 * 一串编号记录（创建 → 沿状态机合法路径走到原状态 → 补录修复/复测记录 →
 * 重复合并），旧时间线消息原样保留为 legacy.note，时间与内容不变。
 */
import { transitionPath } from './core';
import type { IssueStatus, NewEvent, Severity } from './types';

export const LEGACY_KEY = 'a11y-audit-v1';

interface LegacyIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}

interface LegacyEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}

interface LegacyState {
  issues: LegacyIssue[];
  events: LegacyEvent[];
}

const MIGRATION_ACTOR = '数据迁移';

export function isLegacyState(raw: unknown): raw is LegacyState {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    Array.isArray((raw as LegacyState).issues) &&
    Array.isArray((raw as LegacyState).events)
  );
}

/** 把 v1 快照翻译成一组按序提交的账本记录（供空账本一次性 appendBatch） */
export function migrateV1(raw: string): NewEvent[] {
  const data = JSON.parse(raw) as unknown;
  if (!isLegacyState(data)) throw new Error('旧数据格式无法识别');
  const out: NewEvent[] = [];
  // baseSeq 与产出顺序保持一致：第 k 条记录基于前 k 条
  const push = (issueId: string, at: string | undefined, payload: NewEvent['payload']) => {
    out.push({ actor: MIGRATION_ACTOR, issueId, baseSeq: out.length, at, payload });
  };

  // 1. 先建全部问题，保证合并目标一定存在
  for (const issue of data.issues) {
    push(issue.id, issue.updatedAt, {
      type: 'issue.created',
      title: issue.title,
      flow: issue.flow,
      steps: issue.steps,
      impactGroup: issue.impactGroup,
      severity: issue.severity,
    });
  }

  // 2. 沿状态机合法路径把每个问题走到原状态，并补录修复/复测记录
  for (const issue of data.issues) {
    for (const [from, to] of transitionPath('open', issue.status)) {
      push(issue.id, issue.updatedAt, { type: 'issue.status_changed', from, to });
    }
    const changes = [
      ...(issue.fixNote ? [{ field: 'fixNote' as const, value: issue.fixNote }] : []),
      ...(issue.retestNote ? [{ field: 'retestNote' as const, value: issue.retestNote }] : []),
    ];
    if (changes.length > 0) push(issue.id, issue.updatedAt, { type: 'issue.fields_changed', changes });
  }

  // 3. 重复合并：合并目标沿链解析到根，避免目标本身也是重复项
  const canonicalOf = (id: string): string => {
    let current = id;
    const seen = new Set<string>();
    for (;;) {
      const issue = data.issues.find((item) => item.id === current);
      if (!issue?.canonicalId || seen.has(current)) return current;
      seen.add(current);
      current = issue.canonicalId;
    }
  };
  for (const issue of data.issues) {
    if (!issue.canonicalId) continue;
    const root = canonicalOf(issue.canonicalId);
    if (root !== issue.id && data.issues.some((item) => item.id === root)) {
      push(issue.id, issue.updatedAt, { type: 'issue.merged', canonicalId: root });
    }
  }

  // 4. 旧时间线原样保留
  for (const event of data.events) {
    if (!data.issues.some((issue) => issue.id === event.issueId)) continue;
    push(event.issueId, event.at, { type: 'legacy.note', message: event.message });
  }

  return out;
}

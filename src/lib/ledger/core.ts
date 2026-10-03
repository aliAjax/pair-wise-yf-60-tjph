/**
 * 审计协作账本 —— 纯函数核心。
 *
 * - 追加编号记录：appendEvent / appendBatch 只负责校验并追加，状态由 replay 重放得出。
 * - 并发冲突：以 baseSeq（写入方下笔时看到的编号）对比字段最后修改编号，
 *   后提交的一方不覆盖先提交的内容，冲突字段两版并存、标注来源。
 * - 状态机：越界流转直接拒绝，账本保持不变。
 * - 判定：状态更新后已确认的判定作废、按当前数据重算并退回待复核。
 * - 恢复：批次合并失败回滚到最近可用结果，原批次保留在 retainedBatches。
 */
import type {
  AppendResult,
  BatchResult,
  DerivedState,
  FieldConflict,
  FieldKey,
  IssueState,
  IssueStatus,
  LedgerEvent,
  NewEvent,
  RetainedBatch,
  Severity,
  TimelineEntry,
  VersionedValue,
} from './types';
import { LedgerIntegrityError } from './types';

export const TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ['triaged'],
  triaged: ['fixing'],
  fixing: ['verifying'],
  verifying: ['closed', 'reopened'],
  reopened: ['fixing'],
  closed: ['reopened'],
};

export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开',
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '阻断',
  serious: '严重',
  moderate: '中等',
  minor: '轻微',
};

export const FIELD_LABELS: Record<FieldKey, string> = {
  title: '标题',
  flow: '业务流程',
  steps: '复现步骤',
  impactGroup: '影响人群',
  severity: '严重程度',
  fixNote: '修复记录',
  retestNote: '复测记录',
  status: '状态',
  canonicalId: '主问题',
};

const SEVERITIES: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

/** 判定建议：由当前问题数据确定性重算 */
export function deriveVerdict(issue: Pick<IssueState, 'status' | 'severity'>): string {
  if (issue.status === 'closed') return '复测通过，判定结案归档';
  const sev = SEVERITY_LABELS[issue.severity];
  if (issue.severity === 'critical' || issue.severity === 'serious') {
    return `${sev}问题，建议本期修复并安排复测`;
  }
  return `${sev}问题，建议排入常规迭代`;
}

/** 在状态机里找一条从 from 到 to 的合法路径（迁移旧数据用） */
export function transitionPath(from: IssueStatus, to: IssueStatus): Array<[IssueStatus, IssueStatus]> {
  if (from === to) return [];
  const queue: Array<{ status: IssueStatus; path: Array<[IssueStatus, IssueStatus]> }> = [{ status: from, path: [] }];
  const seen = new Set<IssueStatus>([from]);
  while (queue.length > 0) {
    const { status, path } = queue.shift()!;
    for (const next of TRANSITIONS[status]) {
      if (seen.has(next)) continue;
      const nextPath: Array<[IssueStatus, IssueStatus]> = [...path, [status, next]];
      if (next === to) return nextPath;
      seen.add(next);
      queue.push({ status: next, path: nextPath });
    }
  }
  throw new LedgerIntegrityError(`状态机中不存在 ${from} → ${to} 的路径`);
}

interface ReplayContext {
  issues: Map<string, IssueState>;
  order: string[];
  conflicts: FieldConflict[];
  timeline: TimelineEntry[];
  /** 每个问题每个字段最后生效的版本来源，用于冲突检测 */
  fieldSource: Map<string, Map<FieldKey, VersionedValue>>;
}

function sourceOf(ctx: ReplayContext, issueId: string, field: FieldKey): VersionedValue | undefined {
  return ctx.fieldSource.get(issueId)?.get(field);
}

function markField(ctx: ReplayContext, issueId: string, field: FieldKey, source: VersionedValue): void {
  let fields = ctx.fieldSource.get(issueId);
  if (!fields) {
    fields = new Map();
    ctx.fieldSource.set(issueId, fields);
  }
  fields.set(field, source);
}

function getIssue(ctx: ReplayContext, event: LedgerEvent): IssueState {
  const issue = ctx.issues.get(event.issueId);
  if (!issue) {
    throw new LedgerIntegrityError(`记录 #${event.seq} 指向不存在的问题 ${event.issueId}`);
  }
  return issue;
}

function recordConflict(
  ctx: ReplayContext,
  event: LedgerEvent,
  field: FieldKey,
  committed: VersionedValue,
  incomingValue: string,
): void {
  const conflict: FieldConflict = {
    id: `c-${event.id}-${field}`,
    issueId: event.issueId,
    field,
    committed,
    incoming: { value: incomingValue, actor: event.actor, at: event.at, seq: event.seq },
    resolved: false,
  };
  ctx.conflicts.push(conflict);
  ctx.timeline.push({
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    issueId: event.issueId,
    kind: 'conflict.detected',
    message: `字段冲突（${FIELD_LABELS[field]}）：保留 ${committed.actor} 先提交的版本，${event.actor} 后提交的版本已保留待处理`,
  });
}

/** 字段在 baseSeq 之后是否已被别人改过 */
function changedAfter(ctx: ReplayContext, issueId: string, field: FieldKey, baseSeq: number): boolean {
  return (sourceOf(ctx, issueId, field)?.seq ?? 0) > baseSeq;
}

function applyStatusChange(ctx: ReplayContext, event: LedgerEvent, issue: IssueState, to: IssueStatus, source: VersionedValue): void {
  const from = issue.status;
  const hadConfirmedVerdict = issue.verdict.state === 'confirmed';
  issue.status = to;
  issue.updatedAt = event.at;
  markField(ctx, issue.id, 'status', source);
  // 状态更新后：已确认的判定作废，按新数据重算，退回待复核
  issue.verdict = { state: 'pending', text: deriveVerdict(issue) };
  ctx.timeline.push({
    seq: event.seq,
    at: event.at,
    actor: event.actor,
    issueId: issue.id,
    kind: 'issue.status_changed',
    message: `状态：${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}${hadConfirmedVerdict ? '，已确认的判定作废重算，退回待复核' : '，判定退回待复核'}`,
  });
}

function applyEvent(ctx: ReplayContext, event: LedgerEvent): void {
  const { payload } = event;
  switch (payload.type) {
    case 'issue.created': {
      if (ctx.issues.has(event.issueId)) {
        throw new LedgerIntegrityError(`记录 #${event.seq} 重复创建问题 ${event.issueId}`);
      }
      const issue: IssueState = {
        id: event.issueId,
        title: payload.title,
        flow: payload.flow,
        steps: payload.steps,
        impactGroup: payload.impactGroup,
        severity: payload.severity,
        status: 'open',
        fixNote: '',
        retestNote: '',
        verdict: { state: 'pending', text: '' },
        createdAt: event.at,
        updatedAt: event.at,
      };
      issue.verdict = { state: 'pending', text: deriveVerdict(issue) };
      ctx.issues.set(issue.id, issue);
      ctx.order.push(issue.id);
      const source: VersionedValue = { value: '', actor: event.actor, at: event.at, seq: event.seq };
      markField(ctx, issue.id, 'status', { ...source, value: 'open' });
      markField(ctx, issue.id, 'title', { ...source, value: payload.title });
      markField(ctx, issue.id, 'severity', { ...source, value: payload.severity });
      ctx.timeline.push({
        seq: event.seq,
        at: event.at,
        actor: event.actor,
        issueId: issue.id,
        kind: 'issue.created',
        message: `创建问题「${payload.title}」（${SEVERITY_LABELS[payload.severity]}）`,
      });
      return;
    }

    case 'issue.fields_changed': {
      const issue = getIssue(ctx, event);
      if (payload.changes.length === 0) {
        throw new LedgerIntegrityError(`记录 #${event.seq} 不包含任何字段修改`);
      }
      const applied: string[] = [];
      for (const change of payload.changes) {
        if (change.field === 'severity' && !SEVERITIES.includes(change.value as Severity)) {
          throw new LedgerIntegrityError(`记录 #${event.seq} 的严重程度取值非法：${change.value}`);
        }
        if (change.field === 'status' || change.field === 'canonicalId') {
          throw new LedgerIntegrityError(`记录 #${event.seq} 不能用字段修改来变更 ${FIELD_LABELS[change.field]}`);
        }
        const committed = sourceOf(ctx, issue.id, change.field);
        if (committed && committed.seq > event.baseSeq && committed.value !== change.value) {
          // 后提交不覆盖先提交：保留两版并标来源
          recordConflict(ctx, event, change.field, committed, change.value);
          continue;
        }
        (issue as unknown as Record<string, string>)[change.field] = change.value;
        issue.updatedAt = event.at;
        markField(ctx, issue.id, change.field, { value: change.value, actor: event.actor, at: event.at, seq: event.seq });
        applied.push(FIELD_LABELS[change.field]);
      }
      if (applied.length > 0) {
        ctx.timeline.push({
          seq: event.seq,
          at: event.at,
          actor: event.actor,
          issueId: issue.id,
          kind: 'issue.fields_changed',
          message: `更新${applied.join('、')}`,
        });
      }
      return;
    }

    case 'issue.status_changed': {
      const issue = getIssue(ctx, event);
      if (!TRANSITIONS[payload.from].includes(payload.to)) {
        throw new LedgerIntegrityError(
          `记录 #${event.seq} 状态流转越界：${STATUS_LABELS[payload.from]} ↛ ${STATUS_LABELS[payload.to]}`,
        );
      }
      if (issue.status === payload.from) {
        applyStatusChange(ctx, event, issue, payload.to, { value: payload.to, actor: event.actor, at: event.at, seq: event.seq });
        return;
      }
      const committed = sourceOf(ctx, issue.id, 'status');
      if (committed && committed.seq > event.baseSeq) {
        // 别人先改了状态：后提交的流转不生效，两版并存
        recordConflict(ctx, event, 'status', committed, payload.to);
        return;
      }
      throw new LedgerIntegrityError(
        `记录 #${event.seq} 状态前置不符：期望 ${STATUS_LABELS[payload.from]}，实际 ${STATUS_LABELS[issue.status]}`,
      );
    }

    case 'issue.merged': {
      const issue = getIssue(ctx, event);
      const canonical = ctx.issues.get(payload.canonicalId);
      if (!canonical) {
        throw new LedgerIntegrityError(`记录 #${event.seq} 合并目标 ${payload.canonicalId} 不存在`);
      }
      if (canonical.id === issue.id) {
        throw new LedgerIntegrityError(`记录 #${event.seq} 不能把问题合并到自身`);
      }
      if (canonical.canonicalId) {
        throw new LedgerIntegrityError(`记录 #${event.seq} 的合并目标本身已是重复项`);
      }
      const committed = sourceOf(ctx, issue.id, 'canonicalId');
      if (committed && committed.value) {
        if (committed.seq > event.baseSeq) {
          recordConflict(ctx, event, 'canonicalId', committed, payload.canonicalId);
          return;
        }
        throw new LedgerIntegrityError(`记录 #${event.seq} 的问题已是重复项，不能重复合并`);
      }
      issue.canonicalId = payload.canonicalId;
      issue.updatedAt = event.at;
      markField(ctx, issue.id, 'canonicalId', { value: payload.canonicalId, actor: event.actor, at: event.at, seq: event.seq });
      ctx.timeline.push({
        seq: event.seq,
        at: event.at,
        actor: event.actor,
        issueId: issue.id,
        kind: 'issue.merged',
        message: `重复问题合并到「${canonical.title}」，保留来源关系`,
      });
      return;
    }

    case 'verdict.confirmed': {
      const issue = getIssue(ctx, event);
      const statusSource = sourceOf(ctx, issue.id, 'status');
      if (statusSource && statusSource.seq > event.baseSeq) {
        // 确认基于旧状态：状态已变化，确认不生效
        ctx.timeline.push({
          seq: event.seq,
          at: event.at,
          actor: event.actor,
          issueId: issue.id,
          kind: 'verdict.confirmed',
          message: '判定确认基于旧状态，已过期未生效',
        });
        return;
      }
      issue.verdict = { state: 'confirmed', text: payload.text, confirmedBy: event.actor, confirmedAt: event.at };
      ctx.timeline.push({
        seq: event.seq,
        at: event.at,
        actor: event.actor,
        issueId: issue.id,
        kind: 'verdict.confirmed',
        message: `确认判定：${payload.text}`,
      });
      return;
    }

    case 'conflict.resolved': {
      const issue = getIssue(ctx, event);
      const conflict = ctx.conflicts.find((item) => item.id === payload.conflictId);
      if (!conflict) {
        throw new LedgerIntegrityError(`记录 #${event.seq} 要解决的冲突 ${payload.conflictId} 不存在`);
      }
      if (conflict.resolved) return; // 幂等：已解决过的冲突不重复处理
      conflict.resolved = true;
      conflict.resolution = payload.keep;
      if (payload.keep === 'incoming') {
        const source: VersionedValue = { value: conflict.incoming.value, actor: event.actor, at: event.at, seq: event.seq };
        if (payload.field === 'status') {
          applyStatusChange(ctx, event, issue, conflict.incoming.value as IssueStatus, source);
        } else if (payload.field === 'canonicalId') {
          issue.canonicalId = conflict.incoming.value;
          issue.updatedAt = event.at;
          markField(ctx, issue.id, 'canonicalId', source);
        } else {
          (issue as unknown as Record<string, string>)[payload.field] = conflict.incoming.value;
          issue.updatedAt = event.at;
          markField(ctx, issue.id, payload.field, source);
        }
      }
      ctx.timeline.push({
        seq: event.seq,
        at: event.at,
        actor: event.actor,
        issueId: issue.id,
        kind: 'conflict.resolved',
        message: `解决${FIELD_LABELS[payload.field]}冲突：${payload.keep === 'incoming' ? '采用后提交版本' : '保留先提交版本'}`,
      });
      return;
    }

    case 'legacy.note': {
      ctx.timeline.push({
        seq: event.seq,
        at: event.at,
        actor: event.actor,
        issueId: event.issueId,
        kind: 'legacy.note',
        message: payload.message,
      });
      return;
    }
  }
}

/** 重放编号记录，得出当前问题列表、字段冲突与操作时间线 */
export function replay(events: LedgerEvent[]): DerivedState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const seenSeq = new Set<number>();
  const ctx: ReplayContext = {
    issues: new Map(),
    order: [],
    conflicts: [],
    timeline: [],
    fieldSource: new Map(),
  };
  for (const event of ordered) {
    if (seenSeq.has(event.seq)) {
      throw new LedgerIntegrityError(`记录编号 #${event.seq} 重复`);
    }
    seenSeq.add(event.seq);
    applyEvent(ctx, event);
  }
  return {
    issues: ctx.order.map((id) => ctx.issues.get(id)!),
    conflicts: ctx.conflicts,
    timeline: ctx.timeline,
    headSeq: ordered.length > 0 ? ordered[ordered.length - 1].seq : 0,
  };
}

export interface LedgerOptions {
  now?: () => string;
  id?: () => string;
}

export interface Ledger {
  readonly events: LedgerEvent[];
  readonly state: DerivedState;
  readonly retainedBatches: RetainedBatch[];
  /** 最近可用结果（每次成功提交前的状态），供失败恢复 */
  readonly snapshots: Array<{ seq: number; state: DerivedState }>;
  append(input: NewEvent): AppendResult;
  appendBatch(inputs: NewEvent[], source: string): BatchResult;
}

const defaultNow = () => new Date().toISOString();
const defaultId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const MAX_SNAPSHOTS = 20;

export function createLedger(initial: LedgerEvent[] = [], options: LedgerOptions = {}): Ledger {
  const now = options.now ?? defaultNow;
  const rid = options.id ?? defaultId;
  let events = [...initial];
  let state = replay(events);
  const retainedBatches: RetainedBatch[] = [];
  const snapshots: Array<{ seq: number; state: DerivedState }> = [];

  const remember = (seq: number, snapshot: DerivedState) => {
    snapshots.push({ seq, state: snapshot });
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  };

  const ledger: Ledger = {
    get events() {
      return events;
    },
    get state() {
      return state;
    },
    get retainedBatches() {
      return retainedBatches;
    },
    get snapshots() {
      return snapshots;
    },

    append(input) {
      const event: LedgerEvent = {
        seq: state.headSeq + 1,
        id: input.id ?? rid(),
        at: input.at ?? now(),
        actor: input.actor,
        issueId: input.issueId,
        baseSeq: input.baseSeq,
        payload: input.payload,
      };
      let next: DerivedState;
      try {
        next = replay([...events, event]);
      } catch (error) {
        // 拒绝：账本保持原状态
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      remember(state.headSeq, state);
      events = [...events, event];
      state = next;
      return { ok: true, event };
    },

    appendBatch(inputs, source) {
      const batchId = rid();
      const beforeEvents = events;
      const beforeState = state;
      const beforeSnapshots = snapshots.length;
      try {
        for (const input of inputs) {
          const result = ledger.append(input);
          if (!result.ok) throw new LedgerIntegrityError(result.reason);
        }
        return { ok: true, batchId, applied: inputs.length };
      } catch (error) {
        // 合并失败：回滚到最近可用结果，原批次保留不丢
        events = beforeEvents;
        state = beforeState;
        snapshots.length = beforeSnapshots;
        const retained: RetainedBatch = {
          id: batchId,
          at: now(),
          source,
          events: inputs,
          error: error instanceof Error ? error.message : String(error),
          recoveredSeq: beforeState.headSeq,
        };
        retainedBatches.push(retained);
        return { ok: false, batchId, error: retained.error, recoveredSeq: beforeState.headSeq, retained };
      }
    },
  };
  return ledger;
}

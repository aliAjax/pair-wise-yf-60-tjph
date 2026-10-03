/**
 * 审计协作账本 —— 核心类型。
 *
 * 设计：所有改动（建问题、改字段、改状态、合并重复项、确认判定、解决冲突）
 * 都先追加为带编号（seq）的记录，当前问题列表与操作时间线全部由记录重放得出。
 */

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

/** 可被并发编辑、需要冲突检测的字段 */
export type FieldKey =
  | 'title'
  | 'flow'
  | 'steps'
  | 'impactGroup'
  | 'severity'
  | 'fixNote'
  | 'retestNote'
  | 'status'
  | 'canonicalId';

export interface FieldChange {
  field: FieldKey;
  value: string;
}

export type LedgerEventPayload =
  | { type: 'issue.created'; title: string; flow: string; steps: string; impactGroup: string; severity: Severity }
  | { type: 'issue.fields_changed'; changes: FieldChange[] }
  | { type: 'issue.status_changed'; from: IssueStatus; to: IssueStatus }
  | { type: 'issue.merged'; canonicalId: string }
  | { type: 'verdict.confirmed'; text: string }
  | { type: 'conflict.resolved'; conflictId: string; field: FieldKey; keep: 'committed' | 'incoming' }
  | { type: 'legacy.note'; message: string };

/** 已提交（已编号）的账本记录 */
export interface LedgerEvent {
  /** 单调递增编号，提交时分配 */
  seq: number;
  id: string;
  at: string;
  /** 提交来源（标签页 / 用户会话） */
  actor: string;
  issueId: string;
  /** 写入方下笔时看到的账本编号，用于并发冲突检测 */
  baseSeq: number;
  payload: LedgerEventPayload;
}

/** 尚未编号、待提交的记录 */
export interface NewEvent {
  id?: string;
  at?: string;
  actor: string;
  issueId: string;
  baseSeq: number;
  payload: LedgerEventPayload;
}

/** 一个字段版本的来源信息 */
export interface VersionedValue {
  value: string;
  actor: string;
  at: string;
  seq: number;
}

/** 字段冲突：先提交版本生效，后提交版本保留备查，两版都标来源 */
export interface FieldConflict {
  id: string;
  issueId: string;
  field: FieldKey;
  /** 先生效的一版 */
  committed: VersionedValue;
  /** 后提交、未生效的一版 */
  incoming: VersionedValue;
  resolved: boolean;
  resolution?: 'committed' | 'incoming';
}

export interface Verdict {
  /** pending = 待复核；confirmed = 已确认 */
  state: 'pending' | 'confirmed';
  text: string;
  confirmedBy?: string;
  confirmedAt?: string;
}

export interface IssueState {
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
  verdict: Verdict;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  seq: number;
  at: string;
  actor: string;
  issueId: string;
  kind: LedgerEventPayload['type'] | 'conflict.detected';
  message: string;
}

/** 重放得出的当前账 */
export interface DerivedState {
  issues: IssueState[];
  conflicts: FieldConflict[];
  timeline: TimelineEntry[];
  headSeq: number;
}

export type AppendResult =
  | { ok: true; event: LedgerEvent }
  | { ok: false; reason: string };

/** 合并失败后被保留下来、未丢弃的原始批次 */
export interface RetainedBatch {
  id: string;
  at: string;
  source: string;
  events: NewEvent[];
  error: string;
  recoveredSeq: number;
  /** 离线批次起链时的共享编号，重试时用于区分临时编号 */
  baseHead?: number;
}

export type BatchResult =
  | { ok: true; batchId: string; applied: number }
  | { ok: false; batchId: string; error: string; recoveredSeq: number; retained: RetainedBatch };

export class LedgerIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

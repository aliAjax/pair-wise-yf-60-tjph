/**
 * 审计台账：只追加编号事件（append-only event log），重放得出当前问题与时间线。
 *
 * 约定：
 * - 所有写操作（建问题、改字段、状态流转、合并重复项）都先追加带编号的事件，再重放。
 * - 多标签页并发：字段级乐观并发，后提交一方不得盖掉先提交内容，冲突字段保留两版并标来源。
 * - 状态机：越界流转一律拒绝并保留原状态。
 * - 合并失败：从最近可用结果恢复，原批次事件不动。
 * - 旧版本地数据（a11y-audit-v1）升级时迁移为事件流，原问题与时间线保留。
 */

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待复核',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: '阻断',
  serious: '严重',
  moderate: '中等',
  minor: '轻微'
};

export const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  flow: '业务流程',
  steps: '复现步骤',
  impactGroup: '受影响人群',
  severity: '严重程度',
  fixNote: '修复记录',
  retestNote: '复测记录'
};

/** 审计内容字段：这些字段在已确认状态下被改动时，已确认判定作废、退回待复核。 */
export const CONTENT_FIELDS = ['title', 'flow', 'steps', 'impactGroup', 'severity'] as const;

/** 状态机：允许的流转方向。 */
export const TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['triaged'],
  triaged: ['fixing'],
  fixing: ['verifying'],
  verifying: ['closed', 'reopened'],
  reopened: ['fixing'],
  closed: []
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// 事件类型
// ---------------------------------------------------------------------------

interface EventBase {
  id: string;
  /** 编号：Lamport 逻辑时钟，重放按编号排序。 */
  seq: number;
  at: string;
  /** 来源标签页标识。 */
  source: string;
}

export interface IssueCreatedEvent extends EventBase {
  type: 'issue.created';
  issueId: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  fixNote?: string;
  retestNote?: string;
  canonicalId?: string;
}

export interface IssueUpdatedEvent extends EventBase {
  type: 'issue.updated';
  issueId: string;
  patch: Record<string, unknown>;
  /** 编辑时所依据的问题最后时钟，用于字段级冲突检测。 */
  baseClock: number;
}

export interface IssueStatusChangedEvent extends EventBase {
  type: 'issue.statusChanged';
  issueId: string;
  from: IssueStatus;
  to: IssueStatus;
  note?: string;
  baseClock: number;
}

export interface IssueMergedEvent extends EventBase {
  type: 'issue.merged';
  issueId: string;
  canonicalId: string;
  baseClock: number;
}

export interface ActivityEvent extends EventBase {
  type: 'activity';
  issueId: string;
  message: string;
}

export type LedgerEvent =
  | IssueCreatedEvent
  | IssueUpdatedEvent
  | IssueStatusChangedEvent
  | IssueMergedEvent
  | ActivityEvent;

// ---------------------------------------------------------------------------
// 重放结果
// ---------------------------------------------------------------------------

export interface FieldVersion {
  value: unknown;
  source: string;
  at: string;
  seq: number;
}

export interface FieldConflict {
  conflict: true;
  versions: FieldVersion[];
}

export type FieldValue<T> = T | FieldConflict;

export interface ReplayedIssue {
  id: string;
  title: FieldValue<string>;
  flow: FieldValue<string>;
  steps: FieldValue<string>;
  impactGroup: FieldValue<string>;
  severity: FieldValue<Severity>;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
  lastClock: number;
  fieldMeta: Record<string, { clock: number; source: string }>;
}

export type TimelineKind = 'activity' | 'status' | 'merge' | 'system' | 'conflict';

export interface TimelineEntry {
  id: string;
  seq: number;
  at: string;
  source: string;
  kind: TimelineKind;
  issueId?: string;
  message: string;
}

export interface FieldConflictReport {
  issueId: string;
  field: string;
  versions: FieldVersion[];
}

export interface ReplayResult {
  issues: ReplayedIssue[];
  timeline: TimelineEntry[];
  maxClock: number;
  conflicts: FieldConflictReport[];
}

export function isConflict(v: unknown): v is FieldConflict {
  return !!v && typeof v === 'object' && (v as { conflict?: unknown }).conflict === true;
}

/** 按字段名读写问题字段（字段值可能是冲突结构）。 */
function readField(issue: ReplayedIssue, field: string): unknown {
  return (issue as unknown as Record<string, unknown>)[field];
}
function writeField(issue: ReplayedIssue, field: string, value: unknown): void {
  (issue as unknown as Record<string, unknown>)[field] = value;
}

/** 取字段当前展示值；冲突时返回最新一版，完整两版见 versions。 */
export function currentOf<T>(v: FieldValue<T>): { value: T; conflict: boolean; versions: FieldVersion[] } {
  if (isConflict(v)) {
    return { value: v.versions[v.versions.length - 1]?.value as T, conflict: true, versions: v.versions };
  }
  return { value: v, conflict: false, versions: [] };
}

// ---------------------------------------------------------------------------
// 事件工厂
// ---------------------------------------------------------------------------

export function nextClock(events: readonly LedgerEvent[]): number {
  return events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}

export function makeCreatedEvent(
  input: { title: string; flow: string; steps: string; impactGroup: string; severity: Severity },
  source: string,
  seq: number,
  at = new Date().toISOString()
): IssueCreatedEvent {
  return {
    id: crypto.randomUUID(),
    type: 'issue.created',
    issueId: crypto.randomUUID(),
    seq,
    at,
    source,
    status: 'open',
    ...input
  };
}

export function makeUpdatedEvent(
  issue: ReplayedIssue,
  patch: Record<string, unknown>,
  source: string,
  seq: number,
  at = new Date().toISOString()
): IssueUpdatedEvent {
  return {
    id: crypto.randomUUID(),
    type: 'issue.updated',
    issueId: issue.id,
    seq,
    at,
    source,
    patch,
    baseClock: issue.lastClock
  };
}

export function makeStatusEvent(
  issue: ReplayedIssue,
  to: IssueStatus,
  note: string | undefined,
  source: string,
  seq: number,
  at = new Date().toISOString()
): IssueStatusChangedEvent {
  return {
    id: crypto.randomUUID(),
    type: 'issue.statusChanged',
    issueId: issue.id,
    seq,
    at,
    source,
    from: issue.status,
    to,
    note,
    baseClock: issue.lastClock
  };
}

export function makeMergedEvent(
  dup: ReplayedIssue,
  canonicalId: string,
  source: string,
  seq: number,
  at = new Date().toISOString()
): IssueMergedEvent {
  return {
    id: crypto.randomUUID(),
    type: 'issue.merged',
    issueId: dup.id,
    canonicalId,
    seq,
    at,
    source,
    baseClock: dup.lastClock
  };
}

// ---------------------------------------------------------------------------
// 重放
// ---------------------------------------------------------------------------

function compareEvents(a: LedgerEvent, b: LedgerEvent): number {
  return a.seq - b.seq || a.source.localeCompare(b.source) || a.id.localeCompare(b.id);
}

/** 重放事件流，得出当前问题列表与时间线。结构不合法时抛错（供合并回滚使用）。 */
export function replay(events: readonly LedgerEvent[]): ReplayResult {
  const sorted = [...events].sort(compareEvents);
  const byId = new Map<string, ReplayedIssue>();
  const timeline: TimelineEntry[] = [];
  const conflicts: FieldConflictReport[] = [];
  let maxClock = 0;

  const push = (e: LedgerEvent, kind: TimelineKind, message: string, issueId?: string) => {
    timeline.push({ id: e.id, seq: e.seq, at: e.at, source: e.source, kind, issueId, message });
  };

  for (const e of sorted) {
    maxClock = Math.max(maxClock, e.seq);
    switch (e.type) {
      case 'issue.created': {
        if (byId.has(e.issueId)) throw new Error(`重复创建同一问题：${e.issueId}`);
        const issue: ReplayedIssue = {
          id: e.issueId,
          title: e.title,
          flow: e.flow,
          steps: e.steps,
          impactGroup: e.impactGroup,
          severity: e.severity,
          status: e.status,
          canonicalId: e.canonicalId || undefined,
          fixNote: e.fixNote ?? '',
          retestNote: e.retestNote ?? '',
          updatedAt: e.at,
          lastClock: e.seq,
          fieldMeta: {}
        };
        if (e.fixNote) issue.fieldMeta.fixNote = { clock: e.seq, source: e.source };
        if (e.retestNote) issue.fieldMeta.retestNote = { clock: e.seq, source: e.source };
        byId.set(e.issueId, issue);
        push(e, 'activity', `创建问题：${e.title}`, e.issueId);
        break;
      }

      case 'issue.updated': {
        const issue = byId.get(e.issueId);
        if (!issue) throw new Error(`更新了不存在的问题：${e.issueId}`);
        let contentChanged = false;
        for (const [field, value] of Object.entries(e.patch)) {
          const meta = issue.fieldMeta[field];
          if (meta && meta.clock > e.baseClock) {
            // 并发冲突：后提交一方不得盖掉先提交内容，两版都保留并标来源
            const prevVersions: FieldVersion[] = isConflict(readField(issue, field))
              ? (readField(issue, field) as FieldConflict).versions
              : [{ value: readField(issue, field), source: meta.source, at: issue.updatedAt, seq: meta.clock }];
            const versions: FieldVersion[] = [...prevVersions, { value, source: e.source, at: e.at, seq: e.seq }];
            writeField(issue, field, { conflict: true, versions } satisfies FieldConflict);
            conflicts.push({ issueId: issue.id, field, versions });
            push(
              e,
              'conflict',
              `字段「${FIELD_LABELS[field] ?? field}」多人同时修改，已保留两版（${prevVersions[prevVersions.length - 1]?.source} 与 ${e.source}）`,
              issue.id
            );
          } else {
            writeField(issue, field, value);
            issue.fieldMeta[field] = { clock: e.seq, source: e.source };
          }
          if ((CONTENT_FIELDS as readonly string[]).includes(field)) contentChanged = true;
        }
        issue.updatedAt = e.at;
        issue.lastClock = Math.max(issue.lastClock, e.seq);
        // 状态更新后已确认的判定作废重算，退回待复核
        if (contentChanged && issue.status !== 'open') {
          issue.status = 'open';
          push(e, 'system', '审核信息变更，已确认的判定作废重算，退回待复核', issue.id);
        }
        break;
      }

      case 'issue.statusChanged': {
        const issue = byId.get(e.issueId);
        if (!issue) throw new Error(`状态变更了不存在的问题：${e.issueId}`);
        if (issue.status !== e.from) {
          push(
            e,
            'conflict',
            `状态冲突：尝试 ${STATUS_LABELS[e.from]}→${STATUS_LABELS[e.to]}（${e.source}），当前为${STATUS_LABELS[issue.status]}，已保留当前状态`,
            issue.id
          );
          break;
        }
        if (!canTransition(e.from, e.to)) {
          push(
            e,
            'status',
            `越界状态流转已拒绝：${STATUS_LABELS[e.from]}→${STATUS_LABELS[e.to]}（${e.source}），保留原状态`,
            issue.id
          );
          break;
        }
        issue.status = e.to;
        issue.lastClock = Math.max(issue.lastClock, e.seq);
        if (e.to === 'fixing' && e.note) {
          issue.fixNote = e.note;
          issue.fieldMeta.fixNote = { clock: e.seq, source: e.source };
        }
        if (e.to === 'verifying') {
          // 提交复测：上一轮复测判定作废重算
          issue.retestNote = '';
          issue.fieldMeta.retestNote = { clock: e.seq, source: e.source };
        }
        if ((e.to === 'closed' || e.to === 'reopened') && e.note) {
          issue.retestNote = e.note;
          issue.fieldMeta.retestNote = { clock: e.seq, source: e.source };
        }
        push(e, 'status', `${STATUS_LABELS[e.from]} → ${STATUS_LABELS[e.to]}${e.note ? `：${e.note}` : ''}`, issue.id);
        break;
      }

      case 'issue.merged': {
        const dup = byId.get(e.issueId);
        const canonical = byId.get(e.canonicalId);
        if (!dup || !canonical) throw new Error('合并目标问题不存在');
        if (canonical.canonicalId) throw new Error('主问题本身已是重复项，不能作为合并目标');
        if (dup.canonicalId === e.canonicalId) break;
        if (dup.canonicalId) {
          push(e, 'conflict', `合并冲突：该问题已合并到其他主问题，保留原合并关系`, dup.id);
          break;
        }
        dup.canonicalId = e.canonicalId;
        dup.lastClock = Math.max(dup.lastClock, e.seq);
        push(e, 'merge', `重复问题合并到主问题「${canonical.title}」`, dup.id);
        push(e, 'merge', `合并重复项「${dup.title}」`, canonical.id);
        break;
      }

      case 'activity': {
        if (!byId.has(e.issueId)) throw new Error(`操作记录指向不存在的问题：${e.issueId}`);
        push(e, 'activity', e.message, e.issueId);
        break;
      }
    }
  }

  return { issues: [...byId.values()], timeline, maxClock, conflicts };
}

// ---------------------------------------------------------------------------
// 合并提交：失败时从最近可用结果恢复，保留原批次
// ---------------------------------------------------------------------------

export interface CommitResult {
  ok: boolean;
  error?: string;
}

export function commitMerge(
  events: readonly LedgerEvent[],
  dupId: string,
  canonicalId: string,
  source: string
): { events: LedgerEvent[]; result: CommitResult } {
  const snapshot = [...events];
  const dup = replay(snapshot).issues.find((i) => i.id === dupId);
  if (!dup) return { events: snapshot, result: { ok: false, error: '重复问题不存在' } };
  const ev = makeMergedEvent(dup, canonicalId, source, nextClock(snapshot));
  const candidate = [...snapshot, ev];
  try {
    replay(candidate);
  } catch (err) {
    // 从最近可用结果恢复，原批次事件不动
    return { events: snapshot, result: { ok: false, error: (err as Error).message } };
  }
  return { events: candidate, result: { ok: true } };
}

// ---------------------------------------------------------------------------
// 事件合并（多标签页同步）
// ---------------------------------------------------------------------------

export function mergeEvents(a: readonly LedgerEvent[], b: readonly LedgerEvent[]): LedgerEvent[] {
  const seen = new Set(a.map((e) => e.id));
  const out = [...a];
  for (const e of b) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  return out.sort(compareEvents);
}

// ---------------------------------------------------------------------------
// 本地存储与旧数据升级
// ---------------------------------------------------------------------------

export const LEDGER_KEY = 'a11y-audit-ledger-v1';
export const LEGACY_KEY = 'a11y-audit-v1';

const seedLegacy = {
  issues: [
    {
      id: 'issue-1',
      title: '结算弹窗关闭后焦点丢失',
      flow: '订单结算',
      steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
      impactGroup: '键盘与读屏用户',
      severity: 'serious',
      status: 'triaged',
      fixNote: '',
      retestNote: '',
      updatedAt: new Date(Date.now() - 3600_000).toISOString()
    },
    {
      id: 'issue-2',
      title: '错误提示未与输入框关联',
      flow: '账户设置',
      steps: '输入无效手机号后使用读屏读取输入框',
      impactGroup: '读屏用户',
      severity: 'moderate',
      status: 'fixing',
      fixNote: '已增加 aria-describedby，等待构建',
      retestNote: '',
      updatedAt: new Date(Date.now() - 7200_000).toISOString()
    }
  ],
  events: [
    { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
    { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
  ]
};

function isSeverity(v: unknown): v is Severity {
  return v === 'critical' || v === 'serious' || v === 'moderate' || v === 'minor';
}

function isStatus(v: unknown): v is IssueStatus {
  return v === 'open' || v === 'triaged' || v === 'fixing' || v === 'verifying' || v === 'closed' || v === 'reopened';
}

/** 旧版本地数据升级：原问题与时间线保留，迁移为编号事件流。 */
export function migrateLegacy(legacy: { issues?: unknown[]; events?: unknown[] }, source = 'legacy'): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  let seq = 0;
  for (const raw of legacy.issues ?? []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID();
    seq += 1;
    out.push({
      id,
      type: 'issue.created',
      issueId: id,
      seq,
      at: typeof r.updatedAt === 'string' ? r.updatedAt : new Date().toISOString(),
      source,
      title: typeof r.title === 'string' ? r.title : '未命名问题',
      flow: typeof r.flow === 'string' ? r.flow : '',
      steps: typeof r.steps === 'string' ? r.steps : '',
      impactGroup: typeof r.impactGroup === 'string' ? r.impactGroup : '',
      severity: isSeverity(r.severity) ? r.severity : 'minor',
      status: isStatus(r.status) ? r.status : 'open',
      fixNote: typeof r.fixNote === 'string' ? r.fixNote : '',
      retestNote: typeof r.retestNote === 'string' ? r.retestNote : '',
      canonicalId: typeof r.canonicalId === 'string' ? r.canonicalId : undefined
    });
  }
  const activities = (legacy.events ?? [])
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        id: typeof r.id === 'string' && r.id ? r.id : crypto.randomUUID(),
        issueId: typeof r.issueId === 'string' ? r.issueId : '',
        message: typeof r.message === 'string' ? r.message : '',
        at: typeof r.at === 'string' ? r.at : new Date().toISOString()
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const a of activities) {
    seq += 1;
    out.push({ id: a.id, type: 'activity', issueId: a.issueId, message: a.message, seq, at: a.at, source });
  }
  return out;
}

function isEventLike(v: unknown): v is LedgerEvent {
  return !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && typeof (v as { seq?: unknown }).seq === 'number' && typeof (v as { type?: unknown }).type === 'string';
}

export function loadLedger(): LedgerEvent[] {
  if (typeof localStorage === 'undefined') return migrateLegacy(seedLegacy, 'seed');
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(isEventLike)) return parsed as LedgerEvent[];
    }
  } catch {
    // 账本损坏时尝试旧数据升级
  }
  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacy: unknown = JSON.parse(legacyRaw);
      if (legacy && typeof legacy === 'object' && Array.isArray((legacy as { issues?: unknown }).issues)) {
        return migrateLegacy(legacy as { issues?: unknown[]; events?: unknown[] }, 'legacy');
      }
    }
  } catch {
    // 旧数据也损坏时回到初始种子
  }
  return migrateLegacy(seedLegacy, 'seed');
}

export function saveLedger(events: readonly LedgerEvent[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LEDGER_KEY, JSON.stringify(events));
}

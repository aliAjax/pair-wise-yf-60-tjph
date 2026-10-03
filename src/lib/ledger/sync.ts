/**
 * 浏览器同步层：把核心账本接到多标签页 + 离线的真实环境。
 *
 * - 共享账本存 localStorage，提交时用 Web Locks 串行化「读-改-写」，
 *   后提交的一方带着自己下笔时的 baseSeq，冲突由核心重放判定，不会盖掉先提交的内容。
 * - 离线时的改动进每标签页自己的 outbox（持久化），回网后按序合并进共享账本；
 *   合并失败则从最近可用结果恢复，原批次保留在 retainedBatches 可重试。
 * - BroadcastChannel + storage 事件双通道通知其他标签页刷新。
 */
import { createLedger, replay } from './core';
import { LEGACY_KEY, migrateV1 } from './migrate';
import type {
  AppendResult,
  DerivedState,
  LedgerEvent,
  LedgerEventPayload,
  NewEvent,
  RetainedBatch,
} from './types';

export const SHARED_KEY = 'a11y-audit-ledger-v2';
export const RETAINED_KEY = 'a11y-audit-retained-v2';
const CHANNEL_NAME = 'a11y-audit-ledger-sync';
const ACTOR_KEY = 'a11y-audit-actor';
/** 每个标签页独立的离线暂存键 */
export const outboxKey = (actor: string) => `a11y-audit-outbox-${actor}`;

/** 离线暂存：events 里 baseSeq 大于 baseHead 的都是本地临时编号，合并时需重映射 */
interface Outbox {
  baseHead: number;
  events: NewEvent[];
}

export interface LedgerClient {
  readonly actor: string;
  readonly state: DerivedState;
  readonly outbox: Outbox;
  readonly retainedBatches: RetainedBatch[];
  readonly online: boolean;
  readonly migrated: boolean;
  init(): void;
  /** baseSeq 可显式指定（例如表单开始编辑时的编号），缺省用当前视图编号 */
  commit(issueId: string, payload: LedgerEventPayload, baseSeq?: number): Promise<AppendResult>;
  flush(): Promise<void>;
  retryRetained(batchId: string): Promise<void>;
  setOnline(online: boolean): void;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

interface SharedLog {
  events: LedgerEvent[];
}

const hasDOM = () => typeof window !== 'undefined' && typeof localStorage !== 'undefined';

function readJSON<T>(key: string): T | null {
  if (!hasDOM()) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** 首次运行的演示数据：同样走账本追加，可重放、可审计 */
function seedEvents(): NewEvent[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return [
    {
      actor: '系统',
      issueId: 'issue-1',
      baseSeq: 0,
      at: at(120),
      payload: {
        type: 'issue.created',
        title: '结算弹窗关闭后焦点丢失',
        flow: '订单结算',
        steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
        impactGroup: '键盘与读屏用户',
        severity: 'serious',
      },
    },
    { actor: '系统', issueId: 'issue-1', baseSeq: 1, at: at(60), payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } },
    {
      actor: '系统',
      issueId: 'issue-2',
      baseSeq: 2,
      at: at(100),
      payload: {
        type: 'issue.created',
        title: '错误提示未与输入框关联',
        flow: '账户设置',
        steps: '输入无效手机号后使用读屏读取输入框',
        impactGroup: '读屏用户',
        severity: 'moderate',
      },
    },
    { actor: '系统', issueId: 'issue-2', baseSeq: 3, at: at(90), payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } },
    { actor: '系统', issueId: 'issue-2', baseSeq: 4, at: at(80), payload: { type: 'issue.status_changed', from: 'triaged', to: 'fixing' } },
    {
      actor: '系统',
      issueId: 'issue-2',
      baseSeq: 5,
      at: at(70),
      payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '已增加 aria-describedby，等待构建' }] },
    },
  ];
}

function writeJSON(key: string, value: unknown): void {
  if (!hasDOM()) return;
  localStorage.setItem(key, JSON.stringify(value));
}

async function withLedgerLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) {
    return locks.request('a11y-audit-ledger-lock', fn) as Promise<T>;
  }
  return fn();
}

export function createLedgerClient(): LedgerClient {
  const actor = (() => {
    if (!hasDOM()) return 'server';
    // sessionStorage 按标签页隔离：每个标签页一个来源标识
    const existing = sessionStorage.getItem(ACTOR_KEY);
    if (existing) return existing;
    const id = `标签页-${crypto.randomUUID().slice(0, 8)}`;
    sessionStorage.setItem(ACTOR_KEY, id);
    return id;
  })();

  let sharedEvents: LedgerEvent[] = [];
  let outbox: Outbox = { baseHead: 0, events: [] };
  let retained: RetainedBatch[] = [];
  let online = true;
  let migrated = false;
  let state: DerivedState = replay([]);
  const listeners = new Set<() => void>();
  let channel: BroadcastChannel | null = null;
  let destroyed = false;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  /** 本地视图 = 共享账本 + 离线暂存（乐观重放，临时编号接在共享编号之后） */
  const rebuild = () => {
    const ledger = createLedger(sharedEvents);
    for (const input of outbox.events) {
      // 乐观应用；个别暂时套不上的记录保留在 outbox 等回网后正式合并
      ledger.append(input);
    }
    state = ledger.state;
    return ledger;
  };

  const persistOutbox = () => writeJSON(outboxKey(actor), outbox);
  const persistRetained = () => writeJSON(RETAINED_KEY, retained);
  const persistShared = () => writeJSON(SHARED_KEY, { events: sharedEvents } satisfies SharedLog);

  const broadcast = () => {
    try {
      channel?.postMessage({ kind: 'committed', actor });
    } catch {
      /* 通道不可用时靠 storage 事件兜底 */
    }
  };

  const reloadShared = () => {
    sharedEvents = readJSON<SharedLog>(SHARED_KEY)?.events ?? [];
    retained = readJSON<RetainedBatch[]>(RETAINED_KEY) ?? retained;
    rebuild();
    notify();
  };

  /** 在锁内把一批记录合并进共享账本；失败则共享账本保持最近可用结果，批次被保留 */
  const mergeIntoShared = async (inputs: NewEvent[], source: string, baseHead?: number): Promise<boolean> => {
    const retain = (error: string, recoveredSeq: number) => {
      retained = [
        ...retained,
        { id: crypto.randomUUID(), at: new Date().toISOString(), source, events: inputs, error, recoveredSeq, baseHead },
      ];
      persistRetained();
      return false;
    };
    try {
      return await withLedgerLock(async () => {
        const current = readJSON<SharedLog>(SHARED_KEY)?.events ?? [];
        const ledger = createLedger(current);
        const headBefore = ledger.state.headSeq;
        // 离线期间连续记录时 baseSeq 是本地临时编号，按序重映射到共享编号
        let lastSeq = headBefore;
        for (const input of inputs) {
          const isTemp = baseHead !== undefined && input.baseSeq > baseHead;
          const result = ledger.append({ ...input, baseSeq: isTemp ? lastSeq : input.baseSeq });
          if (!result.ok) {
            // 合并失败：共享账本不动，整批保留
            return retain(result.reason, headBefore);
          }
          lastSeq = result.event.seq;
        }
        sharedEvents = ledger.events;
        persistShared();
        broadcast();
        return true;
      });
    } catch (error) {
      // 共享账本本身损坏等意外：不改动共享账本，批次保留
      return retain(error instanceof Error ? error.message : String(error), 0);
    }
  };

  let flushing: Promise<void> | null = null;
  const flush = () => {
    // 并发触发（online 事件 + 手动点击）只跑一轮，避免同一批记录被合并两次
    flushing ??= (async () => {
      while (online && outbox.events.length > 0) {
        const batch = outbox;
        const ok = await mergeIntoShared(batch.events, '离线队列合并', batch.baseHead);
        if (!ok) {
          // 失败：原批次已保留到 retainedBatches；flush 期间新进的记录留在暂存
          outbox = { baseHead: 0, events: outbox.events.slice(batch.events.length) };
          persistOutbox();
          reloadShared();
          return;
        }
        // 本轮已合并的移除；期间新进的记录保留临时编号链，进入下一轮
        const remaining = outbox.events.slice(batch.events.length);
        outbox = remaining.length > 0 ? { baseHead: batch.baseHead, events: remaining } : { baseHead: 0, events: [] };
        persistOutbox();
      }
      reloadShared();
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === SHARED_KEY || event.key === RETAINED_KEY) reloadShared();
  };
  const onOnline = () => {
    online = true;
    void flush().then(notify);
  };
  const onOffline = () => {
    online = false;
    notify();
  };

  const client: LedgerClient = {
    get actor() {
      return actor;
    },
    get state() {
      return state;
    },
    get outbox() {
      return outbox;
    },
    get retainedBatches() {
      return retained;
    },
    get online() {
      return online;
    },
    get migrated() {
      return migrated;
    },

    init() {
      if (!hasDOM() || destroyed) return;
      online = navigator.onLine;
      outbox = readJSON<Outbox>(outboxKey(actor)) ?? { baseHead: 0, events: [] };
      retained = readJSON<RetainedBatch[]>(RETAINED_KEY) ?? [];

      const existing = readJSON<SharedLog>(SHARED_KEY);
      if (!existing) {
        // 本地旧数据升级：翻译为编号记录后一次性入库，原 v1 数据保留不动
        const legacyRaw = localStorage.getItem(LEGACY_KEY);
        if (legacyRaw) {
          try {
            const inputs = migrateV1(legacyRaw);
            const ledger = createLedger();
            const result = ledger.appendBatch(inputs, '本地数据升级');
            if (result.ok) {
              sharedEvents = ledger.events;
              persistShared();
              migrated = true;
            } else {
              retained = [...retained, result.retained];
              persistRetained();
            }
          } catch (error) {
            retained = [
              ...retained,
              {
                id: crypto.randomUUID(),
                at: new Date().toISOString(),
                source: '本地数据升级',
                events: [],
                error: error instanceof Error ? error.message : String(error),
                recoveredSeq: 0,
              },
            ];
            persistRetained();
          }
        } else {
          // 全新环境：写入种子批次，同样可重放
          const ledger = createLedger();
          ledger.appendBatch(seedEvents(), '初始化示例数据');
          sharedEvents = ledger.events;
          persistShared();
        }
      } else {
        sharedEvents = existing.events;
      }

      rebuild();

      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(CHANNEL_NAME);
        channel.onmessage = () => reloadShared();
      }
      window.addEventListener('storage', onStorage);
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      if (online && outbox.events.length > 0) void flush().then(notify);
      notify();
    },

    async commit(issueId, payload, baseSeq) {
      const input: NewEvent = { actor, issueId, baseSeq: baseSeq ?? state.headSeq, payload };
      if (!online || outbox.events.length > 0) {
        // 先乐观校验：无效记录（如越界流转）直接拒绝，不进暂存，避免回网后污染整批
        const ledger = rebuild();
        const check = ledger.append(input);
        if (!check.ok) {
          notify();
          return { ok: false, reason: check.reason };
        }
        if (outbox.events.length === 0) outbox = { baseHead: input.baseSeq, events: [] };
        outbox = { ...outbox, events: [...outbox.events, input] };
        persistOutbox();
        state = ledger.state;
        notify();
        return { ok: true, event: check.event };
      }
      let result: AppendResult = { ok: false, reason: '提交失败' };
      await withLedgerLock(async () => {
        const current = readJSON<SharedLog>(SHARED_KEY)?.events ?? [];
        const ledger = createLedger(current);
        // baseSeq 用下笔时的视图编号：若别的标签页已先提交，冲突在这里被判定
        result = ledger.append(input);
        if (result.ok) {
          sharedEvents = ledger.events;
          persistShared();
        }
      });
      if (result.ok) broadcast();
      rebuild();
      notify();
      return result;
    },

    flush,
    retryRetained: async (batchId) => {
      const batch = retained.find((item) => item.id === batchId);
      if (!batch) return;
      // 先移除旧记录：若重试仍失败，mergeIntoShared 会写入一条新的保留批次
      retained = retained.filter((item) => item.id !== batchId);
      persistRetained();
      const ok = await mergeIntoShared(batch.events, `${batch.source}（重试）`, batch.baseHead);
      if (ok) persistRetained();
      reloadShared();
    },

    setOnline(value) {
      online = value;
      if (value) void flush();
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    destroy() {
      destroyed = true;
      channel?.close();
      if (hasDOM()) {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    },
  };

  return client;
}

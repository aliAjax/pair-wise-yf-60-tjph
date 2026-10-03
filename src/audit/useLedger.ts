import { createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  canTransition,
  commitMerge,
  loadLedger,
  makeCreatedEvent,
  makeStatusEvent,
  makeUpdatedEvent,
  mergeEvents,
  nextClock,
  replay,
  saveLedger,
  STATUS_LABELS,
  type IssueStatus,
  type LedgerEvent,
  type ReplayedIssue,
  type Severity
} from './ledger';

const TAB_KEY = 'a11y-audit-tab-id';

function tabId(): string {
  if (typeof sessionStorage === 'undefined') return 'server';
  let id = sessionStorage.getItem(TAB_KEY);
  if (!id) {
    id = `tab-${crypto.randomUUID().slice(0, 8)}`;
    sessionStorage.setItem(TAB_KEY, id);
  }
  return id;
}

export interface IssueDraft {
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
}

/**
 * 台账：事件流 + 重放 + 多标签页同步。
 * 所有写操作只追加编号事件，当前问题与时间线全部由重放得出。
 */
export function useLedger() {
  const [events, setEvents] = createSignal<LedgerEvent[]>(loadLedger());
  const [notice, setNotice] = createSignal('');
  const [source] = createSignal(tabId());
  const result = createMemo(() => replay(events()));

  let channel: BroadcastChannel | undefined;

  createEffect(() => saveLedger(events()));

  onMount(() => {
    const incoming = (remote: LedgerEvent) => {
      setEvents((prev) => {
        const next = mergeEvents(prev, [remote]);
        if (next.length !== prev.length) {
          setNotice(`已合并其他标签页的操作：${remote.type}（编号 ${remote.seq}）`);
        }
        return next;
      });
    };

    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('a11y-audit-ledger');
      channel.onmessage = (msg: MessageEvent) => {
        if (msg.data && typeof msg.data === 'object' && typeof (msg.data as LedgerEvent).type === 'string') {
          incoming(msg.data as LedgerEvent);
        }
      };
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'a11y-audit-ledger-v1' || !e.newValue) return;
      try {
        const parsed: unknown = JSON.parse(e.newValue);
        if (Array.isArray(parsed)) {
          const remote = parsed as LedgerEvent[];
          setEvents((prev) => mergeEvents(prev, remote));
        }
      } catch {
        // 忽略损坏的同步载荷
      }
    };
    window.addEventListener('storage', onStorage);

    onCleanup(() => {
      channel?.close();
      window.removeEventListener('storage', onStorage);
    });
  });

  const broadcast = (ev: LedgerEvent) => {
    try {
      channel?.postMessage(ev);
    } catch {
      // 广播不可用时仅靠 localStorage 事件同步
    }
  };

  const append = (ev: LedgerEvent) => {
    setEvents((prev) => [...prev, ev]);
    broadcast(ev);
  };

  /** 建问题：追加编号事件后重放。 */
  const createIssue = (draft: IssueDraft) => {
    const ev = makeCreatedEvent(draft, source(), nextClock(events()));
    append(ev);
    setNotice(`问题已入账（编号 ${ev.seq}）`);
    return ev.issueId;
  };

  /** 改字段：字段级乐观并发，冲突保留两版并标来源。 */
  const updateFields = (issue: ReplayedIssue, patch: Record<string, unknown>) => {
    if (Object.keys(patch).length === 0) return;
    const ev = makeUpdatedEvent(issue, patch, source(), nextClock(events()));
    append(ev);
  };

  /** 状态流转：越界拒绝并保留原状态。 */
  const transition = (issue: ReplayedIssue, to: IssueStatus, note?: string) => {
    if (!canTransition(issue.status, to)) {
      setNotice(`越界状态流转已拒绝：${STATUS_LABELS[issue.status]} → ${STATUS_LABELS[to]}，已保留原状态`);
      return;
    }
    const ev = makeStatusEvent(issue, to, note, source(), nextClock(events()));
    append(ev);
  };

  /** 合并重复项：失败时从最近可用结果恢复，原批次保留。 */
  const merge = (dupId: string, canonicalId: string) => {
    const { events: restored, result: r } = commitMerge(events(), dupId, canonicalId, source());
    setEvents(restored);
    if (!r.ok) {
      setNotice(`合并失败，已从最近可用结果恢复并保留原批次：${r.error ?? '未知错误'}`);
      return false;
    }
    const ev = restored[restored.length - 1];
    broadcast(ev);
    setNotice(`重复项合并已入账（编号 ${ev.seq}）`);
    return true;
  };

  return {
    events,
    result,
    notice,
    setNotice,
    source,
    createIssue,
    updateFields,
    transition,
    merge
  };
}

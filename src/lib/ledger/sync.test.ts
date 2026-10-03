/**
 * 同步层集成测试：用共享的 localStorage mock 模拟两个标签页。
 * BroadcastChannel 改为手动投递，保证并发时序确定。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createLedgerClient, SHARED_KEY, RETAINED_KEY, outboxKey } from './sync';
import { LEGACY_KEY } from './migrate';
import type { LedgerEvent } from './types';

class StorageMock {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value));
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
}

class BroadcastChannelMock {
  private static all = new Set<BroadcastChannelMock>();
  private inbox: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly name: string) {
    BroadcastChannelMock.all.add(this);
  }
  postMessage(data: unknown) {
    for (const channel of BroadcastChannelMock.all) {
      if (channel !== this) channel.inbox.push(data);
    }
  }
  close() {
    BroadcastChannelMock.all.delete(this);
  }
  /** 测试手动投递：模拟消息到达其他标签页 */
  static deliver() {
    for (const channel of BroadcastChannelMock.all) {
      while (channel.inbox.length > 0) channel.onmessage?.({ data: channel.inbox.shift() });
    }
  }
}

let shared: StorageMock;

function installDOM(session: StorageMock) {
  (globalThis as Record<string, unknown>).localStorage = shared;
  (globalThis as Record<string, unknown>).sessionStorage = session;
  (globalThis as Record<string, unknown>).navigator = { onLine: true };
  (globalThis as Record<string, unknown>).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as Record<string, unknown>).BroadcastChannel = BroadcastChannelMock;
}

function makeClient(session = new StorageMock()) {
  // 每个标签页各自一份 sessionStorage，保证 actor 不同；传入同一份可模拟同一标签页重开
  installDOM(session);
  const client = createLedgerClient();
  client.init();
  return client;
}

const createPayload = (title: string) => ({
  type: 'issue.created' as const,
  title,
  flow: '订单结算',
  steps: '1. 打开弹窗 2. 检查焦点',
  impactGroup: '键盘用户',
  severity: 'serious' as const,
});

const changeNote = (value: string) => ({
  type: 'issue.fields_changed' as const,
  changes: [{ field: 'fixNote' as const, value }],
});

beforeEach(() => {
  shared = new StorageMock();
});

describe('多标签页同步', () => {
  it('后提交的标签页不能盖掉先提交的内容，冲突两版标来源', async () => {
    const a = makeClient();
    const b = makeClient();
    await a.commit('issue-x', createPayload('弹窗焦点丢失'));
    BroadcastChannelMock.deliver(); // b 看到新问题
    expect(b.state.headSeq).toBe(a.state.headSeq);

    // 两个标签页都基于同一编号修改同一字段；a 先提交，b 后提交
    await a.commit('issue-x', changeNote('甲标签页的修复记录'));
    await b.commit('issue-x', changeNote('乙标签页的修复记录'));

    const issue = b.state.issues.find((item) => item.id === 'issue-x')!;
    expect(issue.fixNote).toBe('甲标签页的修复记录');
    const conflict = b.state.conflicts.find((item) => item.field === 'fixNote')!;
    expect(conflict.committed.value).toBe('甲标签页的修复记录');
    expect(conflict.incoming.value).toBe('乙标签页的修复记录');
    expect(conflict.committed.actor).not.toBe(conflict.incoming.actor);
    a.destroy();
    b.destroy();
  });

  it('共享账本落盘，新标签页初始化即可续作', async () => {
    const a = makeClient();
    await a.commit('issue-x', createPayload('弹窗焦点丢失'));
    const persisted = JSON.parse(shared.getItem(SHARED_KEY)!) as { events: LedgerEvent[] };
    expect(persisted.events).toHaveLength(7); // 6 条种子 + 1 条新建

    const b = makeClient();
    expect(b.state.issues.find((item) => item.id === 'issue-x')).toBeTruthy();
    expect(b.state.headSeq).toBe(7);
    a.destroy();
    b.destroy();
  });

  it('视图已刷新但用户基于下笔时的编号保存，仍判冲突不覆盖', async () => {
    const a = makeClient();
    const b = makeClient();
    await a.commit('issue-x', createPayload('弹窗焦点丢失'));
    BroadcastChannelMock.deliver();
    // b 在编号 #7 时开始编辑；a 随后提交了同字段修改，b 的视图也已刷新
    const editBase = b.state.headSeq;
    await a.commit('issue-x', changeNote('甲先提交的修复记录'));
    BroadcastChannelMock.deliver();
    expect(b.state.issues.find((item) => item.id === 'issue-x')!.fixNote).toBe('甲先提交的修复记录');

    // b 保存自己下笔时（#7）写的内容：不能盖掉 a 的提交
    await b.commit('issue-x', changeNote('乙后提交的修复记录'), editBase);
    const issue = b.state.issues.find((item) => item.id === 'issue-x')!;
    expect(issue.fixNote).toBe('甲先提交的修复记录');
    expect(b.state.conflicts.find((item) => item.field === 'fixNote')!.incoming.value).toBe('乙后提交的修复记录');
    a.destroy();
    b.destroy();
  });
});

describe('离线暂存与回网合并', () => {
  it('离线改动进暂存，回网后合并进共享账本，冲突不丢失', async () => {
    const a = makeClient();
    const b = makeClient();
    await a.commit('issue-x', createPayload('弹窗焦点丢失'));
    BroadcastChannelMock.deliver();

    // a 离线，连续记两条
    a.setOnline(false);
    await a.commit('issue-x', changeNote('离线时的修复记录'));
    await a.commit('issue-x', { type: 'issue.status_changed', from: 'open', to: 'triaged' });
    expect(a.outbox.events).toHaveLength(2);
    // 离线期间本地仍可见自己的改动
    expect(a.state.issues.find((item) => item.id === 'issue-x')!.fixNote).toBe('离线时的修复记录');

    // b 在线改了同一字段
    await b.commit('issue-x', changeNote('在线的修复记录'));

    // a 回网：离线批次合并进去，字段冲突两版并存
    a.setOnline(true);
    await a.flush();
    expect(a.outbox.events).toHaveLength(0);
    const issue = a.state.issues.find((item) => item.id === 'issue-x')!;
    expect(issue.fixNote).toBe('在线的修复记录');
    expect(issue.status).toBe('triaged');
    const conflict = a.state.conflicts.find((item) => item.field === 'fixNote')!;
    expect(conflict.incoming.value).toBe('离线时的修复记录');
    a.destroy();
    b.destroy();
  });

  it('离线时无效记录当场拒绝，不进暂存', async () => {
    const a = makeClient();
    await a.commit('issue-x', createPayload('弹窗焦点丢失'));
    a.setOnline(false);
    const result = await a.commit('issue-x', { type: 'issue.status_changed', from: 'open', to: 'closed' });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/状态流转越界/);
    expect(a.outbox.events).toHaveLength(0);
    expect(a.state.issues.find((item) => item.id === 'issue-x')!.status).toBe('open');
    a.destroy();
  });

  it('合并失败：共享账本保持最近可用结果，原批次保留可重试', async () => {
    const session = new StorageMock();
    const a = makeClient(session);
    await a.commit('issue-x', createPayload('弹窗焦点丢失'));
    const goodSeq = a.state.headSeq;

    // 模拟版本差异/异常写入：暂存里出现一条当时合法、如今无效的记录
    shared.setItem(
      outboxKey(a.actor),
      JSON.stringify({
        baseHead: goodSeq,
        events: [
          { actor: a.actor, issueId: 'issue-x', baseSeq: goodSeq, payload: changeNote('合法记录') },
          { actor: a.actor, issueId: 'issue-x', baseSeq: goodSeq + 1, payload: { type: 'issue.status_changed', from: 'open', to: 'closed' } },
        ],
      }),
    );
    a.destroy();

    // 同一标签页重开：加载暂存并自动合并，含无效记录的批次整体失败
    const a2 = makeClient(session);
    await a2.flush();

    // 最近可用结果未被污染
    const persisted = JSON.parse(shared.getItem(SHARED_KEY)!) as { events: LedgerEvent[] };
    expect(persisted.events).toHaveLength(goodSeq);
    // 原批次完整保留
    expect(a2.retainedBatches).toHaveLength(1);
    expect(a2.retainedBatches[0].events).toHaveLength(2);
    expect(a2.retainedBatches[0].recoveredSeq).toBe(goodSeq);
    expect(JSON.parse(shared.getItem(RETAINED_KEY)!)).toHaveLength(1);
    a2.destroy();
  });
});

describe('本地旧数据升级', () => {
  it('存在 v1 数据时升级为编号账本，问题与时间线保留', async () => {
    shared.setItem(
      LEGACY_KEY,
      JSON.stringify({
        issues: [
          {
            id: 'old-1',
            title: '旧版遗留问题',
            flow: '账户设置',
            steps: '读屏读取输入框',
            impactGroup: '读屏用户',
            severity: 'moderate',
            status: 'fixing',
            fixNote: '修复中',
            retestNote: '',
            updatedAt: '2026-09-01T08:00:00.000Z',
          },
        ],
        events: [{ id: 'e-1', at: '2026-09-01T07:00:00.000Z', issueId: 'old-1', message: '审核员确认问题有效' }],
      }),
    );
    const client = makeClient();
    expect(client.migrated).toBe(true);
    const issue = client.state.issues.find((item) => item.id === 'old-1')!;
    expect(issue.status).toBe('fixing');
    expect(issue.fixNote).toBe('修复中');
    const note = client.state.timeline.find((entry) => entry.kind === 'legacy.note')!;
    expect(note.message).toBe('审核员确认问题有效');
    expect(note.at).toBe('2026-09-01T07:00:00.000Z');
    // 旧数据原样保留不删除
    expect(shared.getItem(LEGACY_KEY)).toBeTruthy();
    client.destroy();
  });

  it('空环境首次初始化写入可重放的种子批次', async () => {
    const client = makeClient();
    expect(client.state.issues.length).toBeGreaterThan(0);
    expect(client.state.headSeq).toBe(client.state.timeline.length);
    client.destroy();
  });
});

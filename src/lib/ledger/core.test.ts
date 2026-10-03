import { describe, expect, it } from 'vitest';
import { createLedger, deriveVerdict, replay, transitionPath } from './core';
import { migrateV1 } from './migrate';
import type { IssueStatus, LedgerEvent, NewEvent } from './types';

let counter = 0;
const options = {
  id: () => `test-${++counter}`,
  now: () => new Date(1_700_000_000_000 + counter * 1000).toISOString(),
};

const createInput = (actor: string, issueId: string, baseSeq: number, title = '结算弹窗焦点丢失'): NewEvent => ({
  actor,
  issueId,
  baseSeq,
  payload: {
    type: 'issue.created',
    title,
    flow: '订单结算',
    steps: '1. 打开结算弹窗 2. Esc 关闭 3. 检查焦点',
    impactGroup: '键盘用户',
    severity: 'serious',
  },
});

const freshLedger = () => createLedger([], options);

describe('追加编号记录与重放', () => {
  it('建问题、改状态、合并重复项都追加编号记录，重放得出当前问题和时间线', () => {
    const ledger = freshLedger();
    expect(ledger.append(createInput('甲', 'a', 0)).ok).toBe(true);
    expect(ledger.append(createInput('甲', 'b', 1, '重复的焦点问题')).ok).toBe(true);
    expect(
      ledger.append({ actor: '乙', issueId: 'a', baseSeq: 2, payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } }).ok,
    ).toBe(true);
    expect(ledger.append({ actor: '乙', issueId: 'b', baseSeq: 3, payload: { type: 'issue.merged', canonicalId: 'a' } }).ok).toBe(true);

    expect(ledger.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);

    const state = ledger.state;
    const a = state.issues.find((issue) => issue.id === 'a')!;
    const b = state.issues.find((issue) => issue.id === 'b')!;
    expect(a.status).toBe('triaged');
    expect(b.canonicalId).toBe('a');
    expect(state.headSeq).toBe(4);
    expect(state.timeline.map((entry) => entry.kind)).toEqual([
      'issue.created',
      'issue.created',
      'issue.status_changed',
      'issue.merged',
    ]);

    // 重放是同一份账：直接 replay 原始记录得到相同结果
    expect(replay(ledger.events)).toEqual(state);
  });

  it('编号重复的记录拒绝重放', () => {
    const events: LedgerEvent[] = [
      { seq: 1, id: 'x', at: '', actor: '甲', issueId: 'a', baseSeq: 0, payload: createInput('甲', 'a', 0).payload },
      { seq: 1, id: 'y', at: '', actor: '乙', issueId: 'b', baseSeq: 0, payload: createInput('乙', 'b', 0).payload },
    ];
    expect(() => replay(events)).toThrowError(/编号 #1 重复/);
  });
});

describe('多标签页并发：后提交不盖掉先提交', () => {
  it('同一字段并发修改：先提交生效，后提交保留为冲突版本并标出来源', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    // 甲、乙都基于 #1 修改修复记录
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '甲的修复方案' }] } });
    const result = ledger.append({ actor: '乙', issueId: 'a', baseSeq: 1, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '乙的修复方案' }] } });
    expect(result.ok).toBe(true);

    const issue = ledger.state.issues[0];
    // 后提交没有盖掉先提交
    expect(issue.fixNote).toBe('甲的修复方案');

    const conflict = ledger.state.conflicts.find((item) => item.field === 'fixNote')!;
    expect(conflict.resolved).toBe(false);
    expect(conflict.committed).toMatchObject({ value: '甲的修复方案', actor: '甲' });
    expect(conflict.incoming).toMatchObject({ value: '乙的修复方案', actor: '乙' });
    expect(conflict.committed.seq).toBeLessThan(conflict.incoming.seq);
    // 时间线里能看到冲突记录
    expect(ledger.state.timeline.some((entry) => entry.kind === 'conflict.detected')).toBe(true);
  });

  it('不同字段并发修改互不干扰，各自生效', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '修复说明' }] } });
    ledger.append({ actor: '乙', issueId: 'a', baseSeq: 1, payload: { type: 'issue.fields_changed', changes: [{ field: 'retestNote', value: '复测说明' }] } });
    const issue = ledger.state.issues[0];
    expect(issue.fixNote).toBe('修复说明');
    expect(issue.retestNote).toBe('复测说明');
    expect(ledger.state.conflicts).toHaveLength(0);
  });

  it('并发状态流转：后提交的流转不生效，状态两版并存', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } });
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 2, payload: { type: 'issue.status_changed', from: 'triaged', to: 'fixing' } });
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 3, payload: { type: 'issue.status_changed', from: 'fixing', to: 'verifying' } });
    // 甲先提交「复测通过」，乙基于旧版本提交「复测失败」
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 4, payload: { type: 'issue.status_changed', from: 'verifying', to: 'closed' } });
    const stale = ledger.append({ actor: '乙', issueId: 'a', baseSeq: 4, payload: { type: 'issue.status_changed', from: 'verifying', to: 'reopened' } });
    expect(stale.ok).toBe(true);

    const issue = ledger.state.issues[0];
    expect(issue.status).toBe('closed');
    const conflict = ledger.state.conflicts.find((item) => item.field === 'status')!;
    expect(conflict.committed).toMatchObject({ value: 'closed', actor: '甲' });
    expect(conflict.incoming).toMatchObject({ value: 'reopened', actor: '乙' });
  });

  it('解决冲突：采用后提交版本后该字段更新', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '先提交' }] } });
    ledger.append({ actor: '乙', issueId: 'a', baseSeq: 1, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '后提交' }] } });
    const conflict = ledger.state.conflicts[0];
    const resolved = ledger.append({
      actor: '丙',
      issueId: 'a',
      baseSeq: ledger.state.headSeq,
      payload: { type: 'conflict.resolved', conflictId: conflict.id, field: 'fixNote', keep: 'incoming' },
    });
    expect(resolved.ok).toBe(true);
    expect(ledger.state.issues[0].fixNote).toBe('后提交');
    expect(ledger.state.conflicts[0].resolved).toBe(true);
    expect(ledger.state.conflicts[0].resolution).toBe('incoming');
  });
});

describe('状态机', () => {
  it('越界流转被拒绝，原状态保留，账本不追加记录', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    const before = ledger.events.length;
    const result = ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.status_changed', from: 'open', to: 'closed' } });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/状态流转越界/);
    expect(ledger.state.issues[0].status).toBe('open');
    expect(ledger.events).toHaveLength(before);
  });

  it('合法链路 open→triaged→fixing→verifying→closed 全部放行', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    const steps: Array<[IssueStatus, IssueStatus]> = [
      ['open', 'triaged'],
      ['triaged', 'fixing'],
      ['fixing', 'verifying'],
      ['verifying', 'closed'],
    ];
    steps.forEach(([from, to], index) => {
      const result = ledger.append({ actor: '甲', issueId: 'a', baseSeq: index + 1, payload: { type: 'issue.status_changed', from, to } });
      expect(result.ok).toBe(true);
    });
    expect(ledger.state.issues[0].status).toBe('closed');
  });

  it('transitionPath 能绕过闭环找到迁移路径', () => {
    expect(transitionPath('open', 'open')).toEqual([]);
    expect(transitionPath('open', 'reopened')).toEqual([
      ['open', 'triaged'],
      ['triaged', 'fixing'],
      ['fixing', 'verifying'],
      ['verifying', 'reopened'],
    ]);
  });
});

describe('判定作废重算', () => {
  it('状态更新后已确认的判定作废、重算并退回待复核', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    const text = ledger.state.issues[0].verdict.text;
    ledger.append({ actor: '审核员', issueId: 'a', baseSeq: 1, payload: { type: 'verdict.confirmed', text } });
    expect(ledger.state.issues[0].verdict).toMatchObject({ state: 'confirmed', confirmedBy: '审核员' });

    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 2, payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } });
    const verdict = ledger.state.issues[0].verdict;
    expect(verdict.state).toBe('pending');
    expect(verdict.confirmedBy).toBeUndefined();
    expect(verdict.text).toBe(deriveVerdict({ status: 'triaged', severity: 'serious' }));
    expect(ledger.state.timeline.at(-1)!.message).toContain('作废重算');
  });

  it('基于旧状态的判定确认过期不生效', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } });
    // 乙基于 #1（状态还没变）确认判定
    ledger.append({ actor: '乙', issueId: 'a', baseSeq: 1, payload: { type: 'verdict.confirmed', text: '过期判定' } });
    expect(ledger.state.issues[0].verdict.state).toBe('pending');
  });
});

describe('批次合并失败恢复', () => {
  it('合并失败回滚到最近可用结果，原批次保留', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    ledger.append({ actor: '甲', issueId: 'a', baseSeq: 1, payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } });
    const goodSeq = ledger.state.headSeq;
    const goodState = ledger.state;

    const result = ledger.appendBatch(
      [
        { actor: '乙', issueId: 'a', baseSeq: 2, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '离线修复记录' }] } },
        // 损坏记录：指向不存在的问题
        { actor: '乙', issueId: 'ghost', baseSeq: 2, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: 'x' }] } },
      ],
      '离线队列合并',
    );

    expect(result.ok).toBe(false);
    // 从最近可用结果恢复：状态与失败前一致，批内第一条也没有部分生效
    expect(ledger.state).toEqual(goodState);
    expect(ledger.state.headSeq).toBe(goodSeq);
    expect(ledger.state.issues[0].fixNote).toBe('');
    // 原批次完整保留
    expect(ledger.retainedBatches).toHaveLength(1);
    expect(ledger.retainedBatches[0].events).toHaveLength(2);
    expect(ledger.retainedBatches[0].recoveredSeq).toBe(goodSeq);
    expect(ledger.retainedBatches[0].source).toBe('离线队列合并');
  });

  it('离线合法批次回网后成功合并，临时 baseSeq 不影响', () => {
    const ledger = freshLedger();
    ledger.append(createInput('甲', 'a', 0));
    const result = ledger.appendBatch(
      [
        { actor: '乙', issueId: 'a', baseSeq: 1, payload: { type: 'issue.status_changed', from: 'open', to: 'triaged' } },
        { actor: '乙', issueId: 'a', baseSeq: 2, payload: { type: 'issue.fields_changed', changes: [{ field: 'fixNote', value: '离线记录' }] } },
      ],
      '离线队列合并',
    );
    expect(result.ok).toBe(true);
    expect(ledger.state.issues[0].status).toBe('triaged');
    expect(ledger.state.issues[0].fixNote).toBe('离线记录');
  });
});

describe('本地旧数据升级', () => {
  const legacy = {
    issues: [
      {
        id: 'issue-1',
        title: '结算弹窗关闭后焦点丢失',
        flow: '订单结算',
        steps: '1. 打开结算弹窗',
        impactGroup: '键盘与读屏用户',
        severity: 'serious',
        status: 'fixing',
        fixNote: '已增加焦点回收',
        retestNote: '',
        updatedAt: '2026-09-30T08:00:00.000Z',
      },
      {
        id: 'issue-2',
        title: '重复的焦点问题',
        flow: '订单结算',
        steps: '同上',
        impactGroup: '键盘用户',
        severity: 'minor',
        status: 'open',
        canonicalId: 'issue-1',
        fixNote: '',
        retestNote: '',
        updatedAt: '2026-09-30T09:00:00.000Z',
      },
    ],
    events: [
      { id: 'e-1', at: '2026-09-30T07:00:00.000Z', issueId: 'issue-1', message: '审核员确认问题有效' },
      { id: 'e-2', at: '2026-09-30T07:30:00.000Z', issueId: 'issue-1', message: '开发人员开始修复' },
    ],
  };

  it('升级后原问题、状态、合并关系和时间线全部保留', () => {
    const inputs = migrateV1(JSON.stringify(legacy));
    const ledger = freshLedger();
    const result = ledger.appendBatch(inputs, '本地数据升级');
    expect(result.ok).toBe(true);

    const first = ledger.state.issues.find((issue) => issue.id === 'issue-1')!;
    expect(first.status).toBe('fixing');
    expect(first.fixNote).toBe('已增加焦点回收');
    const second = ledger.state.issues.find((issue) => issue.id === 'issue-2')!;
    expect(second.canonicalId).toBe('issue-1');

    // 旧时间线消息按原时间保留
    const legacyNotes = ledger.state.timeline.filter((entry) => entry.kind === 'legacy.note');
    expect(legacyNotes).toHaveLength(2);
    expect(legacyNotes[0]).toMatchObject({ at: '2026-09-30T07:00:00.000Z', message: '审核员确认问题有效' });

    // 迁移链路本身也是合法状态机路径
    expect(ledger.events.every((event, index) => event.seq === index + 1)).toBe(true);
  });

  it('无法识别的旧数据抛出错误而不是静默吞掉', () => {
    expect(() => migrateV1('{"foo":1}')).toThrowError(/无法识别/);
  });
});

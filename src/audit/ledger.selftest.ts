/**
 * 台账自检：编号事件、重放、并发冲突、状态机拒绝、判定作废、合并回滚、旧数据升级。
 * 运行：npx tsx src/audit/ledger.selftest.ts
 */
import assert from 'node:assert/strict';
import {
  canTransition,
  commitMerge,
  currentOf,
  isConflict,
  mergeEvents,
  migrateLegacy,
  nextClock,
  replay,
  type LedgerEvent,
  type ReplayedIssue
} from './ledger';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function setup() {
  let events: LedgerEvent[] = [];
  const seq = () => nextClock(events);
  const add = (e: LedgerEvent) => { events.push(e); };
  return { events: () => events, add, seq };
}

function created(over: Partial<Record<string, unknown>> = {}, source = 'tab-a') {
  return {
    id: crypto.randomUUID(),
    type: 'issue.created' as const,
    issueId: crypto.randomUUID(),
    seq: 0,
    at: new Date().toISOString(),
    source,
    title: '测试问题',
    flow: '流程A',
    steps: '复现步骤',
    impactGroup: '读屏用户',
    severity: 'serious' as const,
    status: 'open' as const,
    ...over
  };
}

function statusEv(issue: ReplayedIssue, to: ReplayedIssue['status'], source: string, seq: number, from?: ReplayedIssue['status']) {
  return {
    id: crypto.randomUUID(),
    type: 'issue.statusChanged' as const,
    issueId: issue.id,
    seq,
    at: new Date().toISOString(),
    source,
    from: from ?? issue.status,
    to,
    baseClock: issue.lastClock
  };
}

function updatedEv(issue: ReplayedIssue, patch: Record<string, unknown>, source: string, seq: number) {
  return {
    id: crypto.randomUUID(),
    type: 'issue.updated' as const,
    issueId: issue.id,
    seq,
    at: new Date().toISOString(),
    source,
    patch,
    baseClock: issue.lastClock
  };
}

async function main() {
  // 1. 建问题：先追加编号事件，再重放得出当前问题
  check('建问题：追加编号事件后重放得出问题与时间线', () => {
    const s = setup();
    const ev = created();
    ev.seq = s.seq();
    s.add(ev);
    const r = replay(s.events());
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].title, '测试问题');
    assert.equal(r.issues[0].status, 'open');
    assert.equal(r.timeline.length, 1);
    assert.equal(r.maxClock, 1);
  });

  // 2. 状态流转
  check('状态流转：open→triaged→fixing→verifying→closed 正常', () => {
    const s = setup();
    const ev = created();
    ev.seq = s.seq();
    s.add(ev);
    let issue = replay(s.events()).issues[0];
    for (const [from, to] of [['open', 'triaged'], ['triaged', 'fixing'], ['fixing', 'verifying'], ['verifying', 'closed']] as const) {
      assert.equal(canTransition(from, to), true);
      s.add(statusEv(issue, to, 'tab-a', s.seq()));
      issue = replay(s.events()).issues[0];
      assert.equal(issue.status, to);
    }
    assert.equal(replay(s.events()).timeline.filter((t) => t.kind === 'status').length, 4);
  });

  // 3. 越界流转拒绝并保留原状态
  check('状态流转越界：open 直接 closed 被拒绝，原状态保留', () => {
    const s = setup();
    const ev = created();
    ev.seq = s.seq();
    s.add(ev);
    const issue = replay(s.events()).issues[0];
    s.add(statusEv(issue, 'closed', 'tab-b', s.seq()));
    const r = replay(s.events());
    assert.equal(r.issues[0].status, 'open');
    const rejected = r.timeline.find((t) => t.message.includes('越界状态流转已拒绝'));
    assert.ok(rejected);
    assert.equal(rejected.source, 'tab-b');
  });

  // 4. 多标签页并发改同一字段：后提交不盖掉先提交，两版保留标来源
  check('并发冲突：两标签页同改标题，两版均保留并标来源', () => {
    const s = setup();
    const ev = created();
    ev.seq = s.seq();
    s.add(ev);
    const issue = replay(s.events()).issues[0];
    s.add(updatedEv(issue, { title: '标签页甲的标题' }, 'tab-a', s.seq()));
    // 标签页乙基于旧状态（lastClock=1）也改标题
    const stale = replay(s.events()).issues[0];
    s.add({ ...updatedEv(stale, { title: '标签页乙的标题' }, 'tab-b', s.seq()), baseClock: 1 });
    const r = replay(s.events());
    const title = r.issues[0].title;
    assert.ok(isConflict(title));
    assert.equal(title.versions.length, 2);
    assert.equal(title.versions[0].source, 'tab-a');
    assert.equal(title.versions[1].source, 'tab-b');
    assert.equal(currentOf(title).value, '标签页乙的标题');
    assert.ok(r.timeline.some((t) => t.kind === 'conflict'));
  });

  // 5. 并发改不同字段：合并不冲突
  check('并发修改不同字段：自动合并，无冲突标记', () => {
    const s = setup();
    const ev = created();
    ev.seq = s.seq();
    s.add(ev);
    const issue = replay(s.events()).issues[0];
    s.add(updatedEv(issue, { flow: '新流程' }, 'tab-a', s.seq()));
    const stale = replay(s.events()).issues[0];
    s.add({ ...updatedEv(stale, { steps: '新步骤' }, 'tab-b', s.seq()), baseClock: 1 });
    const r = replay(s.events());
    assert.equal(isConflict(r.issues[0].flow), false);
    assert.equal(r.issues[0].flow, '新流程');
    assert.equal(r.issues[0].steps, '新步骤');
  });

  // 6. 状态更新后已确认判定作废重算，退回待复核
  check('判定作废：已分诊问题被改内容后退回待复核，时间线留痕', () => {
    const s = setup();
    const ev = created({ status: 'triaged' });
    ev.seq = s.seq();
    s.add(ev);
    const issue = replay(s.events()).issues[0];
    s.add(updatedEv(issue, { severity: 'critical' }, 'tab-a', s.seq()));
    const r = replay(s.events());
    assert.equal(r.issues[0].status, 'open');
    assert.ok(r.timeline.some((t) => t.kind === 'system' && t.message.includes('作废重算')));
  });

  // 7. 提交复测后旧复测判定作废
  check('复测判定作废：提交复测后上一轮复测记录清空', () => {
    const s = setup();
    const ev = created({ status: 'fixing', retestNote: '上一轮复测通过' });
    ev.seq = s.seq();
    s.add(ev);
    const issue = replay(s.events()).issues[0];
    s.add(statusEv(issue, 'verifying', 'tab-a', s.seq()));
    const r = replay(s.events());
    assert.equal(r.issues[0].retestNote, '');
  });

  // 8. 合并重复项
  check('合并：重复项合并到主问题，双向时间线留痕', () => {
    const s = setup();
    const a = created({ title: '主问题' });
    a.seq = s.seq();
    s.add(a);
    const b = created({ title: '重复问题' });
    b.seq = s.seq();
    s.add(b);
    const dup = replay(s.events()).issues.find((i) => i.title === '重复问题')!;
    const { events: next, result } = commitMerge(s.events(), dup.id, a.issueId, 'tab-a');
    assert.equal(result.ok, true);
    const r = replay(next);
    const merged = r.issues.find((i) => i.id === dup.id)!;
    assert.equal(merged.canonicalId, a.issueId);
    assert.ok(r.timeline.some((t) => t.kind === 'merge' && t.issueId === a.issueId));
  });

  // 9. 合并失败回滚：主问题本身是重复项时失败，原批次保留
  check('合并失败：目标是重复项时回滚，事件流恢复且不追加', () => {
    const s = setup();
    const a = created({ title: '主问题A' });
    a.seq = s.seq();
    s.add(a);
    const b = created({ title: '重复B' });
    b.seq = s.seq();
    s.add(b);
    const c = created({ title: '重复C' });
    c.seq = s.seq();
    s.add(c);
    // 先把 B 合并到 A
    let r0 = replay(s.events());
    const bIssue = r0.issues.find((i) => i.title === '重复B')!;
    const { events: e1 } = commitMerge(s.events(), bIssue.id, a.issueId, 'tab-a');
    s.add(e1[e1.length - 1]);
    // C 尝试合并到 B（B 已是重复项）→ 必须失败并回滚
    r0 = replay(s.events());
    const cIssue = r0.issues.find((i) => i.title === '重复C')!;
    const before = s.events().length;
    const { events: restored, result } = commitMerge(s.events(), cIssue.id, bIssue.id, 'tab-b');
    assert.equal(result.ok, false);
    assert.equal(restored.length, before);
    assert.equal(replay(restored).issues.find((i) => i.id === cIssue.id)!.canonicalId, undefined);
  });

  // 10. 旧数据升级：原问题与时间线保留
  check('旧数据升级：a11y-audit-v1 迁移后问题与时间线原样保留', () => {
    const legacy = {
      issues: [
        { id: 'p1', title: '旧问题', flow: '旧流程', steps: '旧步骤', impactGroup: '旧人群', severity: 'minor', status: 'closed', fixNote: '已修', retestNote: '通过', updatedAt: '2026-09-01T00:00:00.000Z' }
      ],
      events: [
        { id: 'old-ev-1', at: '2026-09-02T00:00:00.000Z', issueId: 'p1', message: '旧时间线事件' }
      ]
    };
    const events = migrateLegacy(legacy);
    const r = replay(events);
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].title, '旧问题');
    assert.equal(r.issues[0].status, 'closed');
    assert.equal(r.issues[0].fixNote, '已修');
    assert.equal(r.timeline.some((t) => t.message === '旧时间线事件'), true);
    assert.equal(r.timeline.some((t) => t.message.startsWith('创建问题')), true);
  });

  // 11. 离线改动回网后合并：事件去重、按编号排序
  check('离线同步：远程事件去重合并，编号排序确定', () => {
    const local = setup();
    const e1 = created();
    e1.seq = local.seq();
    local.add(e1);
    const remote = setup();
    const e2 = created();
    e2.seq = 1;
    remote.add(e2);
    const e3 = { ...created(), seq: 2 };
    remote.add(e3);
    const merged = mergeEvents(local.events(), remote.events());
    assert.equal(merged.length, 3);
    assert.deepEqual(merged.map((e) => e.seq), [1, 1, 2]);
    // 重放不依赖到达顺序
    const r1 = replay(merged);
    const r2 = replay([...merged].reverse());
    assert.equal(r1.issues.length, r2.issues.length);
  });

  console.log(`\n全部通过：${passed} 项自检 ✓`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

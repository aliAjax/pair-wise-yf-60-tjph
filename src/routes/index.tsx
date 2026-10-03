import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createQuery } from '@tanstack/solid-query';
import { createForm, reset, setValue, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import { createLedgerClient } from '~/lib/ledger/sync';
import { FIELD_LABELS, SEVERITY_LABELS, STATUS_LABELS, TRANSITIONS } from '~/lib/ledger/core';
import type { DerivedState, IssueStatus, LedgerEventPayload, RetainedBatch, Severity } from '~/lib/ledger/types';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor']),
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '编号账本 · 冲突可续 · 离线可合并', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Numbered ledger · conflicts · offline merge', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' }),
};

const STATUS_ACTIONS: Array<{ to: IssueStatus; label: string; danger?: boolean }> = [
  { to: 'triaged', label: '确认问题' },
  { to: 'fixing', label: '开始修复' },
  { to: 'verifying', label: '提交复测' },
  { to: 'closed', label: '复测通过' },
  { to: 'reopened', label: '复测失败重开', danger: true },
];

const EMPTY_STATE: DerivedState = { issues: [], conflicts: [], timeline: [], headSeq: 0 };

interface ViewState {
  state: DerivedState;
  outboxCount: number;
  retained: RetainedBatch[];
  online: boolean;
  migrated: boolean;
}

export default function AuditWorkbench() {
  const client = createLedgerClient();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [view, setView] = createStore<ViewState>({ state: EMPTY_STATE, outboxCount: 0, retained: [], online: true, migrated: false });
  const [selectedId, setSelectedId] = createSignal('');
  const [mergeInto, setMergeInto] = createSignal('');
  const [lastError, setLastError] = createSignal('');
  const [lastNotice, setLastNotice] = createSignal('');
  const [drafts, setDrafts] = createStore({ title: '', severity: 'moderate' as Severity, fixNote: '', retestNote: '' });
  /** 用户开始编辑时基于的账本编号：保存时带上它，别人先提交的修改才不会被盖掉 */
  const [editBase, setEditBase] = createSignal(0);
  const [dirty, setDirty] = createStore({ title: false, severity: false, fixNote: false, retestNote: false });

  const syncView = () =>
    setView({
      state: client.state,
      outboxCount: client.outbox.events.length,
      retained: [...client.retainedBatches],
      online: client.online,
      migrated: client.migrated,
    });

  onMount(() => {
    client.init();
    const unsubscribe = client.subscribe(syncView);
    syncView();
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => {
      unsubscribe();
      client.destroy();
      window.removeEventListener('keydown', shortcut);
    });
  });

  const selected = createMemo(() => view.state.issues.find((issue) => issue.id === selectedId()) ?? view.state.issues[0]);

  // 只在切换问题时重载草稿：后台同步不打断正在输入的内容，
  // 用户下笔时的编号（editBase）保留到保存时用于冲突判定
  createEffect(
    on(
      () => selected()?.id,
      () => {
        const issue = selected();
        if (!issue) return;
        setDrafts({ title: issue.title, severity: issue.severity, fixNote: issue.fixNote, retestNote: issue.retestNote });
        setDirty({ title: false, severity: false, fixNote: false, retestNote: false });
        setEditBase(view.state.headSeq);
      },
    ),
  );

  const issueQuery = createQuery(() => ({
    queryKey: ['audit-issues', view.state.headSeq],
    queryFn: async () =>
      new Promise<DerivedState['issues']>((resolve) => {
        if (typeof window === 'undefined') return resolve(view.state.issues);
        window.setTimeout(() => resolve(view.state.issues), 60);
      }),
  }));

  const commit = async (issueId: string, payload: LedgerEventPayload, baseSeq?: number) => {
    const wasOnline = client.online;
    const result = await client.commit(issueId, payload, baseSeq);
    if (!result.ok) {
      setLastError(result.reason);
      setLastNotice('');
    } else {
      setLastError('');
      setLastNotice(wasOnline ? `已追加记录 #${result.event.seq}，重放到账` : '已记入离线暂存，回网后自动合并');
    }
    syncView();
    return result.ok;
  };

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema),
  });

  const createIssue = async (values: IssueForm) => {
    const id = crypto.randomUUID();
    if (await commit(id, { type: 'issue.created', ...values })) {
      setSelectedId(id);
      reset(form);
    }
  };

  const saveFields = async () => {
    const issue = selected();
    if (!issue) return;
    if (dirty.title && !drafts.title.trim()) {
      setLastError('标题不能为空');
      return;
    }
    // 只提交用户真正改过的字段，并带上开始编辑时的编号
    const changes = [
      ...(dirty.title && drafts.title !== issue.title ? [{ field: 'title' as const, value: drafts.title }] : []),
      ...(dirty.severity && drafts.severity !== issue.severity ? [{ field: 'severity' as const, value: drafts.severity }] : []),
      ...(dirty.fixNote && drafts.fixNote !== issue.fixNote ? [{ field: 'fixNote' as const, value: drafts.fixNote }] : []),
      ...(dirty.retestNote && drafts.retestNote !== issue.retestNote ? [{ field: 'retestNote' as const, value: drafts.retestNote }] : []),
    ];
    if (changes.length === 0) {
      setLastNotice(dirty.title || dirty.severity || dirty.fixNote || dirty.retestNote ? '修改内容与账本一致，无需保存' : '没有需要保存的修改');
      return;
    }
    if (await commit(issue.id, { type: 'issue.fields_changed', changes }, editBase())) {
      setDirty({ title: false, severity: false, fixNote: false, retestNote: false });
      setEditBase(view.state.headSeq);
    }
  };

  const mergeDuplicate = async () => {
    const issue = selected();
    if (!issue || !mergeInto()) return;
    if (await commit(issue.id, { type: 'issue.merged', canonicalId: mergeInto() })) setMergeInto('');
  };

  const timelineDesc = createMemo(() => [...view.state.timeline].sort((a, b) => b.seq - a.seq).slice(0, 15));
  const selectedConflicts = createMemo(() => view.state.conflicts.filter((item) => item.issueId === selected()?.id && !item.resolved));
  const pendingVerdicts = createMemo(() => view.state.issues.filter((issue) => issue.verdict.state === 'pending').length);
  const openConflicts = createMemo(() => view.state.conflicts.filter((item) => !item.resolved).length);

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">WCAG 人工审计协作</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p>
          </div>
          <div class="toolbar">
            <span class="badge" title="本标签页来源标识">{client.actor}</span>
            <span class={`badge ${view.online ? 'ok' : 'offline'}`} aria-live="polite">
              {view.online ? '在线' : '离线'}<Show when={view.outboxCount > 0}> · {view.outboxCount} 条待合并</Show>
            </span>
            <button class="secondary" onClick={() => { client.setOnline(!view.online); syncView(); }}>
              {view.online ? '模拟离线' : '恢复在线'}
            </button>
            <Show when={view.online && view.outboxCount > 0}>
              <button class="secondary" onClick={() => void client.flush().then(syncView)}>立即合并</button>
            </Show>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <Show when={view.migrated}>
          <p class="banner notice" role="status">本地旧数据已升级为编号账本：原问题、状态与时间线全部保留，可继续协作。</p>
        </Show>
        <Show when={lastError()}>
          <p class="banner error" role="alert">{lastError()}</p>
        </Show>
        <Show when={lastNotice()}>
          <p class="banner notice" role="status">{lastNotice()}</p>
        </Show>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{view.state.issues.length}</strong></div>
          <div class="card"><span>判定待复核</span><strong>{pendingVerdicts()}</strong></div>
          <div class="card"><span>未解决冲突</span><strong>{openConflicts()}</strong></div>
          <div class="card"><span>账本编号</span><strong>#{view.state.headSeq}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{issueQuery.isSuccess ? '同步正常' : '同步中'}</small></h2>
            <For each={view.state.issues}>{(issue) => (
              <article class="issue">
                <h3>
                  <button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selected()?.id === issue.id ? 'true' : undefined}>
                    {issue.title}
                  </button>
                </h3>
                <div class="meta">
                  <span class="badge">{STATUS_LABELS[issue.status]}</span>
                  <span class="badge">{SEVERITY_LABELS[issue.severity]}</span>
                  <span>{issue.flow}</span>
                  <span>{issue.impactGroup}</span>
                  <span class={`badge ${issue.verdict.state === 'confirmed' ? 'ok' : 'warn'}`}>{issue.verdict.state === 'confirmed' ? '判定已确认' : '待复核'}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                  <Show when={view.state.conflicts.some((item) => item.issueId === issue.id && !item.resolved)}>
                    <span class="badge conflict">有冲突</span>
                  </Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>{(_) => {
              const issue = selected()!;
              return <>
                <div class="verdict">
                  <strong>判定：</strong>{issue.verdict.text}{' '}
                  <span class={`badge ${issue.verdict.state === 'confirmed' ? 'ok' : 'warn'}`}>
                    {issue.verdict.state === 'confirmed' ? `已确认 · ${issue.verdict.confirmedBy}` : '待复核'}
                  </span>
                  <div style="margin-top:8px">
                    <button
                      class="secondary"
                      disabled={issue.verdict.state === 'confirmed'}
                      onClick={() => void commit(issue.id, { type: 'verdict.confirmed', text: issue.verdict.text })}
                    >
                      确认当前判定
                    </button>{' '}
                    <small>状态更新后已确认的判定会作废重算并退回待复核</small>
                  </div>
                </div>

                <div role="group" aria-label="问题状态操作">
                  <For each={STATUS_ACTIONS}>{(action) => {
                    const allowed = () => TRANSITIONS[issue.status].includes(action.to);
                    return (
                      <button
                        class={action.danger ? 'danger' : ''}
                        disabled={!allowed()}
                        title={allowed() ? `流转到${STATUS_LABELS[action.to]}` : `当前状态（${STATUS_LABELS[issue.status]}）不能流转到${STATUS_LABELS[action.to]}，越界会被拒绝`}
                        onClick={() => void commit(issue.id, { type: 'issue.status_changed', from: issue.status, to: action.to })}
                      >
                        {action.label}
                      </button>
                    );
                  }}</For>
                </div>
                <p><small>可流转：{TRANSITIONS[issue.status].map((s) => STATUS_LABELS[s]).join('、') || '无（终态）'} · 下笔基于编号 #{view.state.headSeq}</small></p>

                <div class="detail-grid">
                  <label>标题<input value={drafts.title} onInput={(event) => { setDrafts('title', event.currentTarget.value); setDirty('title', true); }} /></label>
                  <label>严重程度
                    <select value={drafts.severity} onChange={(event) => { setDrafts('severity', event.currentTarget.value as Severity); setDirty('severity', true); }}>
                      <For each={Object.entries(SEVERITY_LABELS) as Array<[Severity, string]>}>{([value, label]) => <option value={value}>{label}</option>}</For>
                    </select>
                  </label>
                  <label>修复记录<textarea rows={2} value={drafts.fixNote} onInput={(event) => { setDrafts('fixNote', event.currentTarget.value); setDirty('fixNote', true); }} /></label>
                  <label>复测记录<textarea rows={2} value={drafts.retestNote} onInput={(event) => { setDrafts('retestNote', event.currentTarget.value); setDirty('retestNote', true); }} /></label>
                  <div><button onClick={() => void saveFields()}>保存修改</button> <small>下笔基于编号 #{editBase()}；与其他标签页同时改同一字段时，两版都会保留并标出来源</small></div>
                </div>

                <Show when={selectedConflicts().length > 0}>
                  <div class="conflict-card" role="group" aria-label="字段冲突">
                    <strong>字段冲突（{selectedConflicts().length}）：先提交的已生效，后提交的保留待处理</strong>
                    <For each={selectedConflicts()}>{(conflict) => (
                      <div class="versions">
                        <div class="version">
                          <strong>先提交 · 生效中</strong>
                          <div>{FIELD_LABELS[conflict.field]}：{conflict.committed.value || '（空）'}</div>
                          <small>{conflict.committed.actor} · {new Date(conflict.committed.at).toLocaleString()} · #{conflict.committed.seq}</small>
                          <div><button class="secondary" onClick={() => void commit(conflict.issueId, { type: 'conflict.resolved', conflictId: conflict.id, field: conflict.field, keep: 'committed' })}>保留此版</button></div>
                        </div>
                        <div class="version">
                          <strong>后提交 · 待处理</strong>
                          <div>{FIELD_LABELS[conflict.field]}：{conflict.incoming.value || '（空）'}</div>
                          <small>{conflict.incoming.actor} · {new Date(conflict.incoming.at).toLocaleString()} · #{conflict.incoming.seq}</small>
                          <div><button class="secondary" onClick={() => void commit(conflict.issueId, { type: 'conflict.resolved', conflictId: conflict.id, field: conflict.field, keep: 'incoming' })}>采用此版</button></div>
                        </div>
                      </div>
                    )}</For>
                  </div>
                </Show>

                <hr />
                <Show when={!issue.canonicalId} fallback={<p>已合并到主问题：{view.state.issues.find((item) => item.id === issue.canonicalId)?.title ?? issue.canonicalId}</p>}>
                  <label>{t()('merge')}
                    <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                      <option value="">选择主问题</option>
                      <For each={view.state.issues.filter((item) => item.id !== issue.id && !item.canonicalId)}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                    </select>
                  </label>
                  <button disabled={!mergeInto()} onClick={() => void mergeDuplicate()}>确认重复合并</button>
                </Show>
              </>;
            }}</Show>
          </section>
        </div>

        <Show when={view.retained.length > 0}>
          <section class="card retained" style="margin-top:18px" aria-labelledby="retained-title">
            <h2 id="retained-title">合并失败保留的批次（{view.retained.length}）</h2>
            <For each={view.retained}>{(batch) => (
              <article class="issue">
                <div class="meta">
                  <span class="badge conflict">{batch.source}</span>
                  <span>{new Date(batch.at).toLocaleString()}</span>
                  <span>{batch.events.length} 条记录</span>
                  <span>已恢复到最近可用编号 #{batch.recoveredSeq}</span>
                </div>
                <p class="error">{batch.error}</p>
                <button class="secondary" onClick={() => void client.retryRetained(batch.id).then(syncView)}>重试合并该批次</button>
              </article>
            )}</For>
          </section>
        </Show>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={(values) => void createIssue(values)} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} onInput={(event) => setValue(form, 'title', event.currentTarget.value)} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} onInput={(event) => setValue(form, 'flow', event.currentTarget.value)} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => setValue(form, 'steps', event.currentTarget.value)} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field) => <label>影响人群<select value={field.value} onChange={(event) => setValue(form, 'impactGroup', event.currentTarget.value)}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field) => <label>严重程度<select value={field.value} onChange={(event) => setValue(form, 'severity', event.currentTarget.value as IssueForm['severity'])}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={timelineDesc()}>{(entry) => (
                    <div class={`timeline-item ${entry.kind === 'conflict.detected' ? 'conflict' : ''}`}>
                      <span class="seq">#{entry.seq}</span>
                      <strong>{new Date(entry.at).toLocaleString()}</strong> <span class="badge">{entry.actor}</span>
                      <div>{entry.message}</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}

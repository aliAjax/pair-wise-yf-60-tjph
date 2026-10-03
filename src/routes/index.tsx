import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createForm, reset, setValue, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import { useLedger, type IssueDraft } from '~/audit/useLedger';
import {
  canTransition,
  currentOf,
  isConflict,
  nextClock,
  SEVERITY_LABELS,
  STATUS_LABELS,
  type FieldValue,
  type IssueStatus,
  type ReplayedIssue,
  type Severity,
  type TimelineKind
} from '~/audit/ledger';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、修复与复测协作 · 编号事件账，多标签页并发不互盖', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, fixes and retesting · append-only ledger with multi-tab merge', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const KIND_LABELS: Record<TimelineKind, string> = {
  activity: '操作',
  status: '状态',
  merge: '合并',
  system: '系统',
  conflict: '冲突'
};

const FLOW_ACTIONS: { to: IssueStatus; label: string; note?: string; danger?: boolean }[] = [
  { to: 'triaged', label: '确认问题' },
  { to: 'fixing', label: '开始修复', note: '修复进行中，等待提交复测版本' },
  { to: 'verifying', label: '提交复测' },
  { to: 'closed', label: '复测通过', note: '复测通过，关闭问题' },
  { to: 'reopened', label: '复测失败', note: '复测未通过，重新打开', danger: true },
  { to: 'fixing', label: '重新修复', note: '重新提交修复' }
];

function ConflictBlock(props: { label: string; versions: { value: unknown; source: string; at: string; seq: number }[] }) {
  return (
    <div class="conflict" role="group" aria-label={`${props.label}字段冲突，保留两版并标出来源`}>
      <strong>字段冲突 · 保留 {props.versions.length} 版，后提交未覆盖先提交：</strong>
      <For each={props.versions}>{(v) => (
        <div class="conflict-version">
          <span>「{String(v.value)}」</span>
          <small>来源 {v.source} · 编号 {v.seq} · {new Date(v.at).toLocaleString()}</small>
        </div>
      )}</For>
    </div>
  );
}

function FieldLine(props: { issue: ReplayedIssue; field: 'flow' | 'steps' | 'impactGroup'; label: string }) {
  const v = (): FieldValue<string> => props.issue[props.field];
  const meta = () => props.issue.fieldMeta[props.field];
  if (isConflict(v())) {
    return <ConflictBlock label={props.label} versions={currentOf(v()).versions} />;
  }
  return (
    <p>
      <strong>{props.label}：</strong>{String(currentOf(v()).value || '—')}
      <Show when={meta()}><small class="src">（来源 {meta()!.source}）</small></Show>
    </p>
  );
}

export default function AuditWorkbench() {
  const { result, events, notice, setNotice, source, createIssue, updateFields, transition, merge } = useLedger();
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [selectedId, setSelectedId] = createSignal(result().issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [focusedIssueId, setFocusedIssueId] = createSignal('');

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => result().issues.find((issue) => issue.id === selectedId()) ?? result().issues[0]);
  const selectedConflicts = createMemo(() => result().conflicts.filter((c) => c.issueId === selected()?.id));
  const timeline = createMemo(() => [...result().timeline].reverse());

  const [draft, setDraft] = createSignal<IssueDraft>({ title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' });
  createEffect(() => {
    const i = selected();
    if (i) {
      setDraft({
        title: currentOf(i.title).value,
        flow: currentOf(i.flow).value,
        steps: currentOf(i.steps).value,
        impactGroup: currentOf(i.impactGroup).value,
        severity: currentOf(i.severity).value
      });
    }
  });

  const submitCreate = (values: IssueForm) => {
    const id = createIssue(values);
    setSelectedId(id);
    setMergeInto('');
    reset(form);
  };

  const saveEdit = () => {
    const i = selected();
    if (!i) return;
    const d = draft();
    const patch: Record<string, unknown> = {};
    if (d.title !== currentOf(i.title).value) patch.title = d.title;
    if (d.flow !== currentOf(i.flow).value) patch.flow = d.flow;
    if (d.steps !== currentOf(i.steps).value) patch.steps = d.steps;
    if (d.impactGroup !== currentOf(i.impactGroup).value) patch.impactGroup = d.impactGroup;
    if (d.severity !== currentOf(i.severity).value) patch.severity = d.severity;
    if (Object.keys(patch).length === 0) {
      setNotice('没有需要保存的修改');
      return;
    }
    updateFields(i, patch);
    setNotice(`修改已追加编号事件（编号 ${nextClock(events())}），重放后生效`);
  };

  const doMerge = () => {
    const dup = selected();
    if (!dup || !mergeInto()) return;
    const ok = merge(dup.id, mergeInto());
    if (ok) {
      setSelectedId(mergeInto());
      setMergeInto('');
    }
  };

  const ctrlEnter = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      saveEdit();
    }
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">WCAG 人工审计协作</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 当前标签页 {source()} · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p>
          </div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <div class="notice" role="status" aria-live="polite">{notice() || '账本就绪：所有改动先追加编号事件，再重放生效'}</div>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{result().issues.length}</strong></div>
          <div class="card"><span>待修复</span><strong>{result().issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length}</strong></div>
          <div class="card"><span>待复测</span><strong>{result().issues.filter((issue) => issue.status === 'verifying').length}</strong></div>
          <div class="card"><span>已关闭</span><strong>{result().issues.filter((issue) => issue.status === 'closed').length}</strong></div>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>编号事件账 · 重放中</small></h2>
            <For each={result().issues}>{(issue) => (
              <article class="issue" style={focusedIssueId() === issue.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                <h3>
                  <button class="secondary" onClick={() => { setSelectedId(issue.id); setFocusedIssueId(issue.id); }} aria-current={selectedId() === issue.id ? 'true' : undefined}>
                    {currentOf(issue.title).value}
                  </button>
                </h3>
                <div class="meta">
                  <span class="badge">{STATUS_LABELS[issue.status]}</span>
                  <span class="badge">{SEVERITY_LABELS[currentOf(issue.severity).value as Severity] ?? currentOf(issue.severity).value}</span>
                  <span>{currentOf(issue.flow).value}</span>
                  <span>{currentOf(issue.impactGroup).value}</span>
                  <Show when={issue.canonicalId}><span class="badge">重复项</span></Show>
                  <Show when={result().conflicts.some((c) => c.issueId === issue.id)}><span class="badge conflict-badge">字段冲突 · 两版</span></Show>
                </div>
              </article>
            )}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>
              {(issueSignal) => {
                const issue = () => issueSignal();
                return (<>
                  <h3>{currentOf(issue().title).value}</h3>
                  <Show when={isConflict(issue().title)}>
                    <ConflictBlock label="标题" versions={currentOf(issue().title).versions} />
                  </Show>

                  <FieldLine issue={issue()} field="flow" label="业务流程" />
                  <FieldLine issue={issue()} field="steps" label="复现步骤" />
                  <FieldLine issue={issue()} field="impactGroup" label="受影响人群" />
                  <p><strong>严重程度：</strong>{SEVERITY_LABELS[currentOf(issue().severity).value as Severity] ?? currentOf(issue().severity).value}</p>
                  <Show when={issue().fixNote}><p><strong>修复记录：</strong>{issue().fixNote}</p></Show>
                  <Show when={issue().retestNote}><p><strong>复测记录：</strong>{issue().retestNote}</p></Show>
                  <Show when={issue().canonicalId}><p class="merged-note">本问题为重复项，已合并到主问题（{issue().canonicalId}）</p></Show>

                  <hr />
                  <h4>状态流转</h4>
                  <div role="group" aria-label="问题状态操作">
                    <For each={FLOW_ACTIONS}>{(action) => (
                      <button
                        class={action.danger ? 'danger' : 'secondary'}
                        disabled={!canTransition(issue().status, action.to)}
                        title={canTransition(issue().status, action.to) ? `执行：${action.label}` : `越界：${STATUS_LABELS[issue().status]} 不能流转到 ${STATUS_LABELS[action.to]}，将被拒绝并保留原状态`}
                        onClick={() => transition(issue(), action.to, action.note)}
                      >
                        {action.label}
                      </button>
                    )}</For>
                  </div>

                  <hr />
                  <h4>合并重复项</h4>
                  <label>合并到主问题
                    <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                      <option value="">选择问题</option>
                      <For each={result().issues.filter((item) => item.id !== issue().id && !item.canonicalId)}>
                        {(item) => <option value={item.id}>{currentOf(item.title).value}</option>}
                      </For>
                    </select>
                  </label>
                  <button disabled={!mergeInto()} onClick={doMerge}>确认重复合并</button>

                  <hr />
                  <h4>修改内容（并发冲突保留两版）</h4>
                  <div class="edit-form" onKeyDown={ctrlEnter}>
                    <label>标题<input value={draft().title} onInput={(e) => setDraft({ ...draft(), title: e.currentTarget.value })} /></label>
                    <label>业务流程<input value={draft().flow} onInput={(e) => setDraft({ ...draft(), flow: e.currentTarget.value })} /></label>
                    <label>复现步骤<textarea rows={3} value={draft().steps} onInput={(e) => setDraft({ ...draft(), steps: e.currentTarget.value })} /></label>
                    <label>受影响人群
                      <select value={draft().impactGroup} onChange={(e) => setDraft({ ...draft(), impactGroup: e.currentTarget.value })}>
                        <option>键盘与读屏用户</option>
                        <option>低视力用户</option>
                        <option>认知障碍用户</option>
                        <option>行动障碍用户</option>
                      </select>
                    </label>
                    <label>严重程度
                      <select value={draft().severity} onChange={(e) => setDraft({ ...draft(), severity: e.currentTarget.value as Severity })}>
                        <option value="critical">阻断</option>
                        <option value="serious">严重</option>
                        <option value="moderate">中等</option>
                        <option value="minor">轻微</option>
                      </select>
                    </label>
                    <button onClick={saveEdit}>保存修改（追加编号事件）</button>
                  </div>
                  <Show when={selectedConflicts().length > 0}>
                    <div class="conflict" role="alert">
                      <strong>本问题有 {selectedConflicts().length} 处并发冲突，两版均已保留并标来源：</strong>
                      <For each={selectedConflicts()}>{(c) => (
                        <div class="conflict-version">
                          字段「{c.field}」：
                          <For each={c.versions}>{(v) => <span>「{String(v.value)}」（{v.source} · 编号 {v.seq}）</span>}</For>
                        </div>
                      )}</For>
                    </div>
                  </Show>
                </>
              );
            }}
            </Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={submitCreate} style="margin-top:12px">
              <AuditField name="title">{(field, props) => (
                <label>问题标题
                  <input id="issue-title" {...props} value={field.value} onInput={(event) => setValue(form, 'title', event.currentTarget.value)} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} />
                  <Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show>
                </label>
              )}</AuditField>
              <AuditField name="flow">{(field, props) => (
                <label>业务流程<input {...props} value={field.value} onInput={(event) => setValue(form, 'flow', event.currentTarget.value)} /></label>
              )}</AuditField>
              <AuditField name="steps">{(field, props) => (
                <label>复现步骤<textarea {...props} rows={4} value={field.value} onInput={(event) => setValue(form, 'steps', event.currentTarget.value)} /></label>
              )}</AuditField>
              <AuditField name="impactGroup">{(field) => (
                <label>受影响人群
                  <select value={field.value} onChange={(event) => setValue(form, 'impactGroup', event.currentTarget.value)}>
                    <option>键盘与读屏用户</option>
                    <option>低视力用户</option>
                    <option>认知障碍用户</option>
                    <option>行动障碍用户</option>
                  </select>
                </label>
              )}</AuditField>
              <AuditField name="severity">{(field) => (
                <label>严重程度
                  <select value={field.value} onChange={(event) => setValue(form, 'severity', event.currentTarget.value as Severity)}>
                    <option value="critical">阻断</option>
                    <option value="serious">严重</option>
                    <option value="moderate">中等</option>
                    <option value="minor">轻微</option>
                  </select>
                </label>
              )}</AuditField>
              <button type="submit">创建问题（追加编号事件）</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')} <small>编号 · 来源 · 重放</small></h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={timeline().slice(0, 30)}>{(entry) => (
                    <div class={`timeline-entry kind-${entry.kind}`} style="margin-bottom:12px">
                      <strong>编号 {entry.seq} · {new Date(entry.at).toLocaleString()} · {entry.source}</strong>
                      <span class="badge kind-badge">{KIND_LABELS[entry.kind]}</span>
                      <div>{entry.message}</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="keyboard"><ul>
                <li><kbd>N</kbd>：聚焦新建问题标题</li>
                <li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li>
                <li><kbd>Ctrl+Enter</kbd>：在修改区提交，追加编号事件</li>
                <li>多标签页同时修改同一问题：冲突字段保留两版并标出来源，后提交不盖先提交</li>
                <li>越界状态流转一律拒绝并保留原状态；合并失败自动回滚到最近可用结果</li>
              </ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}

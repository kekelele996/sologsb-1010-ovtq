import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, makeRule, outputText, updateRuleInSet } from './braille';
import LayoutPreview from './layout-preview';
import { computeLayout, downgradeAffectedLines, paginateProject } from './pagination';
import type { PaginationSettings } from './types';
import { createInitialProject } from './sample';
import type { HistoryState, LinePaginationOverride, ProofIssue, ProjectState, TextbookLine, VersionSnapshot } from './types';

const STORAGE_KEY = 'sologsb-1010-braille-project-v1';
const HISTORY_LIMIT = 60;

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

function loadInitialState(): ProjectState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProjectState;
      return paginateProject(analyzeProject(parsed));
    }
  } catch {
    // 清除损坏草稿并使用内置示例。
  }
  return createInitialProject();
}

function useProject() {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: loadInitialState(),
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.present));
  }, [history.present]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function emptyLine(): TextbookLine {
  return { id: `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规则集与规则编辑">
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用规则</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前规则"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用规则' : '查看全部规则'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑规则会在校对区生成提醒">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规则" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑规则" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
  onMove,
  paginationHint,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
  onMove: (direction: -1 | 1) => void;
  paginationHint?: string;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="上移一行" title="上移一行（行序变化后受影响的已批准行回到待核对）" onClick={(event: MouseEvent) => { event.stopPropagation(); onMove(-1); }}>↑</md-icon-button>
            <md-icon-button aria-label="下移一行" title="下移一行" onClick={(event: MouseEvent) => { event.stopPropagation(); onMove(1); }}>↓</md-icon-button>
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {paginationHint && <div class="line-warnings"><span class="issue-chip info">排版 · {paginationHint}</span></div>}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  view,
  layout,
  onViewChange,
  onSelectLine,
  onChangeLine,
  onMoveLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
  onPaginationSettings,
  onSetBreak,
  onToggleForcePage,
  onResetPagination,
  onPrint,
}: {
  state: ProjectState;
  view: 'proof' | 'layout';
  layout: ReturnType<typeof computeLayout>;
  onViewChange: (view: 'proof' | 'layout') => void;
  onSelectLine: (id: string, scroll?: boolean) => void;
  onChangeLine: (id: string, source: string) => void;
  onMoveLine: (id: string, direction: -1 | 1) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
  onPaginationSettings: (settings: PaginationSettings) => void;
  onSetBreak: (lineId: string, fragmentIndex: number, position: number | null) => void;
  onToggleForcePage: (lineId: string, force: boolean) => void;
  onResetPagination: () => void;
  onPrint: () => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格 · 排版 {layout.pages.length} 页</p>
        </div>
        <div class="toolbar-stack">
          <div class="view-tabs" role="tablist">
            <button class={view === 'proof' ? 'active' : ''} onClick={() => onViewChange('proof')}>逐行校对</button>
            <button class={view === 'layout' ? 'active' : ''} onClick={() => onViewChange('layout')}>排版预览 {layout.pages.length > 0 && <span>{layout.pages.length}</span>}</button>
          </div>
          <div class="toolbar-actions">
            <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
            <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
            <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
          </div>
        </div>
      </div>

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      {view === 'proof' ? (
        <div class="line-list scroll-pane">
          {state.lines.map((line, index) => {
            const meta = layout.lineMeta.get(line.id);
            const rowCount = (meta?.effectiveBreaks.length ?? 0) + 1;
            const uniquePages = meta ? [...new Set(meta.pages)].map((page) => page + 1) : [];
            const hint = uniquePages.length > 1
              ? `跨 ${uniquePages.length} 页（第 ${uniquePages.join('、')} 页）· ${rowCount} 个印刷行`
              : rowCount > 1
                ? `${rowCount} 个印刷行`
                : '';
            return (
            <LineCard
              key={line.id}
              line={line}
              index={index}
              selected={state.selectedLineId === line.id}
              issues={state.issues}
              onSelect={() => onSelectLine(line.id)}
              onChange={(source) => onChangeLine(line.id, source)}
              onNote={(note) => onNote(line.id, note)}
              onStatus={(status) => onStatus(line.id, status)}
              onDelete={() => onDelete(line.id)}
              onMove={(direction) => onMoveLine(line.id, direction)}
              paginationHint={hint}
            />
            );
          })}
        </div>
      ) : (
        <LayoutPreview
          state={state}
          layout={layout}
          onSettings={onPaginationSettings}
          onSetBreak={onSetBreak}
          onToggleForcePage={onToggleForcePage}
          onResetOverrides={onResetPagination}
          onJumpLine={(lineId) => onSelectLine(lineId, true)}
          onPrint={onPrint}
        />
      )}
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({ state, onUpdateRule, onDeleteRule }: { state: ProjectState; onUpdateRule: (id: string, patch: Record<string, unknown>) => void; onDeleteRule: (id: string) => void }) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row"><span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span><span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span></div>
      </div>
      {active.rules.map((rule) => (
        <div class="rule-detail-card" key={rule.id}>
          <div>
            <strong>{rule.source || '数字符'}</strong>
            <span>{rule.output} · {rule.kind}</span>
            {rule.description && <p>{rule.description}</p>}
          </div>
          <div class="rule-detail-actions">
            <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
            <md-icon-button aria-label="删除规则" title="删除规则" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
          </div>
        </div>
      ))}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const { state, history, commit, undo, redo, restore } = useProject();
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions'>('issues');
  const [editorView, setEditorView] = useState<'proof' | 'layout'>('proof');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  /** 原文/规则/行序变化：重转录、重分页，并把受影响的已批准行打回待核对。 */
  const reanalyze = (current: ProjectState, update: (draft: ProjectState) => ProjectState): ProjectState => {
    const updated = update(current);
    const analyzed = analyzeProject(updated);
    return paginateProject(downgradeAffectedLines(analyzed, current));
  };

  const layout = useMemo(() => computeLayout(state), [state]);

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) {
      requestAnimationFrame(() => {
        document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        document.querySelector(`#layout-row-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => reanalyze(current, (draft) => ({ ...draft, lines: draft.lines.map((line) => line.id === lineId ? { ...line, source } : line) })));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    printWindow.document.write(buildPrintHtml(state, layout));
    printWindow.document.close();
  };

  const updatePaginationSettings = (pagination: PaginationSettings) => {
    commit('调整版心（每行格数/每页行数）', (current) => paginateProject({ ...current, pagination }));
  };

  const updateLineOverride = (lineId: string, patch: Partial<LinePaginationOverride>) => {
    commit('调整分页', (current) => {
      const previous = current.paginationOverrides[lineId] ?? {};
      const merged: LinePaginationOverride = {
        breaks: 'breaks' in patch ? patch.breaks : previous.breaks,
        forcePageBefore: 'forcePageBefore' in patch ? patch.forcePageBefore : previous.forcePageBefore,
      };
      const overrides = { ...current.paginationOverrides };
      if ((!merged.breaks || merged.breaks.length === 0) && !merged.forcePageBefore) {
        delete overrides[lineId];
      } else {
        overrides[lineId] = merged;
      }
      return paginateProject({ ...current, paginationOverrides: overrides });
    });
  };

  /**
   * fragmentIndex 对应该段序号（>=1），其起点即当前断点位置。
   * 教师首次调整时以当前生效断点为基线接管该行；之后移动即替换该断点；
   * 恢复自动则清除整行断点覆盖。
   */
  const setBreak = (lineId: string, fragmentIndex: number, position: number | null) => {
    const meta = layout.lineMeta.get(lineId);
    if (!meta) return;
    const current = meta.effectiveBreaks[fragmentIndex - 1];
    if (current == null) return;
    if (position == null) {
      updateLineOverride(lineId, { breaks: undefined });
      return;
    }
    const baseline = meta.manualMode ? meta.effectiveBreaks : meta.autoBreaks;
    const breaks = baseline.map((value) => (value === current ? position : value));
    updateLineOverride(lineId, { breaks });
  };

  const resetPaginationOverrides = () => {
    commit('清除全部手动分页调整', (current) => paginateProject({ ...current, paginationOverrides: {} }));
  };

  const moveLine = (lineId: string, direction: -1 | 1) => {
    commit('调整行序', (current) => {
      const index = current.lines.findIndex((line) => line.id === lineId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.lines.length) return current;
      const lines = [...current.lines];
      [lines[index], lines[target]] = [lines[target], lines[index]];
      return reanalyze(current, (draft) => ({ ...draft, lines }));
    });
  };

  const updateRule = (ruleId: string, patch: Record<string, unknown>) => {
    commit('修改转录规则', (current) => reanalyze(current, (draft) => {
      const ruleSet = draft.ruleSets.find((set) => set.id === draft.activeRuleSetId) ?? draft.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, patch);
      return { ...draft, ruleSets: draft.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) };
    }));
  };

  const batchFixRule = (ruleId: string) => {
    commit('批量修正同类问题', (current) => reanalyze(current, (draft) => {
      const ruleSet = draft.ruleSets.find((set) => set.id === draft.activeRuleSetId) ?? draft.ruleSets[0];
      const nextSet = updateRuleInSet(ruleSet, ruleId, { enabled: false });
      return { ...draft, ruleSets: draft.ruleSets.map((set) => set.id === nextSet.id ? nextSet : set) };
    }));
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => reanalyze(current, () => ({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    })));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${navigator.onLine ? 'online' : ''}`} />
          {navigator.onLine ? '浏览器本地保存' : '离线模式 · 本地保存可继续'}
          <small>上次自动保存 {formatTime(state.updatedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规则</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => reanalyze(current, (draft) => ({ ...draft, activeRuleSetId: id, issues: [] })))}
          onUpdateRule={updateRule}
          onToggleContractions={() => {
            const ruleSet = activeRuleSet;
            commit('切换缩写规则', (current) => reanalyze(current, (draft) => ({ ...draft, ruleSets: draft.ruleSets.map((set) => set.id === ruleSet.id ? { ...set, contractions: !set.contractions } : set) })));
          }}
          onAddRule={(source, output, suspicious) => {
            commit('新增转写规则', (current) => reanalyze(current, (draft) => ({
              ...draft,
              ruleSets: draft.ruleSets.map((set) => set.id === draft.activeRuleSetId ? { ...set, rules: [...set.rules, makeRule(source, output, suspicious)] } : set),
            })));
          }}
          onRecheck={() => commit('重新检查全部内容', (current) => paginateProject(analyzeProject(current)))}
        />

        <EditorPanel
          state={state}
          view={editorView}
          layout={layout}
          onViewChange={setEditorView}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onMoveLine={moveLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => reanalyze(current, (draft) => {
            const lines = draft.lines.filter((line) => line.id !== lineId);
            return { ...draft, lines: lines.length ? lines : [emptyLine()], selectedLineId: lines[0]?.id ?? '' };
          }))}
          onAddLine={() => commit('新增课文行', (current) => reanalyze(current, (draft) => {
            const line = emptyLine();
            return { ...draft, lines: [...draft.lines, line], selectedLineId: line.id };
          }))}
          onSplitLongLines={() => commit('按句拆分长行', (current) => reanalyze(current, (draft) => ({
            ...draft,
            lines: draft.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' }))),
          })))}
          onImport={importCourse}
          onPaginationSettings={updatePaginationSettings}
          onSetBreak={setBreak}
          onToggleForcePage={(lineId, force) => updateLineOverride(lineId, { forcePageBefore: force || undefined })}
          onResetPagination={resetPaginationOverrides}
          onPrint={exportPrint}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规则详情</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && <RuleDetailPanel state={state} onUpdateRule={updateRule} onDeleteRule={(ruleId) => {
            commit('删除转录规则', (current) => reanalyze(current, (draft) => ({
              ...draft,
              ruleSets: draft.ruleSets.map((set) => set.id === draft.activeRuleSetId ? { ...set, rules: set.rules.filter((rule) => rule.id !== ruleId) } : set),
            })));
          }} />}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = paginateProject(analyzeProject(cloneState({ ...version.snapshot, versions: state.versions })));
            restore(restored);
          }} />}
        </aside>
      </div>
    </div>
  );
}

const escapeHtml = (text: string): string => text.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char));

const CONTINUATION_TEXT = (row: { continuesWord: boolean; continuesSourceHyphen: boolean; movedToPage: boolean }): string => {
  if (row.continuesWord) return '续接上页 · 同词未完';
  if (row.continuesSourceHyphen) return '续接上页 · 跨行连字符';
  if (row.movedToPage) return '整行移页 · 自上页移入';
  return '';
};

/** 生成与屏幕排版预览一致的 A4 分页打印稿：随当前版心、断点和移页设置输出。 */
export function buildPrintHtml(state: ProjectState, layout: ReturnType<typeof computeLayout>): string {
  const { cellsPerLine, linesPerPage } = layout.settings;
  const date = new Date().toLocaleDateString('zh-CN');
  const activeRuleSet = state.ruleSets.find((set) => set.id === state.activeRuleSetId) ?? state.ruleSets[0];

  // A4 可用宽 182mm、行区高约 258mm；字号取宽高约束的较小值。
  const cellMm = 178 / cellsPerLine;
  const rowMm = 252 / linesPerPage;
  const fontSizeMm = Math.min(cellMm, rowMm * 0.62).toFixed(2);

  const pagesHtml = layout.pages.map((page) => {
    const rowsHtml = Array.from({ length: linesPerPage }, (_, rowSlot) => {
      const row = page.rows[rowSlot];
      if (!row) return '<div class="print-row"></div>';
      const banner = row.pageTop ? CONTINUATION_TEXT(row) : '';
      const text = row.cells.join('').padEnd(cellsPerLine, ' ');
      const tail = row.endsWithinWord ? '⠤' : '';
      const tag = `${String(row.lineIndex + 1).padStart(2, '0')}${row.fragmentIndex > 0 ? `.${row.fragmentIndex + 1}` : ''}`;
      return `<div class="print-row${row.overflow ? ' overflow' : ''}">${banner ? `<span class="print-banner">${escapeHtml(banner)}</span>` : ''}<span class="print-tag">${tag}</span><span class="print-braille">${escapeHtml(text)}${tail}</span></div>`;
    }).join('');

    return `<section class="sheet">
      <header><div>${escapeHtml(state.title)}</div><small>${escapeHtml(state.author)} · ${escapeHtml(activeRuleSet.name)} · ${date}</small></header>
      <div class="print-rows">${rowsHtml}</div>
      <footer>— ${page.index + 1} —</footer>
    </section>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(state.title)} · 打印版</title>
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; color: #111; }
.sheet { width: 210mm; height: 297mm; padding: 10mm 16mm 9mm; display: flex; flex-direction: column; page-break-after: always; position: relative; }
.sheet:last-child { page-break-after: auto; }
.sheet header { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #999; padding-bottom: 3mm; margin-bottom: 4mm; font: 600 12pt Georgia, serif; }
.sheet header small { font: 9pt sans-serif; color: #555; }
.print-rows { flex: 1; display: flex; flex-direction: column; }
.print-row { flex: 1; min-height: 0; display: flex; align-items: center; position: relative; border-bottom: 1px dotted #e2e2e2; }
.print-tag { width: 11mm; color: #888; font: 8pt monospace; flex-shrink: 0; }
.print-braille { font-family: "Apple Braille", "Segoe UI Symbol", "Noto Sans Symbols 2", sans-serif; font-size: ${fontSizeMm}mm; line-height: 1; letter-spacing: 0; white-space: pre; }
.print-row.overflow .print-braille { color: #b3261e; }
.print-banner { position: absolute; top: -3.4mm; left: 11mm; font: 7pt sans-serif; color: #7a4700; background: #fff3df; border: 1px solid #e3c28a; border-radius: 3px; padding: 0 2mm; }
.sheet footer { text-align: center; color: #777; font: 9pt serif; padding-top: 2mm; }
@media screen { body { background: #e7eeeb; } .sheet { margin: 10mm auto; background: #fff; box-shadow: 0 4px 18px rgba(0,0,0,.18); } }
</style></head><body>${pagesHtml}<script>window.onload=()=>setTimeout(()=>window.print(),200)</script></body></html>`;
}

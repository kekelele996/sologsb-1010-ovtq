import { useEffect, useMemo, useState } from 'preact/hooks';
import type { LayoutLineMeta, LayoutRow, PaginationLayout } from './pagination';
import type { PaginationSettings, ProjectState, TextbookLine } from './types';

interface LayoutPreviewProps {
  state: ProjectState;
  layout: PaginationLayout;
  onSettings: (settings: PaginationSettings) => void;
  onSetBreak: (lineId: string, fragmentIndex: number, position: number | null) => void;
  onToggleForcePage: (lineId: string, force: boolean) => void;
  onResetOverrides: () => void;
  onJumpLine: (lineId: string) => void;
  onPrint: () => void;
}

function pageTopBanner(row: LayoutRow): string {
  if (row.continuesWord) return '续接上页：同词未完';
  if (row.continuesSourceHyphen) return '续接上页：跨行连字符';
  if (row.movedToPage) return '整行移页：自上页移入';
  return '';
}

function NumberField({ label, value, min, max, onCommit }: { label: string; value: number; min: number; max: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  return (
    <label class="layout-number-field">
      <span>{label}</span>
      <md-outlined-text-field
        type="number"
        value={draft}
        min={min}
        max={max}
        onFocus={() => setEditing(true)}
        onInput={(event: any) => setDraft(event.currentTarget.value)}
        onChange={(event: any) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next)) onCommit(Math.min(max, Math.max(min, Math.round(next))));
          setEditing(false);
        }}
      />
    </label>
  );
}

function RowTools({
  row,
  totalCells,
  meta,
  onSetBreak,
  onToggleForcePage,
}: {
  row: LayoutRow;
  totalCells: number;
  meta: LayoutLineMeta;
  onSetBreak: (lineId: string, fragmentIndex: number, position: number | null) => void;
  onToggleForcePage: (lineId: string, force: boolean) => void;
}) {
  const fragmentCount = meta.effectiveBreaks.length + 1;
  const breakPosition = row.start;
  // 左移：不能越过前一个断点；右移：不能越过下一个断点。
  const minPosition = row.fragmentIndex === 0 ? 1 : meta.effectiveBreaks[row.fragmentIndex - 1] + 1;
  const maxPosition = row.fragmentIndex < fragmentCount - 1 ? meta.effectiveBreaks[row.fragmentIndex] - 1 : totalCells - 1;

  return (
    <div class="row-tools" onClick={(event: Event) => event.stopPropagation()}>
      {row.fragmentIndex > 0 && (
        <>
          <button class="row-tool" title="断点左移一格" disabled={breakPosition <= minPosition} onClick={() => onSetBreak(row.lineId, row.fragmentIndex, breakPosition - 1)}>←</button>
          <button class={`row-tool ${row.manualBreak ? 'active' : ''}`} title={row.manualBreak ? '恢复自动断点' : '手动固定此断点'} onClick={() => onSetBreak(row.lineId, row.fragmentIndex, row.manualBreak ? null : breakPosition)}>
            {row.manualBreak ? '↕' : '⇄'}
          </button>
          <button class="row-tool" title="断点右移一格" disabled={breakPosition >= maxPosition} onClick={() => onSetBreak(row.lineId, row.fragmentIndex, breakPosition + 1)}>→</button>
        </>
      )}
      {row.fragmentIndex === 0 && (
        <button class={`row-tool ${row.forcePageBefore ? 'active' : ''}`} title={row.forcePageBefore ? '取消整行移页' : '整行移到下一页'} onClick={() => onToggleForcePage(row.lineId, !row.forcePageBefore)}>
          {row.forcePageBefore ? '⤓已移页' : '⤓移页'}
        </button>
      )}
    </div>
  );
}

function PaperRow({
  row,
  line,
  width,
  selected,
  meta,
  onSelect,
  onSetBreak,
  onToggleForcePage,
}: {
  row: LayoutRow;
  line: TextbookLine | undefined;
  width: number;
  selected: boolean;
  meta: LayoutLineMeta;
  onSelect: () => void;
  onSetBreak: (lineId: string, fragmentIndex: number, position: number | null) => void;
  onToggleForcePage: (lineId: string, force: boolean) => void;
}) {
  const banner = pageTopBanner(row);
  const totalCells = meta.totalCells;

  return (
    <div class={`paper-row ${selected ? 'selected' : ''} ${row.pageTop ? 'page-top' : ''}`} id={`layout-row-${row.lineId}`} onClick={onSelect}>
      <span class="row-line-tag" title={`原文第 ${row.lineIndex + 1} 行${line ? `：${line.source}` : ''}`}>
        {String(row.lineIndex + 1).padStart(2, '0')}
        {row.fragmentIndex > 0 && <em>.{row.fragmentIndex + 1}</em>}
      </span>
      <span class={`row-status-dot ${line?.status ?? 'unchecked'}`} />
      <div class="row-main">
        {banner && <span class={`continuation-banner ${row.continuesWord ? 'word' : row.continuesSourceHyphen ? 'hyphen' : 'moved'}`}>{banner}</span>}
        <div class={`braille-grid ${row.overflow ? 'overflow' : ''}`} style={`grid-template-columns: repeat(${width}, 1fr);`}>
          {Array.from({ length: width }, (_, cellIndex) => {
            const cell = row.cells[cellIndex];
            return <span class={`grid-cell ${cell == null ? 'empty' : /\s/u.test(cell) ? 'space' : ''}`}>{cell && !/\s/u.test(cell) ? cell : ''}</span>;
          })}
        </div>
        {row.endsWithinWord && <span class="tail-hyphen" title="词内断行：下一页/下一行续接同一词">⠤</span>}
        {row.fragmentIndex > 0 && !row.pageTop && row.splitWithinWord && <span class="inline-continue">词内续接</span>}
      </div>
      <RowTools row={row} totalCells={totalCells} meta={meta} onSetBreak={onSetBreak} onToggleForcePage={onToggleForcePage} />
    </div>
  );
}

export default function LayoutPreview({ state, layout, onSettings, onSetBreak, onToggleForcePage, onResetOverrides, onJumpLine, onPrint }: LayoutPreviewProps) {
  const overrideCount = useMemo(
    () => Object.values(state.paginationOverrides).reduce((count, item) => count + (item.breaks?.filter((value) => value != null).length ?? 0) + (item.forcePageBefore ? 1 : 0), 0),
    [state.paginationOverrides],
  );
  const selectedId = state.selectedLineId;

  return (
    <div class="layout-preview">
      <div class="layout-toolbar">
        <div class="layout-fields">
          <NumberField label="每行格数" value={layout.settings.cellsPerLine} min={10} max={60} onCommit={(cellsPerLine) => onSettings({ ...layout.settings, cellsPerLine })} />
          <NumberField label="每页行数" value={layout.settings.linesPerPage} min={8} max={40} onCommit={(linesPerPage) => onSettings({ ...layout.settings, linesPerPage })} />
          <div class="layout-summary">
            <strong>{layout.pages.length}</strong><span>页 · {layout.rows.length} 印刷行 · {layout.totalCells} 格</span>
          </div>
          {overrideCount > 0 && <span class="override-pill">{overrideCount} 处手动调整</span>}
        </div>
        <div class="layout-actions">
          <md-text-button onClick={onResetOverrides} disabled={overrideCount === 0}>清除手动调整</md-text-button>
          <md-filled-button onClick={onPrint}>按当前版面打印导出</md-filled-button>
        </div>
      </div>

      <div class="paper-scroll scroll-pane">
        {layout.pages.map((page) => {
          const cellW = Math.max(11, Math.min(22, Math.floor(720 / layout.settings.cellsPerLine)));
          return (
          <section
            class={`paper-page ${page.overflow ? 'has-overflow' : ''}`}
            style={`width: ${cellW * layout.settings.cellsPerLine + 128}px; --cell-w: ${cellW}px;`}
            key={page.index}
          >
            <header class="paper-head">
              <span>{state.title}</span>
              <small>{state.author} · 第 {page.index + 1} 页</small>
            </header>
            <div class="paper-rows" style={`grid-template-rows: repeat(${layout.settings.linesPerPage}, 1fr);`}>
              {page.rows.map((row) => (
                <PaperRow
                  key={`${row.lineId}-${row.fragmentIndex}`}
                  row={row}
                  line={state.lines[row.lineIndex]}
                  width={layout.settings.cellsPerLine}
                  selected={selectedId === row.lineId}
                  meta={layout.lineMeta.get(row.lineId)!}
                  onSelect={() => onJumpLine(row.lineId)}
                  onSetBreak={onSetBreak}
                  onToggleForcePage={onToggleForcePage}
                />
              ))}
            </div>
            <footer class="paper-foot">— {page.index + 1} —</footer>
            {page.overflow && <div class="page-overflow-flag">本页有内容超出 {layout.settings.cellsPerLine} 格，请缩小字号版心或调整断点</div>}
          </section>
          );
        })}
      </div>
    </div>
  );
}

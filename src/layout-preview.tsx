import { useMemo, useState } from 'preact/hooks';
import type { LayoutSettings, PaginatedLayout, ProjectState } from './types';

interface LayoutPreviewProps {
  state: ProjectState;
  layout: PaginatedLayout;
  onChangeLayout: (patch: Partial<LayoutSettings>) => void;
  onResetLayout: () => void;
  onSelectLine: (lineId: string) => void;
  onNudgeBreak: (lineId: string, direction: -1 | 1) => void;
  onClearBreak: (lineId: string) => void;
  onTogglePageBreak: (lineId: string) => void;
}

function NumberStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number) => Math.max(min, Math.min(max, Math.round(next) || min));
  return (
    <label class="layout-stepper">
      <span>{label}</span>
      <div>
        <button type="button" aria-label={`减少${label}`} onClick={() => onChange(clamp(value - 1))}>−</button>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          onInput={(event) => onChange(clamp(Number((event.currentTarget as HTMLInputElement).value)))}
        />
        <button type="button" aria-label={`增加${label}`} onClick={() => onChange(clamp(value + 1))}>＋</button>
      </div>
    </label>
  );
}

export function LayoutPreview({
  state,
  layout,
  onChangeLayout,
  onResetLayout,
  onSelectLine,
  onNudgeBreak,
  onClearBreak,
  onTogglePageBreak,
}: LayoutPreviewProps) {
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const { cellsPerLine, linesPerPage } = state.layout;

  const activeRow = useMemo(
    () => layout.rows.find((row) => row.id === activeRowId) ?? null,
    [layout, activeRowId],
  );
  const activeOverride = activeRow
    ? state.layoutOverrides.find((item) => item.lineId === activeRow.lineId)
    : undefined;
  const splitCount = layout.rows.filter((row) => row.splitHyphenEnd).length;
  const movedCount = state.layoutOverrides.filter((item) => item.pageBreakBefore).length;

  return (
    <div class="layout-preview">
      <div class="layout-toolbar">
        <div>
          <span class="eyebrow">排版预览</span>
          <h2>打印版面分页</h2>
          <p>按当前规则转写后排版；词优先换行，页底放不下的词词内断行，后半截在下页页首标“续”。</p>
        </div>
        <div class="layout-controls">
          <NumberStepper label="每行格数" value={cellsPerLine} min={10} max={60} onChange={(n) => onChangeLayout({ cellsPerLine: n })} />
          <NumberStepper label="每页行数" value={linesPerPage} min={4} max={60} onChange={(n) => onChangeLayout({ linesPerPage: n })} />
          <md-text-button onClick={onResetLayout}>恢复默认 32×25</md-text-button>
        </div>
      </div>

      <div class="layout-meta">
        <span><strong>{layout.pages.length}</strong> 页</span>
        <span><strong>{splitCount}</strong> 处跨页断词</span>
        <span><strong>{movedCount}</strong> 行手工移页</span>
        <span class="layout-hint">点击版面中的行可调整断点或整行移页；改动会随项目保存。</span>
      </div>

      <div class="page-stack scroll-pane">
        {layout.pages.map((page) => (
          <section class="paper" key={page.page} style={{ '--cols': cellsPerLine, '--page-rows': linesPerPage }}>
            <header class="paper-head">
              <span>{state.title}</span>
              <span>第 {page.page + 1} / {layout.pages.length} 页 · {cellsPerLine} 格 × {linesPerPage} 行</span>
            </header>

            <div class="paper-grid">
              {page.rows.map((row) => {
                const cells = [...row.cells];
                const blanks = cellsPerLine - cells.length;
                const isActive = activeRowId === row.id;
                return (
                  <div
                    class={`layout-row ${row.splitHyphenEnd ? 'split-end' : ''} ${row.continuation ? 'continuation' : ''} ${isActive ? 'active' : ''}`}
                    key={row.id}
                    onClick={() => setActiveRowId(isActive ? null : row.id)}
                  >
                    {row.continuation && <span class="continue-tag" title={`续接第 ${page.page} 页 · 原文第 ${row.lineIndex + 1} 行`}>续</span>}
                    {!row.continuation && row.isFirstSegment && <span class="line-ref" title={`原文第 ${row.lineIndex + 1} 行`}>{row.lineIndex + 1}</span>}
                    {!row.continuation && !row.isFirstSegment && <span class="line-ref subtle" title={`同一原文第 ${row.lineIndex + 1} 行`}>{row.lineIndex + 1}</span>}
                    <span class="cell-track">
                      {cells.map((cell, index) => (
                        <span class={`cell ${cell === ' ' ? 'space' : ''} ${cell === '⠤' && row.splitHyphenEnd && index === cells.length - 1 ? 'hyphen' : ''}`} key={index}>{cell === ' ' ? '' : cell}</span>
                      ))}
                      {Array.from({ length: Math.max(0, blanks) }).map((_, index) => (
                        <span class="cell blank" key={`b${index}`} />
                      ))}
                    </span>
                  </div>
                );
              })}
              {Array.from({ length: Math.max(0, linesPerPage - page.rows.length) }).map((_, index) => (
                <div class="layout-row empty-row" key={`e${index}`}>
                  <span class="line-ref" />
                  <span class="cell-track">{Array.from({ length: cellsPerLine }).map((__, i) => <span class="cell blank" key={i} />)}</span>
                </div>
              ))}
            </div>

            <footer class="paper-foot">{state.author} · {state.title}</footer>
          </section>
        ))}
      </div>

      {activeRow && (
        <div class="layout-action-bar">
          <div class="action-info">
            <strong>原文第 {activeRow.lineIndex + 1} 行</strong>
            {activeRow.splitHyphenEnd
              ? <span>词内跨页断点：第 {activeRow.endOffset} 格后{activeOverride?.breakCell != null ? '（手工）' : '（自动）'}</span>
              : <span>此行在第 {activeRow.page + 1} 页第 {activeRow.rowInPage + 1} 行</span>}
          </div>
          <div class="action-buttons">
            {activeRow.splitHyphenEnd && (
              <>
                <md-outlined-button onClick={() => onNudgeBreak(activeRow.lineId, -1)}>断点前移</md-outlined-button>
                <md-outlined-button onClick={() => onNudgeBreak(activeRow.lineId, 1)}>断点后移</md-outlined-button>
                {activeOverride?.breakCell != null && <md-text-button onClick={() => onClearBreak(activeRow.lineId)}>恢复自动断点</md-text-button>}
              </>
            )}
            {activeRow.isFirstSegment && (
              <md-filled-tonal-button onClick={() => onTogglePageBreak(activeRow.lineId)}>
                {activeOverride?.pageBreakBefore ? '取消整行移页' : '整行移到下页'}
              </md-filled-tonal-button>
            )}
            <md-text-button onClick={() => { onSelectLine(activeRow.lineId); setActiveRowId(null); }}>去校对此行</md-text-button>
            <md-icon-button aria-label="关闭" onClick={() => setActiveRowId(null)}>×</md-icon-button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 与屏幕预览一致的打印 HTML：每页一张纸，页首标续接，页底词内断行带连字符。 */
export function buildPrintHtml(state: ProjectState, layout: PaginatedLayout, ruleSetName: string): string {
  const esc = (value: string) => value.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char] ?? char);
  const { cellsPerLine, linesPerPage } = state.layout;

  const pagesHtml = layout.pages.map((page) => {
    const rows = [
      ...page.rows.map((row) => {
        const cells = [...row.cells];
        while (cells.length < cellsPerLine) cells.push(' ');
        const tag = row.continuation ? '<span class="cont-tag">续</span>' : `<span class="line-no">${row.lineIndex + 1}</span>`;
        return `<div class="print-row ${row.splitHyphenEnd ? 'split' : ''} ${row.continuation ? 'continued' : ''}">${tag}<span class="print-cells">${cells.map((cell) => `<i class="${cell === ' ' ? 'sp' : ''}">${cell === ' ' ? '' : esc(cell)}</i>`).join('')}</span></div>`;
      }),
      ...Array.from({ length: Math.max(0, linesPerPage - page.rows.length) }).map(
        () => `<div class="print-row empty"><span class="line-no"></span><span class="print-cells">${'<i class="sp"></i>'.repeat(cellsPerLine)}</span></div>`,
      ),
    ].join('');
    return `<section class="sheet"><header><b>${esc(state.title)}</b><span>第 ${page.page + 1} / ${layout.pages.length} 页</span></header><div class="sheet-grid">${rows}</div><footer>${esc(state.author)} · ${esc(ruleSetName)} · ${new Date().toLocaleDateString('zh-CN')}</footer></section>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(state.title)} · 打印版</title>
<style>
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0; color: #111; font-family: "PingFang SC", sans-serif; }
.sheet { width: 186mm; min-height: 273mm; margin: 0 auto 8mm; display: flex; flex-direction: column; page-break-after: always; }
.sheet:last-child { page-break-after: auto; }
.sheet header { display: flex; justify-content: space-between; font-size: 11px; color: #555; border-bottom: 1px solid #999; padding-bottom: 4px; margin-bottom: 6px; }
.sheet-grid { flex: 1; display: flex; flex-direction: column; justify-content: flex-start; }
.print-row { display: grid; grid-template-columns: 8mm 1fr; align-items: center; min-height: 9mm; }
.line-no, .cont-tag { display: inline-grid; place-items: center; width: 7mm; height: 7mm; font: 10px/1 sans-serif; color: #777; }
.cont-tag { border-radius: 50%; background: #ffe9c7; color: #8a5200; font-weight: 700; }
.print-row.split .print-cells i:last-child { color: #b3541a; font-weight: 700; }
.print-cells { display: grid; grid-template-columns: repeat(${cellsPerLine}, 1fr); font: 20px/1 "Apple Braille", "Segoe UI Symbol", sans-serif; text-align: center; }
.print-cells i { font-style: normal; display: inline-block; border-bottom: 1px dotted transparent; }
.print-cells i.sp { color: transparent; }
.print-row.empty .print-cells i { border-bottom: 1px dotted #ddd; }
.sheet footer { margin-top: 6mm; font-size: 10px; color: #888; text-align: center; border-top: 1px solid #ccc; padding-top: 3mm; }
@media print { .sheet { margin: 0; } }
</style></head><body>${pagesHtml}<script>window.onload=()=>setTimeout(()=>window.print(),200)</script></body></html>`;
}

/** 供“导出文本”使用：在分页结果中加入页分隔与续接提示。 */
export function buildPaginatedText(state: ProjectState, layout: PaginatedLayout): string {
  return layout.pages.map((page) => {
    const header = `—— 第 ${page.page + 1}/${layout.pages.length} 页 · ${state.layout.cellsPerLine} 格 × ${state.layout.linesPerPage} 行 ——`;
    const lines = page.rows.map((row) => {
      const prefix = row.continuation ? '续 ' : `${String(row.lineIndex + 1).padStart(3, ' ')} `;
      return `${prefix}${row.cells.padEnd(state.layout.cellsPerLine, ' ')}`;
    });
    return [header, ...lines].join('\n');
  }).join('\n\n');
}

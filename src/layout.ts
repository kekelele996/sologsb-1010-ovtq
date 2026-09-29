import type {
  LayoutOverride,
  LayoutRow,
  LayoutSettings,
  PaginatedLayout,
  ProjectState,
  TextbookLine,
} from './types';

/** 跨页词内硬断使用的盲文连字符（与规则集中的 '-' 输出一致）。 */
export const SPLIT_HYPHEN = '⠤';

/**
 * 取一行转写后的实际盲文格数组：
 * 只保留盲文单元（U+2800–U+28FF）与分词空格，剔除校对专用标记（↳、⟦…⟧ 等空 text 标记）。
 * 全程用数组索引，避免盲文字符（UTF-16 代理对）被字符串切片截断。
 */
export function lineCells(line: TextbookLine): string[] {
  const cells: string[] = [];
  for (const token of line.tokens) {
    if (token.text === '') continue;
    for (const ch of token.braille) {
      const code = ch.codePointAt(0) ?? 0;
      const isBrailleCell = code >= 0x2800 && code <= 0x28ff;
      if (/\s/u.test(ch) || isBrailleCell) cells.push(ch);
    }
  }
  return cells;
}

/** 供导出/校对使用的格串形式。 */
export function lineCellString(line: TextbookLine): string {
  return lineCells(line).join('');
}

interface FlowState {
  page: number;
  row: number;
  col: number;
}

/**
 * 核心分页算法。
 * - 普通换行优先在分词空格处断行，行内硬切不加连字符；
 * - 词跨越页边界放不下时，上半段填满当页并以盲文连字符收尾，
 *   后半段从下页页首续接（continuation）；
 * - pageBreakBefore 强制整行移到下一页；
 * - breakCell 在词内强制跨页断点：前缀 + 连字符不超出当页即生效，剩余格留空。
 */
export function paginate(lines: TextbookLine[], settings: LayoutSettings, overrides: LayoutOverride[]): PaginatedLayout {
  const width = Math.max(1, Math.round(settings.cellsPerLine));
  const pageHeight = Math.max(1, Math.round(settings.linesPerPage));
  const overrideMap = new Map(overrides.map((item) => [item.lineId, item]));

  const pages: PaginatedLayout['pages'] = [];
  const rows: LayoutRow[] = [];
  const dormantBreaks: string[] = [];

  const flow: FlowState = { page: 0, row: 0, col: 0 };
  let buffer: string[] = [];
  let rowStartOffset = 0;
  let rowHasHyphen = false;
  /** 下一行是否为跨页续接（仅页首第一行）。 */
  let pendingContinuation = false;
  /** 当前行在其课文格序列中的偏移。 */
  let lineOffset = 0;

  const ensurePage = () => {
    if (!pages[flow.page]) pages.push({ page: pages.length, rows: [] });
  };
  const newPage = () => {
    flow.page += 1;
    flow.row = 0;
    flow.col = 0;
  };
  pages.push({ page: 0, rows: [] });

  const startRow = (offset: number) => {
    buffer = [];
    rowStartOffset = offset;
    rowHasHyphen = false;
  };

  const flushRow = (line: TextbookLine, lineIndex: number, segmentIndex: number, first: boolean, last: boolean, advancePage = true): number => {
    if (buffer.length === 0 && !rowHasHyphen) return segmentIndex;
    ensurePage();
    const continuation = pendingContinuation;
    pendingContinuation = false;
    const layoutRow: LayoutRow = {
      id: `layout-${line.id}-${segmentIndex}`,
      lineId: line.id,
      lineIndex,
      segmentIndex,
      page: flow.page,
      rowInPage: flow.row,
      cells: buffer.join(''),
      used: buffer.length,
      startOffset: rowStartOffset,
      endOffset: lineOffset,
      isFirstSegment: first,
      isLastSegment: last,
      splitHyphenEnd: rowHasHyphen,
      continuation,
    };
    pages[flow.page].rows.push(layoutRow);
    rows.push(layoutRow);
    flow.row += 1;
    flow.col = 0;
    startRow(lineOffset);
    if (advancePage && flow.row >= pageHeight) {
      newPage();
    }
    return segmentIndex + 1;
  };

  /** 当前光标到本页末尾还能容纳的格数。 */
  const cellsToPageEnd = () => (pageHeight - flow.row) * width - flow.col;

  /** 把一个不含空格的词（格数组）从当前光标放下，沿格边界硬切；页底硬断预留连字符格并续页。 */
  const placeWordHard = (
    word: string[],
    line: TextbookLine,
    lineIndex: number,
    segmentIndexRef: { value: number },
  ) => {
    let pos = 0;
    while (pos < word.length) {
      const cap = width - flow.col;
      const remain = word.length - pos;

      if (remain <= cap) {
        buffer.push(...word.slice(pos));
        flow.col += remain;
        lineOffset += remain;
        pos += remain;
        continue;
      }

      if (flow.row >= pageHeight - 1) {
        // 页底词内硬断：末格留给连字符，后半截续到下页页首
        const take = Math.max(0, cap - 1);
        if (take > 0) {
          buffer.push(...word.slice(pos, pos + take));
          flow.col += take;
          lineOffset += take;
          pos += take;
        }
        buffer.push(SPLIT_HYPHEN);
        rowHasHyphen = true;
        segmentIndexRef.value = flushRow(line, lineIndex, segmentIndexRef.value, segmentIndexRef.value === 0, false);
        pendingContinuation = true;
      } else {
        // 页内硬切到下一满行，不加连字符
        buffer.push(...word.slice(pos, pos + cap));
        flow.col += cap;
        lineOffset += cap;
        pos += cap;
        segmentIndexRef.value = flushRow(line, lineIndex, segmentIndexRef.value, segmentIndexRef.value === 0, false);
      }
    }
  };

  lines.forEach((line, lineIndex) => {
    const cells = lineCells(line);
    if (cells.length === 0) return;

    const override = overrideMap.get(line.id);
    const atBlankPageTop = flow.page === 0 && flow.row === 0 && pages[0].rows.length === 0;
    if (override?.pageBreakBefore && !atBlankPageTop) {
      newPage();
    }

    lineOffset = 0;
    startRow(0);
    pendingContinuation = false;
    const segmentRef = { value: 0 };
    let splitConsumed = false;
    let i = 0;

    const nextPart = (): { word: boolean; value: string[] } | null => {
      if (i >= cells.length) return null;
      const isSpace = cells[i] === ' ';
      const start = i;
      while (i < cells.length && ((cells[i] === ' ') === isSpace)) i += 1;
      return { word: !isSpace, value: cells.slice(start, i) };
    };

    for (let part = nextPart(); part !== null; part = nextPart()) {
      if (!part.word) {
        lineOffset += part.value.length;
        // 行首空格丢弃；行末放不下则换行，空格不带到下一行行首
        if (buffer.length === 0) continue;
        if (flow.col + part.value.length <= width) {
          buffer.push(...part.value);
          flow.col += part.value.length;
        } else {
          segmentRef.value = flushRow(line, lineIndex, segmentRef.value, segmentRef.value === 0, false);
        }
        continue;
      }

      const word = part.value;

      // 手工词内断点：用绝对格坐标把前缀直接切成若干满行 + 末行（末行末尾补连字符），
      // 不经增量状态机，几何完全由数学决定，避免与自动分页互相干扰。
      if (
        !splitConsumed &&
        override?.breakCell != null &&
        override.breakCell > lineOffset &&
        override.breakCell < lineOffset + word.length
      ) {
        const headLen = override.breakCell - lineOffset;
        const startPos = flow.row * width + flow.col;
        const hyphenPos = startPos + headLen;
        const hyphenRow = Math.floor(hyphenPos / width);
        const hyphenCol = hyphenPos % width;
        // 合法：连字符在当页内、不在行首（行首格留给前缀末字）
        if (headLen >= 1 && hyphenRow < pageHeight && hyphenCol !== 0 && hyphenPos < pageHeight * width) {
          const headCells = word.slice(0, headLen);
          let consumed = 0;
          while (consumed < headCells.length) {
            const cap = width - flow.col;
            const take = Math.min(cap, headCells.length - consumed);
            const chunk = headCells.slice(consumed, consumed + take);
            const isLast = consumed + take >= headCells.length;
            consumed += take;
            lineOffset += take;
            if (isLast) {
              buffer.push(...chunk, SPLIT_HYPHEN);
              rowHasHyphen = true;
              segmentRef.value = flushRow(line, lineIndex, segmentRef.value, segmentRef.value === 0, false, false);
              pendingContinuation = true;
            } else {
              buffer.push(...chunk);
              flow.col += take;
              segmentRef.value = flushRow(line, lineIndex, segmentRef.value, segmentRef.value === 0, false, false);
            }
          }
          newPage();
          ensurePage();
          startRow(lineOffset);
          placeWordHard(word.slice(headLen), line, lineIndex, segmentRef);
          splitConsumed = true;
          continue;
        }
      }

      // 整词能放进当前页剩余格：页内贪婪排版（可能在行边界处页内硬切，不加连字符）
      if (word.length <= cellsToPageEnd()) {
        if (flow.col + word.length <= width) {
          buffer.push(...word);
          flow.col += word.length;
          lineOffset += word.length;
          continue;
        }
        if (buffer.length !== 0) {
          segmentRef.value = flushRow(line, lineIndex, segmentRef.value, segmentRef.value === 0, false);
        }
        placeWordHard(word, line, lineIndex, segmentRef);
        continue;
      }

      // 当前页放不下整词：先换行，再由 placeWordHard 在页底词内硬断续页
      if (buffer.length !== 0) {
        segmentRef.value = flushRow(line, lineIndex, segmentRef.value, segmentRef.value === 0, false);
      }
      placeWordHard(word, line, lineIndex, segmentRef);
    }

    if (override?.breakCell != null && !rows.some((row) => row.lineId === line.id && row.splitHyphenEnd)) {
      dormantBreaks.push(line.id);
    }

    flushRow(line, lineIndex, segmentRef.value, segmentRef.value === 0, true);
  });

  if (pages.length > 0 && pages[0].rows.length === 0) pages.shift();

  return { pages, rows, dormantBreaks };
}

/** 当前若对某行设置词内跨页断点，断点可移动的格偏移范围（相对该行格序列）。 */
export function breakWindow(
  lines: TextbookLine[],
  settings: LayoutSettings,
  overrides: LayoutOverride[],
  lineId: string,
): { current: number; min: number; max: number } | null {
  const line = lines.find((item) => item.id === lineId);
  if (!line) return null;
  const probe = paginate(lines, settings, overrides.filter((item) => item.lineId !== lineId));
  const splitRow = probe.rows.find((row) => row.lineId === lineId && row.splitHyphenEnd);
  if (!splitRow) return null;

  const cells = lineCells(line);
  let min = splitRow.endOffset;
  let max = splitRow.endOffset;
  while (min > 0 && cells[min - 1] !== ' ') min -= 1;
  while (max < cells.length && cells[max] !== ' ') max += 1;
  min = Math.max(min + 1, splitRow.startOffset + 1);
  max = Math.max(min, max - 1);

  const saved = overrides.find((item) => item.lineId === lineId)?.breakCell;
  return { current: saved ?? splitRow.endOffset, min, max };
}

function layoutSignature(line: TextbookLine, layout: PaginatedLayout): string {
  const first = layout.rows.find((row) => row.lineId === line.id);
  const cells = lineCellString(line);
  if (!first) return `absent::${cells}`;
  // 同时包含版面位置与转写格串：内容改变但位置未变也能检出
  return `${first.page}:${first.startOffset}:${cells}`;
}

/**
 * 内容（原文、规则、行序）变化后重算分页：
 * - 已批准行若格串或版面位置变化，回到待核对并补一条分页问题；
 * - 清理在新内容下已失效的手工词内断点。
 */
export function reconcileLayout(state: ProjectState): ProjectState {
  const layout = paginate(state.lines, state.layout, state.layoutOverrides);
  const dormant = new Set(layout.dormantBreaks);
  const overrides = state.layoutOverrides.filter((item) => {
    if (item.breakCell == null) return true;
    const line = state.lines.find((entry) => entry.id === item.lineId);
    if (!line) return false;
    if (dormant.has(item.lineId)) return false;
    return item.breakCell >= 0 && item.breakCell <= lineCells(line).length;
  });

  const signatures: Record<string, string> = {};
  const changedLineIds = new Set<string>();
  const addedIssues: ProjectState['issues'] = [];

  for (const line of state.lines) {
    const signature = layoutSignature(line, layout);
    signatures[line.id] = signature;
    const previous = state.layoutSignatures[line.id];
    if (previous && previous !== signature) changedLineIds.add(line.id);
  }

  for (const id of changedLineIds) {
    const page = layout.rows.find((row) => row.lineId === id)?.page;
    addedIssues.push({
      id: `issue-layout-${id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      lineId: id,
      severity: 'warning',
      code: 'pagination-shift',
      message:
        page != null
          ? `原文、规则或行序变化后分页已重算，本行现在第 ${page + 1} 页，请重新核对。`
          : '原文或规则变化后转写内容已改变，请重新核对。',
      resolved: false,
    });
  }

  const lines = changedLineIds.size > 0
    ? state.lines.map((line) => (changedLineIds.has(line.id) && line.status === 'approved' ? { ...line, status: 'questionable' as const } : line))
    : state.lines;

  // 重算时清除本轮受影响行上未处理的旧分页提醒，避免重复堆叠；已手动处理的保留
  const issues = [
    ...state.issues.filter((item) => !(item.code === 'pagination-shift' && changedLineIds.has(item.lineId) && !item.resolved)),
    ...addedIssues,
  ];

  return {
    ...state,
    lines,
    layoutOverrides: overrides,
    layoutSignatures: signatures,
    issues,
  };
}

/** 版面参数或手工分页调整后，静默刷新位置签名（不回退已批准行）。 */
export function refreshLayoutSignatures(state: ProjectState): ProjectState {
  const layout = paginate(state.lines, state.layout, state.layoutOverrides);
  const signatures: Record<string, string> = {};
  for (const line of state.lines) signatures[line.id] = layoutSignature(line, layout);
  return { ...state, layoutSignatures: signatures, updatedAt: new Date().toISOString() };
}

export const DEFAULT_LAYOUT: LayoutSettings = { cellsPerLine: 32, linesPerPage: 25 };

export function normalizeProject(state: ProjectState): ProjectState {
  return {
    ...state,
    layout: {
      cellsPerLine: Math.round(state.layout?.cellsPerLine ?? DEFAULT_LAYOUT.cellsPerLine),
      linesPerPage: Math.round(state.layout?.linesPerPage ?? DEFAULT_LAYOUT.linesPerPage),
    },
    layoutOverrides: Array.isArray(state.layoutOverrides) ? state.layoutOverrides : [],
    layoutSignatures: state.layoutSignatures ?? {},
  };
}

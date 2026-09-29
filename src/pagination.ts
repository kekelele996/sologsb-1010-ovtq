import type { LinePaginationOverride, PaginationSettings, ProjectState, TextbookLine } from './types';

export const DEFAULT_PAGINATION: PaginationSettings = { cellsPerLine: 32, linesPerPage: 25 };
export const MIN_CELLS = 10;
export const MAX_CELLS = 60;
export const MIN_ROWS = 8;
export const MAX_ROWS = 40;

export interface LayoutFragment {
  lineId: string;
  lineIndex: number;
  /** 该行盲文内的分段序号（0 起） */
  fragmentIndex: number;
  /** 本行格流中的绝对起止位置 */
  start: number;
  end: number;
  cells: string[];
  /** 前段末尾与本段开头均为词内字符（词内断行） */
  splitWithinWord: boolean;
  /** 本段在词内被切开、下一段续接同一词（段尾需加连字符） */
  endsWithinWord: boolean;
  /** 教师手动断点 */
  manualBreak: boolean;
  /** 教师强制整行移页 */
  forcePageBefore: boolean;
}

export interface LayoutRow extends LayoutFragment {
  pageIndex: number;
  pageTop: boolean;
  /** 页首且为词内续接：上页同词未完 */
  continuesWord: boolean;
  /** 页首且为强制整行移页 */
  movedToPage: boolean;
  /** 页首且承接原文中已有的跨行连字符行 */
  continuesSourceHyphen: boolean;
  overflow: boolean;
}

export interface LayoutLineMeta {
  lineId: string;
  totalCells: number;
  autoBreaks: number[];
  effectiveBreaks: number[];
  /** 教师是否已接管该行断点（否则清除调整后回到自动分页） */
  manualMode: boolean;
  forcePageBefore: boolean;
  pages: number[];
}

export interface PaginationLayout {
  settings: PaginationSettings;
  pages: LayoutPage[];
  rows: LayoutRow[];
  lineMeta: Map<string, LayoutLineMeta>;
  totalCells: number;
}

export interface LayoutPage {
  index: number;
  rows: LayoutRow[];
  /** 有行在当前版心下无法放下（格数为 0 等异常） */
  overflow: boolean;
}

const isWordChar = (cell: string | undefined): boolean => Boolean(cell && !/\s/u.test(cell));

/** 一行真正占格的盲文格流；过滤转写器插入的纯标记 token（↳、⟦…⟧ 说明等）。 */
export function lineCellStream(line: TextbookLine): string[] {
  const cells: string[] = [];
  for (const token of line.tokens) {
    if (!token.text) continue;
    for (const cell of token.braille) cells.push(cell);
  }
  return cells;
}

function normalizeSettings(settings?: Partial<PaginationSettings>): PaginationSettings {
  const cells = Number(settings?.cellsPerLine ?? DEFAULT_PAGINATION.cellsPerLine);
  const rows = Number(settings?.linesPerPage ?? DEFAULT_PAGINATION.linesPerPage);
  return {
    cellsPerLine: Math.min(MAX_CELLS, Math.max(MIN_CELLS, Number.isFinite(cells) ? Math.round(cells) : DEFAULT_PAGINATION.cellsPerLine)),
    linesPerPage: Math.min(MAX_ROWS, Math.max(MIN_ROWS, Number.isFinite(rows) ? Math.round(rows) : DEFAULT_PAGINATION.linesPerPage)),
  };
}

function normalizeOverrides(raw: ProjectState['paginationOverrides'] | undefined): ProjectState['paginationOverrides'] {
  const result: ProjectState['paginationOverrides'] = {};
  for (const [lineId, override] of Object.entries(raw ?? {})) {
    const breaks = (override.breaks ?? []).filter((position): position is number => typeof position === 'number' && Number.isFinite(position));
    if (breaks.length > 0 || override.forcePageBefore) {
      result[lineId] = { breaks: breaks.length ? breaks : undefined, forcePageBefore: override.forcePageBefore || undefined };
    }
  }
  return result;
}

/**
 * 自动贪心分页：在每行内按格数切分。尽量在空格处换行（空格保留在前段末尾，
 * 不丢格），放不下的连续文本直接词内断行；返回每段在格流中的绝对结束位置（不含）。
 */
export function autoFragment(cells: string[], width: number): number[] {
  const breaks: number[] = [];
  let start = 0;
  while (cells.length - start > width) {
    let position = start + width;
    if (/\s/u.test(cells[position - 1])) {
      // 边界恰在空格：空格归前段，从其后断行。
      breaks.push(position);
      start = position;
      continue;
    }
    // 在窗口内找最后一个空格断点。
    let spaceAt = -1;
    for (let index = start + 1; index < start + width; index += 1) {
      if (/\s/u.test(cells[index - 1])) spaceAt = index - 1;
    }
    if (spaceAt >= start) position = spaceAt + 1;
    breaks.push(position);
    start = position;
  }
  return breaks;
}

/**
 * 解析一行的断点位置。
 * 教师未调整时用自动贪心断点；一旦给出手动断点列表，则以其为准（按格流绝对位置），
 * 原文/规则变化导致位置越界会被丢弃，两段间距超过版心时自动补断行。
 */
function resolveBreakPositions(cells: string[], width: number, override: LinePaginationOverride | undefined): { positions: number[]; manual: Set<number> } {
  const automatic = autoFragment(cells, width);
  const raw = override?.breaks?.filter((position): position is number => typeof position === 'number' && Number.isFinite(position)) ?? [];
  if (raw.length === 0) return { positions: automatic, manual: new Set() };

  const manual = new Set<number>();
  const sorted = [...new Set(raw.map((value) => Math.round(value)))]
    .filter((position) => position > 0 && position < cells.length)
    .sort((a, b) => a - b);

  const result: number[] = [];
  let segmentStart = 0;
  for (const position of sorted) {
    if (position <= segmentStart) continue;
    while (position - segmentStart > width) {
      const filler = autoFragment(cells.slice(segmentStart, position), width);
      const next = segmentStart + (filler[0] ?? width);
      result.push(next);
      segmentStart = next;
    }
    result.push(position);
    manual.add(position);
    segmentStart = position;
  }
  while (cells.length - segmentStart > width) {
    const filler = autoFragment(cells.slice(segmentStart), width);
    const next = segmentStart + (filler[0] ?? width);
    result.push(next);
    segmentStart = next;
  }
  return { positions: result, manual };
}

export function computeLayout(state: ProjectState, settingsInput?: PaginationSettings): PaginationLayout {
  const settings = normalizeSettings(settingsInput ?? state.pagination);
  const overrides = normalizeOverrides(state.paginationOverrides);
  const { cellsPerLine: width, linesPerPage: pageRows } = settings;

  const fragments: LayoutFragment[] = [];
  const lineMeta = new Map<string, LayoutLineMeta>();
  let totalCells = 0;

  state.lines.forEach((line, lineIndex) => {
    const cells = lineCellStream(line);
    totalCells += cells.filter((cell) => !/\s/u.test(cell)).length;
    const override = overrides[line.id];
    const automatic = autoFragment(cells, width);
    const { positions, manual } = resolveBreakPositions(cells, width, override);
    const hasManualBreaks = positions.some((position) => manual.has(position));

    const boundaries = [0, ...positions];
    const meta: LayoutLineMeta = {
      lineId: line.id,
      totalCells: cells.length,
      autoBreaks: automatic,
      effectiveBreaks: positions,
      manualMode: hasManualBreaks,
      forcePageBefore: Boolean(override?.forcePageBefore),
      pages: [],
    };
    lineMeta.set(line.id, meta);

    boundaries.forEach((start, fragmentIndex) => {
      const end = boundaries[fragmentIndex + 1] ?? cells.length;
      fragments.push({
        lineId: line.id,
        lineIndex,
        fragmentIndex,
        start,
        end,
        cells: cells.slice(start, end),
        splitWithinWord: fragmentIndex > 0 && isWordChar(cells[start - 1]) && isWordChar(cells[start]),
        endsWithinWord: end < cells.length && isWordChar(cells[end - 1]) && isWordChar(cells[end]),
        manualBreak: manual.has(start),
        forcePageBefore: fragmentIndex === 0 && Boolean(override?.forcePageBefore),
      });
    });
  });

  const pages: LayoutPage[] = [];
  const rows: LayoutRow[] = [];
  let page: LayoutPage = { index: 0, rows: [], overflow: false };
  pages.push(page);

  const pushPage = () => {
    page = { index: pages.length, rows: [], overflow: false };
    pages.push(page);
  };

  for (const fragment of fragments) {
    const needsFreshPage = (fragment.fragmentIndex === 0 && fragment.forcePageBefore) || page.rows.length >= pageRows;
    if (needsFreshPage && page.rows.length > 0) pushPage();
    // 极端情况下单段仍超长（格流本身异常），保证不跨页溢出。
    const overflow = fragment.cells.filter((cell) => !/\s/u.test(cell)).length > width;
    if (overflow) page.overflow = true;

    const pageTop = page.rows.length === 0;
    const line = state.lines[fragment.lineIndex];
    const row: LayoutRow = {
      ...fragment,
      pageIndex: page.index,
      pageTop,
      continuesWord: pageTop && fragment.fragmentIndex > 0 && fragment.splitWithinWord,
      movedToPage: pageTop && fragment.fragmentIndex === 0 && fragment.forcePageBefore,
      continuesSourceHyphen: pageTop && fragment.fragmentIndex === 0 && Boolean(line?.continuesPrevious),
      overflow,
    };
    page.rows.push(row);
    rows.push(row);
    lineMeta.get(fragment.lineId)?.pages.push(page.index);
  }

  // 空文档也保留一页，便于预览。
  if (pages[0].rows.length === 0 && pages.length === 1) pages[0].overflow = false;

  return { settings, pages, rows, lineMeta, totalCells };
}

/** 补齐/规整分页设置与覆盖数据（读取草稿、恢复版本、初始化时使用）。 */
export function paginateProject(state: ProjectState): ProjectState {
  return {
    ...state,
    pagination: normalizeSettings(state.pagination),
    paginationOverrides: normalizeOverrides(state.paginationOverrides),
  };
}

/** 行内容指纹：盲文格流，规则或原文一变即变。 */
function lineFingerprint(line: TextbookLine): string {
  return lineCellStream(line).join('');
}

/**
 * 原文、规则或行序变化后重算批准状态。已批准行满足以下任一条件即回到待核对：
 * 1. 自身盲文格流变化（原文/规则改动）；
 * 2. 行序位置变化（插入、删除、移动、导入导致的重排）；
 * 3. 分页坐标变化（前序内容增减导致整体顺移、版心内容变化）。
 * 纯手动分页调整（断点、移页、版心设置）不经过这里，不会冲掉批准。
 */
export function downgradeAffectedLines(next: ProjectState, previous: ProjectState): ProjectState {
  const beforeLayout = computeLayout(previous);
  const afterLayout = computeLayout(next);

  const keySet = (layout: PaginationLayout, lineId: string): Set<string> => {
    const set = new Set<string>();
    for (const row of layout.rows) {
      if (row.lineId === lineId) set.add(`${row.pageIndex}:${row.start}-${row.end}`);
    }
    return set;
  };

  const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every((value) => b.has(value));
  const previousIndex = new Map(previous.lines.map((line, index) => [line.id, index]));

  const changed = new Set<string>();
  next.lines.forEach((line, index) => {
    const oldLine = previous.lines.find((item) => item.id === line.id);
    const positionChanged = previousIndex.get(line.id) !== index;
    const contentChanged = !oldLine || lineFingerprint(oldLine) !== lineFingerprint(line);
    const layoutChanged = !sameSet(keySet(beforeLayout, line.id), keySet(afterLayout, line.id));
    if (positionChanged || contentChanged || layoutChanged) changed.add(line.id);
  });

  const lines = next.lines.map((line) =>
    line.status === 'approved' && changed.has(line.id) ? { ...line, status: 'questionable' as const } : line,
  );

  return { ...next, lines };
}

import { analyzeProject } from '../src/braille';
import { autoFragment, computeLayout, downgradeAffectedLines, lineCellStream, paginateProject } from '../src/pagination';
import { createInitialProject } from '../src/sample';
import type { ProjectState, TextbookLine } from '../src/types';

let failures = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
};

// 1. autoFragment：优先空格断行（空格保留在前段，不丢格）；连续文本词内断行；逐格推进不死循环
{
  const cells = ['a', 'b', ' ', 'c', 'd', 'e', 'f'];
  const breaks = autoFragment(cells, 3);
  // 窗口 [a,b, ] 末尾即空格：从 3 断；下段 cdef 宽 4，窗口 [c,d,e] 无空格，在 6 处词内断
  check('空格处优先断行', JSON.stringify(breaks) === JSON.stringify([3, 6]), JSON.stringify(breaks));
  check('分段覆盖全文不重复', breaks.every((b) => b > 0 && b < cells.length));

  const longWord = 'abcdefghij'.split('');
  const breaks2 = autoFragment(longWord, 3);
  check('词内断行位置', JSON.stringify(breaks2) === JSON.stringify([3, 6, 9]), JSON.stringify(breaks2));

  // 极端宽度 1
  const breaks3 = autoFragment(longWord, 1);
  check('宽度 1 不死循环', breaks3.length === 9 && breaks3[0] === 1 && breaks3[8] === 9, JSON.stringify(breaks3));

  // 空格恰好位于边界：空格归前段
  const cells2 = 'ab cdef'.split('');
  const breaks4 = autoFragment(cells2, 3);
  const segs: string[] = [];
  let s = 0;
  for (const b of breaks4) { segs.push(cells2.slice(s, b).join('')); s = b; }
  segs.push(cells2.slice(s).join(''));
  check('断行后不丢字符', segs.join('') === 'ab cdef', JSON.stringify(segs));
}

// 2. computeLayout：分页、页首续接标记、行尾词内断行标记
{
  const project = createInitialProject();
  // 用一个超长连续词强制词内断行跨页（最小版心 10 格 / 8 行）
  const longLine: TextbookLine = { id: 'long', source: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz', tokens: [], status: 'approved', note: '', continuesPrevious: false, continuesNext: false };
  const narrow = paginateProject(analyzeProject({ ...project, lines: [longLine], selectedLineId: 'long', pagination: { cellsPerLine: 10, linesPerPage: 8 }, paginationOverrides: {} }));
  const layout = computeLayout(narrow);
  check('页数按每页行数产生', layout.pages.length >= 2, `pages=${layout.pages.length}`);
  check('每页不超过行数限制', layout.pages.every((p) => p.rows.length <= 8));
  check('页号连续', layout.pages.every((p) => p.rows.every((r) => r.pageIndex === p.index)));

  const wordContinue = layout.rows.find((r) => r.continuesWord);
  check('存在词内续接页首标记', Boolean(wordContinue));
  const tail = layout.rows.find((r) => r.endsWithinWord);
  check('存在词内断行尾连字符标记', Boolean(tail));

  let rendered = '';
  for (const row of layout.rows) rendered += row.cells.join('');
  const source = narrow.lines.map((l) => lineCellStream(l).join('')).join('');
  check('格流完整保留（无丢格）', rendered === source, `len ${rendered.length} vs ${source.length}`);
}

// 3. 手动断点：权威列表 + 移动后段数变化 + 清除回自动
{
  const project = paginateProject(analyzeProject({
    ...createInitialProject(),
    pagination: { cellsPerLine: 100, linesPerPage: 25 },
    paginationOverrides: {},
  }));
  // 一行很长的连续词
  const line: TextbookLine = { id: 'L1', source: 'abcdefghijklmnopqrstuvwxyz', tokens: [], status: 'approved', note: '', continuesPrevious: false, continuesNext: false };
  let state = paginateProject(analyzeProject({ ...project, lines: [line], selectedLineId: 'L1' }));
  const auto = computeLayout(state, { cellsPerLine: 10, linesPerPage: 25 });
  check('自动断点 [10,20]', auto.lineMeta.get('L1')!.autoBreaks.join() === '10,20', JSON.stringify(auto.lineMeta.get('L1')!.autoBreaks));

  // 手动接管：在 6/12/18 断（间距 <= 10，不补点）
  state = paginateProject({ ...state, paginationOverrides: { L1: { breaks: [6, 12, 18] } } });
  const manual = computeLayout(state, { cellsPerLine: 10, linesPerPage: 25 });
  check('手动断点生效', manual.lineMeta.get('L1')!.effectiveBreaks.join() === '6,12,18', manual.lineMeta.get('L1')!.effectiveBreaks.join());
  check('手动模式标记', manual.lineMeta.get('L1')!.manualMode === true);

  // 段间距超过版心时自动补断行：8..24 间距 16 > 10
  state = paginateProject({ ...state, paginationOverrides: { L1: { breaks: [8, 24] } } });
  const manual2 = computeLayout(state, { cellsPerLine: 10, linesPerPage: 25 });
  const rows = manual2.rows;
  const ok = rows.every((r) => r.end - r.start <= 10);
  check('补断后每段不超版心', ok, rows.map((r) => `${r.start}-${r.end}`).join(','));
  check('补点后手动断点仍保留', manual2.lineMeta.get('L1')!.manualMode === true);

  // 越界断点被忽略（原文缩短）
  const short: TextbookLine = { ...line, source: 'ab' };
  const shortState = paginateProject(analyzeProject({ ...state, lines: [short] }));
  const shortLayout = computeLayout(shortState, { cellsPerLine: 10, linesPerPage: 25 });
  check('原文变短后越界断点丢弃', shortLayout.lineMeta.get('L1')!.effectiveBreaks.length === 0);
  check('无有效手动断点时回退自动模式', shortLayout.lineMeta.get('L1')!.manualMode === false);
}

// 4. 强制整行移页
{
  const project = createInitialProject();
  const state = paginateProject({ ...project, pagination: { cellsPerLine: 32, linesPerPage: 25 }, paginationOverrides: { 'line-2': { forcePageBefore: true } } });
  const layout = computeLayout(state);
  const row = layout.rows.find((r) => r.lineId === 'line-2');
  check('强制移页后该行位于新页页首', row?.pageTop === true && row.pageIndex === 1, `pageIndex=${row?.pageIndex} top=${row?.pageTop}`);
  check('移页标记 movedToPage', row?.movedToPage === true);
  check('产生第 2 页', layout.pages.length >= 2);
}

// 5. 失效逻辑：改原文，受影响已批准行回到 questionable；未改动的保留
{
  const mk = (): ProjectState => {
    const lines: TextbookLine[] = [
      { id: 'A', source: 'one two three', tokens: [], status: 'approved', note: '', continuesPrevious: false, continuesNext: false },
      { id: 'B', source: 'four five six', tokens: [], status: 'approved', note: '', continuesPrevious: false, continuesNext: false },
      { id: 'C', source: 'seven eight', tokens: [], status: 'approved', note: '', continuesPrevious: false, continuesNext: false },
    ];
    const base = { ...createInitialProject(), lines, selectedLineId: 'A', issues: [] };
    return paginateProject(analyzeProject(base));
  };
  const before = mk();

  // 只改 B
  const edited: ProjectState = { ...before, lines: before.lines.map((l) => l.id === 'B' ? { ...l, source: 'four FIVE six' } : l) };
  const after = paginateProject(downgradeAffectedLines(analyzeProject(edited), before));
  check('A 保持批准', after.lines[0].status === 'approved', after.lines[0].status);
  check('B 回到待核对', after.lines[1].status === 'questionable', after.lines[1].status);
  check('C 行序未变且内容未变保持批准', after.lines[2].status === 'approved', after.lines[2].status);

  // 行序变化：交换 B/C，B 及之后失效
  const reordered: ProjectState = { ...before, lines: [before.lines[0], before.lines[2], before.lines[1]] };
  const after2 = paginateProject(downgradeAffectedLines(analyzeProject(reordered), before));
  check('行序变化后 A 保持批准', after2.lines[0].status === 'approved');
  check('行序变化后 B 回到待核对', after2.lines.find((l) => l.id === 'B')!.status === 'questionable');
  check('行序变化后 C 回到待核对', after2.lines.find((l) => l.id === 'C')!.status === 'questionable');

  // 规则影响所有行：切换规则集模拟（用收缩缩写——直接改 ruleSets 不便，这里验证同内容不降级）
  const same = paginateProject(downgradeAffectedLines(analyzeProject(before), before));
  check('无改动时全部保持批准', same.lines.every((l) => l.status === 'approved'));
}

// 6. 版心设置变化不会冲掉批准；改格数页数重算
{
  const before = createInitialProject();
  const after = paginateProject({ ...before, pagination: { cellsPerLine: 12, linesPerPage: 10 } });
  const layout = computeLayout(after);
  check('版心变化后页数增加', layout.pages.length > computeLayout(before).pages.length);
  check('版心变化不改变批准状态', after.lines.every((l, i) => l.status === before.lines[i].status));
}

// 7. 设置边界规整
{
  const state = paginateProject({ ...createInitialProject(), pagination: { cellsPerLine: 999, linesPerPage: 1 } });
  check('格数夹取到上限', state.pagination.cellsPerLine === 60);
  check('行数夹取到下限', state.pagination.linesPerPage === 8);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

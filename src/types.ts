export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

export interface LayoutSettings {
  cellsPerLine: number;
  linesPerPage: number;
}

/** 教师对某一行手工分页调整：整行移到下一页，或指定词内跨页断点的格偏移。 */
export interface LayoutOverride {
  lineId: string;
  pageBreakBefore?: boolean;
  breakCell?: number;
}

export interface LayoutRow {
  id: string;
  lineId: string;
  lineIndex: number;
  /** 本行在该课文行内的序号（0 起）。 */
  segmentIndex: number;
  page: number;
  rowInPage: number;
  /** 盲文格串，长度恰为每行格数（末尾用空格补齐显示）。 */
  cells: string;
  /** 此行使用的格数（不含尾部补齐）。 */
  used: number;
  /** 该行在课文行单元串中的起始格偏移。 */
  startOffset: number;
  endOffset: number;
  isFirstSegment: boolean;
  isLastSegment: boolean;
  /** 页边界词内硬断：本段以连字结束。 */
  splitHyphenEnd: boolean;
  /** 页边界词内硬断：本段为后半截，页首需标续接。 */
  continuation: boolean;
}

export interface LayoutPage {
  page: number;
  rows: LayoutRow[];
}

export interface PaginatedLayout {
  pages: LayoutPage[];
  rows: LayoutRow[];
  /** 已保存但当前版面下不生效的词内断点，供重算时清理。 */
  dormantBreaks: string[];
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  action: string;
  snapshot: Omit<ProjectState, 'versions'>;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  layout: LayoutSettings;
  layoutOverrides: LayoutOverride[];
  /** 最近一次分页重算后每行的版面签名，用于判断哪些行版面被改动。 */
  layoutSignatures: Record<string, string>;
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}

import { emitKeypressEvents } from 'readline';
import chalk from 'chalk';

export type LogKind =
  | 'system'
  | 'info'
  | 'user'
  | 'assistant'
  | 'diff'
  | 'plan'
  | 'warning'
  | 'error'
  | 'success'
  | 'command';

interface TerminalUIOptions {
  model: string;
  projectDir: string;
  version: string;
}

interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
}

type DecisionMode = 'apply' | 'launch';

export interface SubMenuItem {
  label: string;
  value: string;
  hint?: string;
}

interface SubMenuState {
  command: string;
  items: SubMenuItem[];
  selectedIndex: number;
}

const MAX_LOG_ENTRIES = 240;

const SLASH_COMMANDS: { name: string; description: string }[] = [
  { name: '/model', description: 'Switch AI model' },
  { name: '/address', description: 'Show full wallet address' },
  { name: '/deposit', description: 'Deposit A0GI into compute' },
  { name: '/withdraw', description: 'Withdraw A0GI from compute' },
  { name: '/export-key', description: 'Export private key' },
  { name: '/plan', description: 'Toggle plan mode' },
  { name: '/build', description: 'Execute current plan' },
  { name: '/help', description: 'Show all commands' },
  { name: '/balance', description: 'Check wallet balance' },
  { name: '/status', description: 'Check 0G Compute connection' },
  { name: '/add', description: 'Add file to context' },
  { name: '/remove', description: 'Remove file from context' },
  { name: '/files', description: 'Show project tree' },
  { name: '/web', description: 'Search the web' },
  { name: '/undo', description: 'Revert last applied changes' },
  { name: '/export', description: 'Save conversation to markdown' },
  { name: '/cost', description: 'Show session token usage' },
  { name: '/clear', description: 'Clear conversation' },
  { name: '/quit', description: 'Exit' },
];

const MAX_SUGGESTIONS = 8;

function borderLine(width: number): string {
  return '─'.repeat(Math.max(10, width));
}

function wrapParagraph(text: string, width: number): string[] {
  if (width <= 1) {
    return [text];
  }

  const result: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      result.push('');
      continue;
    }

    let remaining = paragraph;

    while (remaining.length > width) {
      let sliceIndex = remaining.lastIndexOf(' ', width);
      if (sliceIndex <= 0) {
        sliceIndex = width;
      }

      result.push(remaining.slice(0, sliceIndex).trimEnd());
      remaining = remaining.slice(sliceIndex).trimStart();
    }

    result.push(remaining);
  }

  return result;
}

function trimToWidth(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return text.slice(0, maxLength);
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function trimFromStart(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  if (maxLength <= 3) {
    return text.slice(text.length - maxLength);
  }

  return `...${text.slice(text.length - (maxLength - 3))}`;
}

function padRight(text: string, width: number): string {
  if (text.length >= width) {
    return text;
  }

  return `${text}${' '.repeat(width - text.length)}`;
}

function normalizeMarkdownForTerminal(kind: LogKind, text: string): string {
  if (kind === 'user' || kind === 'command' || kind === 'diff') {
    return text;
  }

  return text
    .split('\n')
    .map((line) => normalizeMarkdownLine(line))
    .join('\n');
}

function normalizeMarkdownLine(line: string): string {
  let nextLine = line;

  if (/^\s*#{1,6}\s+/.test(nextLine)) {
    nextLine = nextLine.replace(/^(\s*)#{1,6}\s+/, '$1◦ ');
  } else if (/^\s*[-*]\s+/.test(nextLine)) {
    nextLine = nextLine.replace(/^(\s*)[-*]\s+/, '$1• ');
  }

  nextLine = nextLine.replace(/`([^`]+)`/g, '$1');
  nextLine = nextLine.replace(/\*\*([^*]+)\*\*/g, '$1');
  nextLine = nextLine.replace(/__([^_]+)__/g, '$1');
  nextLine = nextLine.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  return nextLine;
}

function centerText(text: string, width: number): string {
  const trimmed = trimToWidth(text, width);
  if (trimmed.length >= width) {
    return trimmed;
  }

  const left = Math.floor((width - trimmed.length) / 2);
  const right = width - trimmed.length - left;
  return `${' '.repeat(left)}${trimmed}${' '.repeat(right)}`;
}

function buildHeaderCardLine(content: string, width: number): string {
  return `${chalk.gray('│ ')}${padRight(content, width - 1)}${chalk.gray('│')}`;
}

function getPrefix(kind: LogKind): { plain: string; display: string } {
  switch (kind) {
    case 'info':
      return { plain: '· ', display: chalk.hex('#cbd5e1')('· ') };
    case 'user':
      return { plain: '◉ ', display: chalk.cyanBright('◉ ') };
    case 'assistant':
      return { plain: '✦ ', display: chalk.hex('#c9a8e8')('✦ ') };
    case 'warning':
      return { plain: '▲ ', display: chalk.yellowBright('▲ ') };
    case 'error':
      return { plain: '✕ ', display: chalk.redBright('✕ ') };
    case 'success':
      return { plain: '● ', display: chalk.greenBright('● ') };
    case 'command':
      return { plain: '◌ ', display: chalk.hex('#c9a8e8')('◌ ') };
    case 'system':
      return { plain: '· ', display: chalk.gray('· ') };
    default:
      return { plain: '• ', display: chalk.dim('• ') };
  }
}

function colorize(kind: LogKind, text: string): string {
  switch (kind) {
    case 'info':
      return chalk.hex('#cbd5e1')(text);
    case 'user':
      return chalk.cyan(text);
    case 'assistant':
      return chalk.white(text);
    case 'diff':
      return text;
    case 'warning':
      return chalk.yellow(text);
    case 'error':
      return chalk.red(text);
    case 'success':
      return chalk.green(text);
    case 'command':
      return chalk.hex('#c9a8e8')(text);
    case 'system':
      return chalk.gray(text);
    default:
      return chalk.dim(text);
  }
}

function shouldInsertSpacer(current: LogEntry, next: LogEntry | undefined): boolean {
  if (!next) {
    return false;
  }

  if (current.kind === 'success' && next.kind === 'success') {
    return false;
  }

  if (current.kind === 'command' && next.kind === 'command') {
    return false;
  }

  return true;
}

export class TerminalUI {
  private model: string;
  private projectDir: string;
  private version: string;
  private status = 'Ready';
  private activity: string | null = null;
  private activityPreview = '';
  private busy = false;
  private busyFrame = 0;
  private animationTick = 0;
  private input = '';
  private viewportTop: number | null = null;
  private lastBodyHeight = 0;
  private lastMessageLineCount = 0;
  private logEntries: LogEntry[] = [];
  private nextEntryId = 1;
  private submitHandler: ((value: string) => void) | null = null;
  private exitHandler: (() => void) | null = null;
  private confirmResolver: ((answer: boolean) => void) | null = null;
  private confirmQuestion: string | null = null;
  private confirmMode: DecisionMode = 'apply';
  private isStarted = false;
  private cleanedUp = false;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly keypressHandler: (str: string, key: any) => void;
  private readonly resizeHandler: () => void;
  private balance: string | null = null;
  private deposit: string | null = null;
  private configSource = '';
  private inputHistory: string[] = [];
  private historyIndex = -1;
  private savedInput = '';
  private slashIndex = 0;
  private subMenu: SubMenuState | null = null;
  private subMenuProviders: Map<string, () => SubMenuItem[]> = new Map();
  private mode: 'code' | 'plan' = 'code';

  constructor(options: TerminalUIOptions) {
    this.model = options.model;
    this.projectDir = options.projectDir;
    this.version = options.version;
    this.keypressHandler = (str, key) => this.handleKeypress(str, key);
    this.resizeHandler = () => this.render();
  }

  setSubmitHandler(handler: (value: string) => void): void {
    this.submitHandler = handler;
  }

  setExitHandler(handler: () => void): void {
    this.exitHandler = handler;
  }

  start(): void {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;
    this.cleanedUp = false;

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('keypress', this.keypressHandler);
    process.stdout.on('resize', this.resizeHandler);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
    this.animationTimer = setInterval(() => this.animateIdleState(), 420);
    this.render();
  }

  stop(): void {
    if (this.cleanedUp) {
      return;
    }

    this.cleanedUp = true;
    process.stdin.off('keypress', this.keypressHandler);
    process.stdout.off('resize', this.resizeHandler);
    if (this.animationTimer) {
      clearInterval(this.animationTimer);
      this.animationTimer = null;
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();

    process.stdout.write('\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l');
  }

  setBusy(busy: boolean, status?: string): void {
    this.busy = busy;
    if (!busy) {
      this.busyFrame = 0;
    }
    if (status) {
      this.status = status;
    } else if (!busy && this.status.startsWith('Working')) {
      this.status = 'Ready';
    }
    this.render();
  }

  setStatus(status: string): void {
    this.status = status;
    this.render();
  }

  setActivity(activity: string | null, preview = ''): void {
    this.activity = activity;
    this.activityPreview = activity ? preview : '';
    if (activity) {
      this.busyFrame = (this.busyFrame + 1) % 10_000;
    }
    this.render();
  }

  setModel(model: string): void {
    this.model = model;
    this.render();
  }

  setBalance(balance: string): void {
    const num = parseFloat(balance);
    this.balance = isNaN(num) ? balance : num.toFixed(2);
    this.render();
  }

  setDeposit(available: string, total: string): void {
    const num = parseFloat(available);
    if (isNaN(num)) {
      this.deposit = available;
    } else if (num >= 1) {
      this.deposit = num.toFixed(2);
    } else {
      // Show up to 4 decimals for small amounts, trim trailing zeros
      this.deposit = parseFloat(num.toFixed(4)).toString();
    }
    this.render();
  }

  setConfigSource(source: string): void {
    this.configSource = source;
    this.render();
  }

  setMode(mode: 'code' | 'plan'): void {
    this.mode = mode;
    this.render();
  }

  getMode(): 'code' | 'plan' {
    return this.mode;
  }

  registerSubMenu(command: string, getItems: () => SubMenuItem[]): void {
    this.subMenuProviders.set(command, getItems);
  }

  private openSubMenu(command: string): boolean {
    const provider = this.subMenuProviders.get(command);
    if (!provider) return false;
    const items = provider();
    if (items.length === 0) return false;
    const activeIndex = items.findIndex((item) => item.hint === 'current');
    this.subMenu = {
      command,
      items,
      selectedIndex: Math.max(0, activeIndex),
    };
    this.input = command;
    this.render();
    return true;
  }

  private getSlashMatches(): typeof SLASH_COMMANDS {
    if (!this.input.startsWith('/')) return [];
    const query = this.input.toLowerCase();
    return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(query));
  }

  clearConversation(): void {
    this.logEntries = [];
    this.viewportTop = null;
    this.render();
  }

  log(kind: LogKind, text: string): void {
    const normalizedText = text.replace(/\r\n/g, '\n');
    this.logEntries.push({
      id: this.nextEntryId++,
      kind,
      text: normalizedText,
    });

    if (this.logEntries.length > MAX_LOG_ENTRIES) {
      this.logEntries = this.logEntries.slice(this.logEntries.length - MAX_LOG_ENTRIES);
    }

    this.render();
  }

  createEntry(kind: LogKind, text = ''): number {
    const entry: LogEntry = {
      id: this.nextEntryId++,
      kind,
      text,
    };
    this.logEntries.push(entry);

    if (this.logEntries.length > MAX_LOG_ENTRIES) {
      this.logEntries = this.logEntries.slice(this.logEntries.length - MAX_LOG_ENTRIES);
    }

    this.render();
    return entry.id;
  }

  appendToEntry(entryId: number, text: string): void {
    const entry = this.logEntries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      return;
    }

    entry.text += text;
    this.render();
  }

  updateEntry(entryId: number, text: string): void {
    const entry = this.logEntries.find((candidate) => candidate.id === entryId);
    if (!entry) {
      return;
    }

    entry.text = text;
    this.render();
  }

  removeEntry(entryId: number): void {
    const nextEntries = this.logEntries.filter((candidate) => candidate.id !== entryId);
    if (nextEntries.length === this.logEntries.length) {
      return;
    }

    this.logEntries = nextEntries;
    this.render();
  }

  async confirm(question: string): Promise<boolean> {
    return this.requestDecision(question, 'apply');
  }

  async promptLaunch(question: string): Promise<boolean> {
    return this.requestDecision(question, 'launch');
  }

  private async requestDecision(question: string, mode: DecisionMode): Promise<boolean> {
    if (this.confirmResolver) {
      return false;
    }

    this.confirmQuestion = question;
    this.confirmMode = mode;
    this.render();

    return new Promise<boolean>((resolve) => {
      this.confirmResolver = resolve;
    });
  }

  private handleKeypress(str: string, key: any): void {
    if (this.confirmResolver) {
      if (key?.name === 'return') {
        const resolve = this.confirmResolver;
        this.confirmResolver = null;
        this.confirmQuestion = null;
        this.confirmMode = 'apply';
        resolve(true);
        this.render();
        return;
      }

      if (key?.name === 'escape' || (key?.ctrl && key?.name === 'c')) {
        const resolve = this.confirmResolver;
        this.confirmResolver = null;
        this.confirmQuestion = null;
        this.confirmMode = 'apply';
        resolve(false);
        this.render();
        return;
      }

      return;
    }

    if (key?.ctrl && key?.name === 'c') {
      this.exitHandler?.();
      return;
    }

    // Sub-menu mode: dedicated keypress handling
    if (this.subMenu) {
      if (key?.name === 'escape') {
        this.subMenu = null;
        this.input = '';
        this.render();
        return;
      }
      if (key?.name === 'up') {
        this.subMenu.selectedIndex =
          (this.subMenu.selectedIndex - 1 + this.subMenu.items.length) % this.subMenu.items.length;
        this.render();
        return;
      }
      if (key?.name === 'down') {
        this.subMenu.selectedIndex =
          (this.subMenu.selectedIndex + 1) % this.subMenu.items.length;
        this.render();
        return;
      }
      if (key?.name === 'return') {
        const item = this.subMenu.items[this.subMenu.selectedIndex];
        if (!item || !item.value) {
          this.subMenu = null;
          this.input = '';
          this.render();
          return;
        }
        const fullCommand = `${this.subMenu.command} ${item.value}`;
        this.subMenu = null;
        this.inputHistory.push(fullCommand);
        this.input = '';
        this.historyIndex = -1;
        this.savedInput = '';
        this.slashIndex = 0;
        this.render();
        this.submitHandler?.(fullCommand);
        return;
      }
      // Any other key closes sub-menu and falls through
      this.subMenu = null;
    }

    if (key?.name === 'return') {
      // If slash autocomplete is showing, handle partial/exact matches
      const slashMatches = this.getSlashMatches();
      if (slashMatches.length > 0) {
        const inputLower = this.input.trim().toLowerCase();
        const isExactCommand = SLASH_COMMANDS.some((cmd) => cmd.name === inputLower);
        const hasArgs = this.input.includes(' ') && this.input.trim().split(/\s+/).length > 1;

        if (!isExactCommand && !hasArgs) {
          // Partial match: resolve to the selected command
          const selected = slashMatches[this.slashIndex % slashMatches.length];
          // If this command has a sub-menu, open it directly
          if (this.subMenuProviders.has(selected.name)) {
            this.openSubMenu(selected.name);
            return;
          }
          this.input = selected.name + ' ';
          this.slashIndex = 0;
          this.render();
          return;
        }

        // Exact command match with no args — try to open sub-menu
        if (isExactCommand && !hasArgs && this.subMenuProviders.has(inputLower)) {
          this.openSubMenu(inputLower);
          return;
        }
      }

      const submittedValue = this.input.trim();
      if (submittedValue) {
        this.inputHistory.push(submittedValue);
      }
      this.input = '';
      this.historyIndex = -1;
      this.savedInput = '';
      this.slashIndex = 0;
      this.render();

      if (submittedValue) {
        this.submitHandler?.(submittedValue);
      }
      return;
    }

    if (key?.name === 'backspace') {
      this.input = this.input.slice(0, -1);
      this.slashIndex = 0;
      this.render();
      return;
    }

    // Slash command autocomplete
    {
      const matches = this.getSlashMatches();
      if (matches.length > 0) {
        if (key?.name === 'tab') {
          const selected = matches[this.slashIndex % matches.length];
          // If this command has a sub-menu, open it
          if (this.subMenuProviders.has(selected.name)) {
            this.openSubMenu(selected.name);
            return;
          }
          this.input = selected.name + ' ';
          this.slashIndex = 0;
          this.render();
          return;
        }
        if (key?.name === 'up') {
          this.slashIndex = (this.slashIndex - 1 + matches.length) % matches.length;
          this.render();
          return;
        }
        if (key?.name === 'down') {
          this.slashIndex = (this.slashIndex + 1) % matches.length;
          this.render();
          return;
        }
      }
    }

    // Scroll: Up/Down arrows, PageUp/PageDown, Shift+Up/Down
    if (key?.name === 'up' || (key?.shift && key?.name === 'up')) {
      this.scrollBy(-3);
      return;
    }

    if (key?.name === 'down' || (key?.shift && key?.name === 'down')) {
      this.scrollBy(3);
      return;
    }

    if (key?.name === 'pageup') {
      this.scrollBy(-Math.max(5, Math.floor(this.lastBodyHeight / 2)));
      return;
    }

    if (key?.name === 'pagedown') {
      this.scrollBy(Math.max(5, Math.floor(this.lastBodyHeight / 2)));
      return;
    }

    // Input history: Ctrl+P (previous) / Ctrl+N (next)
    if (key?.ctrl && key?.name === 'p') {
      if (this.inputHistory.length === 0) return;
      if (this.historyIndex === -1) {
        this.savedInput = this.input;
      }
      const nextIndex = Math.min(this.historyIndex + 1, this.inputHistory.length - 1);
      if (nextIndex !== this.historyIndex) {
        this.historyIndex = nextIndex;
        this.input = this.inputHistory[this.inputHistory.length - 1 - this.historyIndex];
        this.render();
      }
      return;
    }

    if (key?.ctrl && key?.name === 'n') {
      if (this.historyIndex <= -1) return;
      this.historyIndex -= 1;
      if (this.historyIndex === -1) {
        this.input = this.savedInput;
      } else {
        this.input = this.inputHistory[this.inputHistory.length - 1 - this.historyIndex];
      }
      this.render();
      return;
    }

    if (key?.name === 'home') {
      this.jumpToOldest();
      return;
    }

    if (key?.name === 'end') {
      this.jumpToLatest();
      return;
    }

    if (key?.name === 'escape') {
      this.input = '';
      this.render();
      return;
    }

    if (key?.ctrl && key?.name === 'l') {
      this.render();
      return;
    }

    if (typeof str === 'string' && str && !key?.meta && !key?.ctrl) {
      this.input += str;
      this.slashIndex = 0;
      this.render();
    }
  }

  private formatEntry(entry: LogEntry, width: number): string[] {
    if (entry.kind === 'plan') {
      return this.formatPlanEntry(entry, width);
    }

    if (entry.kind === 'diff') {
      return this.formatDiffEntry(entry, width);
    }

    const normalizedText = normalizeMarkdownForTerminal(entry.kind, entry.text);
    const prefix = getPrefix(entry.kind);
    const continuationPrefix = ' '.repeat(prefix.plain.length);
    const availableWidth = Math.max(8, width - prefix.plain.length);
    const paragraphs = wrapParagraph(normalizedText, availableWidth);

    return paragraphs.map((paragraph, index) => {
      const bodyText = colorize(entry.kind, paragraph);
      if (index === 0) {
        return `${prefix.display}${bodyText}`;
      }

      return `${continuationPrefix}${bodyText}`;
    });
  }

  private formatPlanEntry(entry: LogEntry, width: number): string[] {
    const text = entry.text;
    const contentWidth = Math.max(30, width - 4);
    const result: string[] = [];

    // Colors — aura purple palette
    const accent = chalk.hex('#c9a8e8');
    const dim = chalk.hex('#9b7fc4');
    const fileColor = chalk.hex('#67e8f9');
    const descColor = chalk.hex('#cbd5e1');
    const noteColor = chalk.hex('#d4b8f0');
    const bar = accent('│');

    const actionBadges: Record<string, string> = {
      create: chalk.hex('#6ee7b7')('+'),
      edit: chalk.hex('#7dd3fc')('~'),
      delete: chalk.hex('#fda4af')('-'),
      config: chalk.hex('#d8b4fe')('⚙'),
      install: chalk.hex('#fbbf24')('↓'),
    };

    // Parse structured plan
    const titleMatch = text.match(/<plan_title>([\s\S]*?)<\/plan_title>/);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const stepRegex = /<plan_step>\s*<step_number>(\d+)<\/step_number>\s*<step_action>(\w+)<\/step_action>\s*<step_file>([\s\S]*?)<\/step_file>\s*<step_desc>([\s\S]*?)<\/step_desc>\s*<\/plan_step>/g;
    const steps: { num: string; action: string; file: string; desc: string }[] = [];
    let match;
    while ((match = stepRegex.exec(text)) !== null) {
      steps.push({
        num: match[1],
        action: match[2].trim().toLowerCase(),
        file: match[3].trim(),
        desc: match[4].trim(),
      });
    }

    const notesMatch = text.match(/<plan_notes>([\s\S]*?)<\/plan_notes>/);
    const notes = notesMatch ? notesMatch[1].trim() : '';

    // If no structured steps found, fall back to plain rendering
    if (steps.length === 0) {
      const prefix = getPrefix('assistant');
      const availableWidth = Math.max(8, width - prefix.plain.length);
      const paragraphs = wrapParagraph(text, availableWidth);
      return paragraphs.map((p, i) => {
        const body = chalk.white(p);
        return i === 0 ? `${prefix.display}${body}` : `  ${body}`;
      });
    }

    // Title line
    if (title) {
      result.push(`${bar} ${accent.bold(`✦ ${title}`)}`);
    }
    result.push(`${bar}`);

    // Steps — compact: one line per step, description on next line
    for (const step of steps) {
      const badge = actionBadges[step.action] || actionBadges.edit;
      const file = trimToWidth(step.file, contentWidth - step.num.length - 6);
      result.push(`${bar}  ${accent(step.num + '.')} ${badge} ${fileColor(file)}`);

      const descLines = wrapParagraph(step.desc, contentWidth - 6);
      for (const dLine of descLines) {
        result.push(`${bar}     ${descColor(dLine)}`);
      }
    }

    // Notes
    if (notes) {
      result.push(`${bar}`);
      const notesLines = wrapParagraph(notes, contentWidth - 4);
      for (const nLine of notesLines) {
        result.push(`${bar}  ${noteColor(nLine)}`);
      }
    }

    result.push(`${dim('╵')}`);

    return result;
  }

  private formatDiffEntry(entry: LogEntry, width: number): string[] {
    const availableWidth = Math.max(8, width);
    const result: string[] = [];
    const lines = entry.text.split('\n');

    for (const line of lines) {
      const wrapped = wrapParagraph(line, availableWidth);
      for (const chunk of wrapped) {
        result.push(this.colorizeDiffLine(chunk, availableWidth));
      }
    }

    return result;
  }

  private colorizeDiffLine(line: string, width: number): string {
    if (line.startsWith('◆ ')) {
      // File header — aura purple accent
      const path = line.slice(2).split(' · ')[0];
      const rest = line.slice(2 + path.length);
      return `${chalk.hex('#c9a8e8')('◇')} ${chalk.hex('#67e8f9')(path)}${chalk.hex('#64748b')(rest)}`;
    }

    if (line === '  new') {
      return chalk.hex('#6ee7b7')('  + new');
    }

    if (line === '  edit') {
      return chalk.hex('#7dd3fc')('  ~ edit');
    }

    if (line.startsWith('  no textual diff')) {
      return chalk.hex('#475569')(line);
    }

    if (line.startsWith('+ ')) {
      return chalk.bgHex('#0a1f14').hex('#6ee7b7')(padRight(line, width));
    }

    if (line.startsWith('- ')) {
      return chalk.bgHex('#1f0a10').hex('#f87171')(padRight(line, width));
    }

    if (line.startsWith('… ')) {
      return chalk.hex('#475569')(line);
    }

    return chalk.hex('#334155')(line);
  }

  private animateIdleState(): void {
    if (!this.isStarted || this.cleanedUp) {
      return;
    }

    if (this.busy || this.confirmResolver || this.logEntries.length > 0) {
      return;
    }

    this.animationTick = (this.animationTick + 1) % 6;
    this.render();
  }

  private getMaxViewportTop(): number {
    return Math.max(0, this.lastMessageLineCount - this.lastBodyHeight);
  }

  private scrollBy(delta: number): void {
    if (this.lastMessageLineCount === 0) {
      return;
    }

    const maxTop = this.getMaxViewportTop();
    if (maxTop === 0) {
      return;
    }

    const currentTop = this.viewportTop === null ? maxTop : this.viewportTop;
    const nextTop = Math.max(0, Math.min(maxTop, currentTop + delta));
    this.viewportTop = nextTop >= maxTop ? null : nextTop;
    this.render();
  }

  private jumpToOldest(): void {
    if (this.lastMessageLineCount === 0) {
      return;
    }

    const maxTop = this.getMaxViewportTop();
    if (maxTop === 0) {
      return;
    }

    this.viewportTop = 0;
    this.render();
  }

  private jumpToLatest(): void {
    if (this.lastMessageLineCount === 0) {
      return;
    }

    this.viewportTop = null;
    this.render();
  }

  private buildEmptyState(width: number, maxLines: number): string[] {
    const cardWidth = Math.max(52, Math.min(width, 92));
    const cardInnerWidth = cardWidth - 2;
    const leftPad = ' '.repeat(Math.max(0, Math.floor((width - cardWidth) / 2)));
    const border = chalk.hex('#c9a8e8');
    const pulseFrames = ['#ff4fcf', '#ff77d9', '#ff9ceb', '#ff77d9', '#ff4fcf', '#f23ec7'];
    const pulseColor = pulseFrames[this.animationTick % pulseFrames.length];
    const labelColor = chalk.hex(pulseColor);
    const projectName = this.projectDir.split(/[\\/]/).filter(Boolean).pop() || this.projectDir;

    const row = (content: string, color = chalk.white): string =>
      `${leftPad} ${color(padRight(content, cardInnerWidth))} `;

    // Cute kawaii purple cat mascot — rounded with half-blocks
    const frame = this.animationTick % 6;
    const p = chalk.hex('#c9a8e8');  // light purple (body)
    const dp = chalk.hex('#9b7fc4'); // darker purple (ears, chin edge)
    const lp = chalk.hex('#d4b8f0'); // lighter purple (inner ear)
    const d = chalk.hex('#2d1b4e');  // dark (eyes/mouth)
    const pk = chalk.hex('#f0a0c0'); // pink (cheeks)
    const tailFrames = ['~', '∼', '≈', '∼', '∽', '~'];
    const tail = chalk.hex(pulseColor)(tailFrames[frame]);
    const blink = frame === 3;
    const wink = frame === 5;
    const eyeL = blink ? d('━') : d('●');
    const eyeR = blink ? d('━') : wink ? d('━') : d('●');
    const mouthFrames = [0, 0, 1, 0, 0, 2];
    const mf = mouthFrames[frame];
    const mouth = mf === 1 ? d('ω') : mf === 2 ? d('◡') : d('ᴗ');

    const mascotRendered = [
      `  ${dp('▄')}${lp('██')}${dp('▄')}    ${dp('▄')}${lp('██')}${dp('▄')}  `,
      ` ${dp('█████')}${p('▄▄▄▄')}${dp('█████')} `,
      `${p('████████████████')}`,
      `${p('███')}  ${eyeL}    ${eyeR}  ${p('███')}`,
      `${p('███')}  ${pk('•')}    ${pk('•')}  ${p('███')}`,
      `${p('████')}   ${mouth}${mouth}   ${p('████')}`,
      `${p('████████████████')}`,
      ` ${dp('▀')}${p('████████████')}${dp('▀')} `,
      `   ${p('██████████')}   `,
      `    ${p('████████')} ${tail}  `,
      `    ${p('███')}  ${p('███')}    `,
    ];

    const mascotWidths = [16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16];

    const tips = [
      'try: "build a landing page with Tailwind"',
      'try: "add dark mode to this project"',
      '/add <file> to include files in context',
      '/model to switch AI models',
      '/deposit to fund compute from wallet',
      '/help for all commands',
      '/undo to revert applied changes',
    ];
    const tip = tips[Math.floor(this.animationTick / 12) % tips.length];

    // Row that takes pre-colored content
    const rawRow = (content: string, plainLen: number): string => {
      const half = Math.floor((cardInnerWidth - plainLen) / 2);
      const rightPad = cardInnerWidth - plainLen - half;
      return `${leftPad} ${' '.repeat(half)}${content}${' '.repeat(rightPad)} `;
    };

    // Starfield generator for left/right sides
    const leftW = leftPad.length;
    const rightW = Math.max(0, width - cardWidth - leftW);
    const starLine = (w: number, seed: number): string => {
      if (w <= 0) return '';
      const chars: string[] = [];
      for (let i = 0; i < w; i++) {
        const h = ((seed * 137 + i * 31 + 5) % 97);
        const t = ((this.animationTick + seed * 3 + i * 7) % 24);
        if (h < 10) {
          if (t === 0) chars.push(chalk.hex('#c4b5fd')('✦'));
          else if (h < 3) chars.push(chalk.hex('#334155')('.'));
          else if (h < 6) chars.push(chalk.hex('#475569')('·'));
          else if (h < 8) chars.push(chalk.hex('#64748b')('✧'));
          else chars.push(chalk.hex('#94a3b8')('*'));
        } else {
          chars.push(' ');
        }
      }
      return chars.join('');
    };

    // Separator with animated pulse dots
    const dotCount = (this.animationTick % 3) + 1;
    const sepDots = labelColor('•'.repeat(dotCount));
    const sepDash = chalk.hex('#475569')('━━━━━━');
    const sepLine = `${sepDash} ${sepDots} ${sepDash}`;
    const sepW = 14 + dotCount;

    // Styled info line
    const modelStr = this.model.toLowerCase();
    const infoLine = `${chalk.hex('#94a3b8')(modelStr)} ${chalk.hex('#bd93f9')('◆')} ${chalk.hex('#64748b')(projectName)}`;
    const infoW = modelStr.length + 3 + projectName.length;

    // Styled tip
    const tipLine = `${chalk.hex('#bd93f9')('▸')}${chalk.hex('#cbd5e1')(` ${tip}`)}`;
    const tipW = 2 + tip.length;

    const lines = [
      row(' '.repeat(cardInnerWidth), chalk.reset),
      ...mascotRendered.map((line, i) => rawRow(line, mascotWidths[i])),
      row(' '.repeat(cardInnerWidth), chalk.reset),
      rawRow(sepLine, sepW),
    ];

    // Decorate sides with starfield
    const decorated = lines.map((line, idx) => {
      const left = starLine(leftW, idx);
      const right = starLine(rightW, idx + 50);
      return left + line.slice(leftW) + right;
    });

    return decorated.slice(0, Math.max(0, maxLines));
  }

  private buildBusyIndicator(width: number, maxLines: number): string[] {
    if (maxLines <= 0) {
      return [];
    }

    const lineCount = Math.min(Math.max(2, Math.min(4, maxLines)), 4);
    const lineWidths = [Math.floor(width * 0.58), Math.floor(width * 0.82), Math.floor(width * 0.68), Math.floor(width * 0.9)];
    const lines: string[] = [];

    for (let index = 0; index < lineCount; index += 1) {
      const laneWidth = Math.max(16, Math.min(width, lineWidths[index] || width));
      const leftPad = ' '.repeat(Math.max(0, Math.floor((width - laneWidth) / 2)));
      const rightPad = ' '.repeat(Math.max(0, width - laneWidth - leftPad.length));
      const segmentWidth = Math.max(6, Math.min(16, Math.floor(laneWidth * 0.18)));
      const cycle = laneWidth + segmentWidth + 6;
      const frame = (this.busyFrame + index * 3) % cycle;
      const start = Math.max(0, Math.min(laneWidth - segmentWidth, frame - segmentWidth));
      const end = Math.min(laneWidth, start + segmentWidth);
      const before = ' '.repeat(start);
      const active = ' '.repeat(Math.max(0, end - start));
      const after = ' '.repeat(Math.max(0, laneWidth - end));
      const line =
        leftPad +
        chalk.bgHex('#0e1119')(
          `${before}${chalk.bgHex(index % 2 === 0 ? '#1a2336' : '#161f16').hex(index % 2 === 0 ? '#7dd3fc' : '#86efac')(active)}${after}`
        ) +
        rightPad;

      lines.push(line);
    }

    return lines;
  }

  private buildBusyPreview(width: number, maxLines: number): string[] {
    if (maxLines <= 0) {
      return [];
    }

    const normalizedLines = this.activityPreview
      .replace(/\r\n/g, '\n')
      .replace(/<file\s+path="([^"]+)">/g, 'file: $1')
      .replace(/<\/file>/g, '')
      .replace(/```(?:[a-zA-Z0-9_-]+)?/g, '')
      .split('\n')
      .map((line) => normalizeMarkdownLine(line).trim())
      .filter(Boolean);

    if (normalizedLines.length === 0) {
      return this.buildBusyIndicator(width, maxLines);
    }

    const tail = normalizedLines.slice(-Math.max(2, Math.min(maxLines, 4)));
    const rendered: string[] = [];

    for (let index = 0; index < tail.length; index += 1) {
      const line = tail[index];
      const wrapped = wrapParagraph(trimToWidth(line, width), width);

      for (const chunk of wrapped) {
        const padded = padRight(chunk, width);

        if (index === tail.length - 1) {
          rendered.push(chalk.bgHex('#101922').hex('#7dd3fc')(padded));
        } else if (index === tail.length - 2) {
          rendered.push(chalk.bgHex('#0f1612').hex('#86efac')(padded));
        } else {
          rendered.push(chalk.bgBlackBright.gray(padded));
        }
      }
    }

    return rendered.slice(-maxLines);
  }

  private render(): void {
    if (!this.isStarted || this.cleanedUp) {
      return;
    }

    const columns = Math.max(72, process.stdout.columns || 72);
    const rows = Math.max(20, process.stdout.rows || 24);
    const innerWidth = columns - 2;

    const headerCardWidth = Math.max(24, innerWidth - 2);
    const derivedStatus = this.confirmResolver
      ? this.confirmMode === 'launch'
        ? 'Preview'
        : 'Apply'
      : this.status || (this.busy ? 'Live' : 'Ready');
    const statusLabel = trimToWidth(
      derivedStatus,
      Math.max(12, Math.floor(headerCardWidth / 3))
    );

    // Colors
    const a = chalk.hex('#c9a8e8'); // light purple (mascot body)
    const accent = chalk.hex('#d4b8f0'); // lighter purple
    const dim = chalk.hex('#555e6e');
    const bright = chalk.hex('#e2e8f0');
    const statusColor = this.confirmResolver
      ? this.confirmMode === 'launch'
        ? chalk.hex('#8be9fd')
        : chalk.hex('#50fa7b')
      : this.busy
        ? chalk.hex('#f1fa8c')
        : chalk.hex('#50fa7b');

    // Balance chips
    const chips: string[] = [];
    if (this.balance !== null) {
      chips.push(`${dim('wallet')} ${bright(this.balance)}`);
    }
    if (this.deposit !== null) {
      const depNum = parseFloat(this.deposit);
      const depositColor = isNaN(depNum) || depNum < 0.01
        ? chalk.redBright
        : depNum < 0.05
          ? chalk.yellowBright
          : chalk.greenBright;
      chips.push(`${dim('deposit')} ${depositColor(this.deposit)}`);
    }
    const chipLine = chips.length > 0
      ? `${chips.join(dim('  ·  '))} ${dim('A0GI')}`
      : '';

    // Status dot
    const statusDot = this.busy ? chalk.hex('#f1fa8c')('◌') : chalk.hex('#50fa7b')('●');

    // Build card
    const topBar = dim('━'.repeat(headerCardWidth + 2));
    const botBar = dim('━'.repeat(headerCardWidth + 2));
    const line1 = `  ${a.bold('a u r a')}  ${dim('v' + this.version)}  ${dim('·')}  ${accent('powered by 0g')}`;
    const planBadge = this.mode === 'plan' ? `  ${chalk.bgHex('#c9a8e8').black(' PLAN ')}` : '';
    const line2 = `  ${dim('model')} ${bright(this.model)}${planBadge}  ${dim('·')}  ${statusDot} ${statusColor(statusLabel)}`;
    const line3 = chipLine ? `  ${chipLine}` : '';

    const headerLines = [
      topBar,
      padRight(line1, headerCardWidth + 2),
      padRight(line2, headerCardWidth + 2),
      ...(line3 ? [padRight(line3, headerCardWidth + 2)] : []),
      botBar,
    ];

    const activityLines = this.activity
      ? [chalk.dim(`· ${trimToWidth(this.activity, innerWidth - 2)}`)]
      : [];

    const footerWidth = Math.max(24, innerWidth);
    const footerDivider = chalk.gray(borderLine(footerWidth));
    const footerLines = this.confirmResolver
      ? (() => {
          if (this.confirmMode === 'launch') {
            return [
              footerDivider,
              chalk.hex('#7dd3fc')(
                padRight(trimToWidth('· action pending • preview', footerWidth), footerWidth)
              ),
              chalk.bgHex('#7dd3fc').black(
                padRight(trimToWidth(' ↵ open preview now', footerWidth), footerWidth)
              ),
              chalk.gray(
                padRight(
                  trimToWidth(`${this.confirmQuestion || ''} • esc skips`, footerWidth),
                  footerWidth
                )
              ),
            ];
          }

          return [
            footerDivider,
            chalk.hex('#86efac')(
              padRight(trimToWidth('· changes staged • apply', footerWidth), footerWidth)
            ),
            chalk.bgHex('#b7f5c6').black(
              padRight(trimToWidth(' ↵ apply now', footerWidth), footerWidth)
            ),
            chalk.gray(
              padRight(
                trimToWidth(`enter writes files now • esc keeps current files • ${this.confirmQuestion || ''}`, footerWidth),
                footerWidth
              )
            ),
          ];
        })()
      : (() => {
          const prefix = this.busy
            ? chalk.bgBlack.yellow(' … ')
            : chalk.bgBlack.cyan(' › ');
          const avail = footerWidth - 3;
          let textLine: string;
          if (this.busy) {
            const display = this.input || 'describe what to build, edit, or fix...';
            textLine = (this.input ? chalk.bgBlack.white : chalk.bgBlack.gray)(
              padRight(trimToWidth(display, avail), avail)
            );
          } else if (this.input) {
            const display = trimToWidth(this.input, avail - 1);
            const rest = Math.max(0, avail - display.length - 1);
            textLine = chalk.bgBlack.white(display) + chalk.bgWhite(' ') + chalk.bgBlack(' '.repeat(rest));
          } else {
            const ph = 'describe what to build, edit, or fix...';
            const rest = Math.max(0, avail - 1);
            textLine = chalk.bgWhite(' ') + chalk.bgBlack.gray(padRight(trimToWidth(ph, rest), rest));
          }
          const emptyLine = chalk.bgBlack(' '.repeat(footerWidth));
          const configHint = this.configSource ? `  •  ${this.configSource}` : '';
          const contextLine = chalk.dim(
            trimFromStart(`${this.model.toLowerCase()}  •  ${this.projectDir}${configHint}`, footerWidth)
          );

          const suggestionLines: string[] = [];

          if (this.subMenu) {
            // Sub-menu: show items for the selected command
            const header = `  ${chalk.cyanBright(this.subMenu.command)}  ${chalk.dim('↑↓ select • enter confirm • esc cancel')}`;
            suggestionLines.push(padRight(header, footerWidth));
            const visible = this.subMenu.items.slice(0, MAX_SUGGESTIONS);
            for (let i = 0; i < visible.length; i++) {
              const item = visible[i];
              const marker = item.hint === 'current' ? chalk.greenBright(' ●') : '  ';
              const label = padRight(item.label, 32);
              const hint = item.hint && item.hint !== 'current'
                ? chalk.dim(` ${item.hint}`)
                : '';
              const row = `  ${marker} ${label}${hint}`;
              if (i === this.subMenu.selectedIndex) {
                suggestionLines.push(chalk.bgHex('#1e293b').whiteBright(padRight(row, footerWidth)));
              } else {
                suggestionLines.push(chalk.dim(padRight(row, footerWidth)));
              }
            }
          } else {
            const slashMatches = this.getSlashMatches().slice(0, MAX_SUGGESTIONS);
            if (slashMatches.length > 0) {
              for (let i = 0; i < slashMatches.length; i++) {
                const cmd = slashMatches[i];
                const hasSubIndicator = this.subMenuProviders.has(cmd.name) ? ' ▸' : '';
                const nameCol = padRight(`${cmd.name}${hasSubIndicator}`, 24);
                const desc = trimToWidth(cmd.description, footerWidth - 26);
                const line = `  ${nameCol}${desc}`;
                if (i === this.slashIndex % slashMatches.length) {
                  suggestionLines.push(chalk.bgHex('#1e293b').white(padRight(line, footerWidth)));
                } else {
                  suggestionLines.push(chalk.dim(padRight(line, footerWidth)));
                }
              }
            }
          }

          return [
            footerDivider,
            emptyLine,
            `${prefix}${textLine}`,
            ...(suggestionLines.length > 0 ? suggestionLines : [emptyLine]),
            contextLine,
          ];
        })();

    const bodyHeight = Math.max(6, rows - headerLines.length - activityLines.length - footerLines.length);
    const baseMessageLines = this.logEntries.flatMap((entry, index) => {
      const lines = this.formatEntry(entry, innerWidth);
      if (shouldInsertSpacer(entry, this.logEntries[index + 1])) {
        lines.push('');
      }
      return lines;
    });
    const busyPreview =
      this.busy && this.activity
        ? this.buildBusyPreview(innerWidth, Math.min(4, Math.max(2, bodyHeight - Math.min(baseMessageLines.length, bodyHeight))))
        : [];
    const messageLines = busyPreview.length > 0 ? [...baseMessageLines, ...busyPreview] : baseMessageLines;
    this.lastBodyHeight = bodyHeight;
    this.lastMessageLineCount = messageLines.length;

    let visibleMessageLines: string[];

    if (messageLines.length === 0) {
      this.viewportTop = null;
      visibleMessageLines = this.buildEmptyState(innerWidth, bodyHeight);
    } else {
      const maxTop = Math.max(0, messageLines.length - bodyHeight);
      const top = this.viewportTop === null ? maxTop : Math.max(0, Math.min(maxTop, this.viewportTop));
      this.viewportTop = top >= maxTop ? null : top;
      visibleMessageLines = messageLines.slice(top, top + bodyHeight);
    }

    const allLines = [...headerLines, ...activityLines, ...visibleMessageLines, ...footerLines];
    // Pad to exactly `rows` lines so the entire screen is always filled
    while (allLines.length < rows) {
      allLines.push('');
    }
    // Truncate to exact terminal height to prevent overflow
    // \x1b[K after each line clears leftover chars from previous renders
    const screen = allLines.slice(0, rows).join('\x1b[K\n');
    // Move cursor home, write content, erase rest of last line + everything below
    process.stdout.write(`\x1b[H${screen}\x1b[K\x1b[J`);
  }
}

export function showError(msg: string): void {
  console.error(chalk.red(`\nError: ${msg}\n`));
}

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { dirname, join, relative, resolve, isAbsolute } from 'path';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import type { ParsedResponse, ParsedEdit } from './types.js';
import { fuzzyFind, adaptIndentation } from './fuzzy.js';

export interface ApplyHooks {
  confirm?: (question: string) => Promise<boolean>;
  onInfo?: (message: string) => void;
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
  onFileChange?: (path: string, isNew: boolean) => void;
  onDiffPreview?: (path: string, lines: string[]) => void;
  onEditApplied?: (path: string, layer: number) => void;
  onEditFailed?: (path: string, reason: string) => void;
  onCommand?: (command: string) => void;
  onCommandOutput?: (output: string, stream: 'stdout' | 'stderr') => void;
}

const MAX_PREVIEW_LINES = 2;
const MAX_EXCERPT_LENGTH = 88;
const MAX_UNDO_DEPTH = 10;

const backupStack: { path: string; content: string | null }[][] = [];

function resolveWithinProject(projectDir: string, candidatePath: string): string | null {
  if (!candidatePath || candidatePath.includes('\0')) {
    return null;
  }

  const resolvedPath = resolve(projectDir, candidatePath);
  const relativePath = relative(projectDir, resolvedPath);
  if (relativePath === '') {
    return resolvedPath;
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }

  return resolvedPath;
}

export function undoLastChanges(projectDir: string): { restored: string[]; removed: string[] } | null {
  const backup = backupStack.pop();
  if (!backup || backup.length === 0) return null;

  const restored: string[] = [];
  const removed: string[] = [];

  for (const entry of backup) {
    const fullPath = resolveWithinProject(projectDir, entry.path);
    if (!fullPath) {
      continue;
    }
    if (entry.content === null) {
      try {
        unlinkSync(fullPath);
        removed.push(entry.path);
      } catch { /* skip */ }
    } else {
      try {
        writeFileSync(fullPath, entry.content, 'utf-8');
        restored.push(entry.path);
      } catch { /* skip */ }
    }
  }

  return { restored, removed };
}

function toLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized) {
    return [];
  }

  const lines = normalized.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function trimExcerpt(line: string): string {
  const compact = line.trim().replace(/\s+/g, ' ');
  if (compact.length <= MAX_EXCERPT_LENGTH) {
    return compact;
  }

  return `${compact.slice(0, MAX_EXCERPT_LENGTH - 3)}...`;
}

function pickPreviewLines(lines: string[]): string[] {
  const meaningful = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_PREVIEW_LINES)
    .map(trimExcerpt);

  if (meaningful.length > 0) {
    return meaningful;
  }

  if (lines.length === 0) {
    return [];
  }

  return lines.slice(0, MAX_PREVIEW_LINES).map((line) => trimExcerpt(line));
}

function createDiffPreview(path: string, previous: string, next: string, isNew: boolean): string[] {
  const previousLines = toLines(previous);
  const nextLines = toLines(next);

  if (isNew) {
    const excerpts = pickPreviewLines(nextLines);
    const preview = [
      `◆ ${path} · ${nextLines.length} line(s)`,
      '  new',
      ...excerpts.map((line) => `+ ${line}`),
    ];
    if (nextLines.length > excerpts.length) {
      preview.push(`… ${nextLines.length - excerpts.length} more line(s)`);
    }
    return preview;
  }

  let prefix = 0;
  while (
    prefix < previousLines.length &&
    prefix < nextLines.length &&
    previousLines[prefix] === nextLines[prefix]
  ) {
    prefix += 1;
  }

  let previousSuffix = previousLines.length - 1;
  let nextSuffix = nextLines.length - 1;
  while (
    previousSuffix >= prefix &&
    nextSuffix >= prefix &&
    previousLines[previousSuffix] === nextLines[nextSuffix]
  ) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }

  const unchanged = prefix === previousLines.length && prefix === nextLines.length;
  if (unchanged) {
    return [`◆ ${path}`, '  no textual diff'];
  }

  const removed = previousLines.slice(prefix, previousSuffix + 1);
  const added = nextLines.slice(prefix, nextSuffix + 1);
  const removedPreview = pickPreviewLines(removed);
  const addedPreview = pickPreviewLines(added);
  const hiddenLines = Math.max(0, removed.length - removedPreview.length) + Math.max(0, added.length - addedPreview.length);

  return [
    `◆ ${path} · +${added.length} / -${removed.length}`,
    '  edit',
    ...removedPreview.map((line) => `- ${line}`),
    ...addedPreview.map((line) => `+ ${line}`),
    ...(hiddenLines > 0 ? [`… ${hiddenLines} more changed line(s)`] : []),
  ];
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question} (y/n) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}

function emitOutput(
  handler: ApplyHooks['onCommandOutput'],
  output: string,
  stream: 'stdout' | 'stderr'
): void {
  if (!handler) {
    return;
  }

  for (const line of output.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed) {
      handler(trimmed, stream);
    }
  }
}

const LAYER_NAMES: Record<number, string> = {
  1: 'exact',
  2: 'whitespace',
  3: 'indent',
  4: 'similarity',
};

function applyEditToContent(content: string, edit: ParsedEdit): { result: string; layer: number } | null {
  const match = fuzzyFind(content, edit.search);
  if (!match) return null;

  let replacement = edit.replace;
  if (match.layer > 1) {
    const originalSlice = content.slice(match.start, match.end);
    replacement = adaptIndentation(originalSlice, replacement);
  }

  const result = content.slice(0, match.start) + replacement + content.slice(match.end);
  return { result, layer: match.layer };
}

function createEditPreview(path: string, search: string, replace: string): string[] {
  const searchLines = toLines(search);
  const replaceLines = toLines(replace);
  const searchPreview = pickPreviewLines(searchLines);
  const replacePreview = pickPreviewLines(replaceLines);

  return [
    `◆ ${path} · edit · -${searchLines.length} / +${replaceLines.length}`,
    ...searchPreview.map((line) => `- ${line}`),
    ...replacePreview.map((line) => `+ ${line}`),
  ];
}

export async function applyChanges(
  parsed: ParsedResponse,
  projectDir: string,
  noConfirm: boolean,
  hooks: ApplyHooks = {}
): Promise<boolean> {
  const hasEdits = parsed.edits && parsed.edits.length > 0;
  if (parsed.files.length === 0 && !hasEdits && parsed.commands.length === 0) {
    return false;
  }

  const onInfo = hooks.onInfo || (() => {});
  const onError = hooks.onError || (() => {});
  const onSuccess = hooks.onSuccess || (() => {});
  const onFileChange = hooks.onFileChange || (() => {});
  const onDiffPreview = hooks.onDiffPreview || (() => {});
  const onEditApplied = hooks.onEditApplied || (() => {});
  const onEditFailed = hooks.onEditFailed || (() => {});
  const onCommand = hooks.onCommand || (() => {});
  const confirm = hooks.confirm || defaultConfirm;

  // Preview edits
  if (hasEdits) {
    for (const edit of parsed.edits) {
      onDiffPreview(edit.path, createEditPreview(edit.path, edit.search, edit.replace));
    }
  }

  // Preview file writes
  if (parsed.files.length > 0) {
    for (const file of parsed.files) {
      const fullPath = resolveWithinProject(projectDir, file.path);
      if (!fullPath) {
        onError(`Blocked path outside project root: ${file.path}`);
        continue;
      }
      const isNew = !existsSync(fullPath);
      onFileChange(file.path, isNew);
      let previousContent = '';
      if (!isNew) {
        try {
          previousContent = readFileSync(fullPath, 'utf-8');
        } catch {
          previousContent = '';
        }
      }
      onDiffPreview(file.path, createDiffPreview(file.path, previousContent, file.content, isNew));
    }
  }

  if (parsed.commands.length > 0) {
    const installCmds = parsed.commands.filter((c) => /npm install|yarn add|pnpm add|pnpm i\s/.test(c.command));
    const otherCmds = parsed.commands.filter((c) => !/npm install|yarn add|pnpm add|pnpm i\s/.test(c.command));
    if (installCmds.length > 0) {
      const packages = installCmds
        .map((c) => c.command.replace(/^(?:npm install|yarn add|pnpm add|pnpm i)\s+/i, '').trim())
        .join(', ');
      onInfo(`Install ${installCmds.length === 1 ? 'package' : 'packages'}: ${packages}`);
      for (const cmd of installCmds) {
        onCommand(cmd.command);
      }
    }
    if (otherCmds.length > 0) {
      for (const cmd of otherCmds) {
        onInfo(`Run: ${cmd.command}`);
        onCommand(cmd.command);
      }
    }
  }

  if (!noConfirm) {
    onInfo('changes staged • press enter to apply • esc to skip');
    const approved = await confirm('Apply these changes?');
    if (!approved) {
      onInfo('Skipped.');
      return false;
    }
  }

  // Collect all paths that will be touched (edits + file writes) for backup
  const backup: { path: string; content: string | null }[] = [];
  const touchedPaths = new Set<string>();

  if (hasEdits) {
    for (const edit of parsed.edits) {
      touchedPaths.add(edit.path);
    }
  }
  for (const file of parsed.files) {
    touchedPaths.add(file.path);
  }

  for (const p of touchedPaths) {
    const fullPath = resolveWithinProject(projectDir, p);
    if (!fullPath) continue;
    try {
      backup.push({
        path: p,
        content: existsSync(fullPath) ? readFileSync(fullPath, 'utf-8') : null,
      });
    } catch {
      backup.push({ path: p, content: null });
    }
  }
  if (backup.length > 0) {
    backupStack.push(backup);
    if (backupStack.length > MAX_UNDO_DEPTH) backupStack.shift();
  }

  // Apply edits FIRST (before whole-file writes)
  if (hasEdits) {
    // Group edits by file path, apply sequentially (order matters)
    const editsByFile = new Map<string, ParsedEdit[]>();
    for (const edit of parsed.edits) {
      const existing = editsByFile.get(edit.path) || [];
      existing.push(edit);
      editsByFile.set(edit.path, existing);
    }

    for (const [filePath, edits] of editsByFile) {
      const fullPath = resolveWithinProject(projectDir, filePath);
      if (!fullPath) {
        onError(`Blocked path outside project root: ${filePath}`);
        continue;
      }

      if (!existsSync(fullPath)) {
        onEditFailed(filePath, 'file not found');
        continue;
      }

      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        onEditFailed(filePath, 'unreadable');
        continue;
      }

      let allSucceeded = true;
      for (const edit of edits) {
        const result = applyEditToContent(content, edit);
        if (result) {
          content = result.result;
          const layerName = LAYER_NAMES[result.layer] || `L${result.layer}`;
          onEditApplied(filePath, result.layer);
          onSuccess(`Edit ${filePath} (${layerName} match)`);
        } else {
          allSucceeded = false;
          onEditFailed(filePath, 'no match found for search block');
          onError(`Edit failed: ${filePath} — could not find search text`);
        }
      }

      if (allSucceeded || content !== readFileSync(fullPath, 'utf-8')) {
        try {
          writeFileSync(fullPath, content, 'utf-8');
        } catch (err) {
          onError(`Failed to write ${filePath}: ${String(err)}`);
        }
      }
    }
  }

  // Apply whole-file writes
  for (const file of parsed.files) {
    const fullPath = resolveWithinProject(projectDir, file.path);
    if (!fullPath) {
      onError(`Blocked path outside project root: ${file.path}`);
      continue;
    }
    try {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, 'utf-8');
      onSuccess(`Wrote ${file.path}`);
    } catch (err) {
      onError(`Failed to write ${file.path}: ${String(err)}`);
    }
  }

  // Run commands
  for (const cmd of parsed.commands) {
    try {
      onInfo(`Running: ${cmd.command}`);
      const output = execSync(cmd.command, {
        cwd: projectDir,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      emitOutput(hooks.onCommandOutput, output || '', 'stdout');
      onSuccess(`Command completed: ${cmd.command}`);
    } catch (err: any) {
      emitOutput(hooks.onCommandOutput, String(err?.stdout || ''), 'stdout');
      emitOutput(hooks.onCommandOutput, String(err?.stderr || ''), 'stderr');
      onError(`Command failed: ${cmd.command}`);
    }
  }

  return true;
}

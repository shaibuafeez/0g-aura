import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';
import type { ProjectInfo, ReadTracker } from './types.js';
import { loadProjectRules } from './rules.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  '.turbo', '.vercel', '__pycache__', '.pytest_cache', 'target',
  'coverage', '.nyc_output', '.parcel-cache', '.aura',
]);

const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db', '.env', '.env.local',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
]);

const MAX_FILE_SIZE = 50 * 1024; // 50KB
const MAX_CONTEXT_CHARS = 60_000; // ~15K tokens

const AUTO_INCLUDE = [
  'package.json', 'tsconfig.json', 'README.md', 'Cargo.toml',
  'go.mod', 'pyproject.toml', 'requirements.txt',
];

function resolveWithinProject(dir: string, candidatePath: string): string | null {
  if (!candidatePath || candidatePath.includes('\0')) {
    return null;
  }

  const resolvedPath = resolve(dir, candidatePath);
  const relativePath = relative(dir, resolvedPath);
  if (relativePath === '') {
    return resolvedPath;
  }

  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return null;
  }

  return resolvedPath;
}

export function detectProjectType(dir: string): string {
  if (existsSync(join(dir, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    if (pkg.dependencies?.next || pkg.devDependencies?.next) return 'Next.js';
    if (pkg.dependencies?.react || pkg.devDependencies?.react) return 'React';
    if (pkg.dependencies?.vue || pkg.devDependencies?.vue) return 'Vue';
    if (pkg.dependencies?.express || pkg.devDependencies?.express) return 'Express';
    return 'Node.js';
  }
  if (existsSync(join(dir, 'Cargo.toml'))) return 'Rust';
  if (existsSync(join(dir, 'go.mod'))) return 'Go';
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'requirements.txt'))) return 'Python';
  if (existsSync(join(dir, 'Move.toml'))) return 'Move';
  return 'Unknown';
}

export function buildFileTree(dir: string, prefix = '', depth = 0): string {
  if (depth > 4) return '';

  let result = '';
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return '';
  }

  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry) || IGNORE_FILES.has(entry) || entry.startsWith('.')) continue;
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) dirs.push(entry);
      else files.push(entry);
    } catch {
      // skip inaccessible
    }
  }

  for (const file of files) {
    result += `${prefix}${file}\n`;
  }

  for (const d of dirs) {
    result += `${prefix}${d}/\n`;
    result += buildFileTree(join(dir, d), prefix + '  ', depth + 1);
  }

  return result;
}

export function readFileContents(dir: string, paths: string[]): Map<string, string> {
  const result = new Map<string, string>();

  for (const p of paths) {
    const fullPath = resolveWithinProject(dir, p);
    if (!fullPath) {
      continue;
    }
    try {
      const stat = statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE) {
        result.set(p, `[File too large: ${(stat.size / 1024).toFixed(1)}KB — truncated]`);
        continue;
      }
      result.set(p, readFileSync(fullPath, 'utf-8'));
    } catch {
      // skip unreadable files
    }
  }

  return result;
}

export function assembleContext(dir: string, addedFiles: string[] = []): ProjectInfo {
  const type = detectProjectType(dir);
  const tree = buildFileTree(dir);
  const rules = loadProjectRules(dir);

  // Auto-include key project files
  const autoFiles = AUTO_INCLUDE.filter((f) => existsSync(join(dir, f)));
  const allFiles = [...new Set([...autoFiles, ...addedFiles])];
  const files = readFileContents(dir, allFiles);

  return { type, tree, files, rules };
}

export function formatContext(info: ProjectInfo, filesInContext?: string[]): string {
  let ctx = `Project Type: ${info.type}\n\n`;
  ctx += `File Tree:\n${info.tree}\n`;

  if (info.files.size > 0) {
    ctx += 'Key Files:\n';
    for (const [path, content] of info.files) {
      const section = `\n--- ${path} ---\n${content}\n`;
      if (ctx.length + section.length > MAX_CONTEXT_CHARS) {
        ctx += `\n--- ${path} --- [skipped: context budget exceeded]\n`;
        continue;
      }
      ctx += section;
    }
  }

  if (filesInContext && filesInContext.length > 0) {
    ctx += `\nFILES YOU HAVE SEEN:\n${filesInContext.join('\n')}\n`;
  }

  if (info.rules) {
    ctx += `\nPROJECT RULES:\n${info.rules}\n`;
  }

  return ctx;
}

export function createReadTracker(): ReadTracker {
  const seen = new Set<string>();
  return {
    mark(path: string) { seen.add(path); },
    has(path: string) { return seen.has(path); },
    list() { return [...seen]; },
  };
}

export function estimateContextTokens(context: string): number {
  return Math.ceil(context.length / 4);
}

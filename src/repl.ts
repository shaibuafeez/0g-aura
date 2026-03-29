import type { AuraConfig, Message, ParsedResponse, ReadTracker } from './types.js';
import { zgStreamChat, checkZgComputeStatus, clearModelDiscoveryCache, getComputeDeposit, depositToCompute, withdrawFromCompute, getEstimatedCost } from './compute.js';
import { assembleContext, formatContext, estimateContextTokens, createReadTracker } from './context.js';
import { buildSystemPrompt, buildPlanSystemPrompt } from './prompt.js';
import { parseResponse } from './parser.js';
import { applyChanges, undoLastChanges } from './applier.js';
import { TerminalUI } from './ui.js';
import { AVAILABLE_MODELS } from './config.js';
import { getWalletBalance, getWalletAddress, getWalletAddressFull } from './wallet.js';
import { webSearch, formatSearchResults, formatSearchResultsStyled } from './web.js';
import { saveSession, type SessionData } from './session.js';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';

const MAX_HISTORY = 6;
const ACTIVITY_GLYPHS = ['·', '•', '◦'];
const ACTIVITY_LABEL = 'working';

type LaunchPlan =
  | { kind: 'open-file'; target: string; label: string }
  | { kind: 'command'; command: string; label: string };

function formatElapsed(ms: number): string {
  if (ms < 60_000) {
    const seconds = ms / 1000;
    return seconds >= 10 ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1)}s`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function readUsageValue(usage: Record<string, unknown> | null, key: string): number | null {
  const value = usage?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.round(text.length / 4));
}

function formatTokenLabel(usage: Record<string, unknown> | null, responseText: string): string {
  const promptTokens = readUsageValue(usage, 'prompt_tokens');
  const completionTokens = readUsageValue(usage, 'completion_tokens');
  const totalTokens = readUsageValue(usage, 'total_tokens');

  if (promptTokens !== null && completionTokens !== null && totalTokens !== null) {
    return `${formatCount(totalTokens)} tok (${formatCount(promptTokens)} in / ${formatCount(completionTokens)} out)`;
  }

  if (totalTokens !== null) {
    return `${formatCount(totalTokens)} tok`;
  }

  if (completionTokens !== null) {
    return `${formatCount(completionTokens)} out tok`;
  }

  const estimated = estimateTokens(responseText);
  return estimated > 0 ? `~${formatCount(estimated)} tok` : 'warming up';
}

function getStreamDisplay(fullText: string): string {
  // Strip code blocks — file manifest is handled separately
  let visible = fullText;
  visible = visible.replace(/<file\s+path=["'][^"']+["']>[\s\S]*?<\/file>/g, '');
  visible = visible.replace(/<file\s+path=["'][^"']+["']>[\s\S]*$/g, '');
  visible = visible.replace(/\S+?\n<<<<<<< SEARCH\n[\s\S]*?\n>>>>>>> REPLACE/g, '');
  visible = visible.replace(/\S+?\n<<<<<<< SEARCH[\s\S]*$/g, '');
  visible = visible.replace(/```(?:shell|bash|sh)\n[\s\S]*?```/g, '');
  visible = visible.replace(/```(?:shell|bash|sh)\n[\s\S]*$/g, '');
  visible = visible.replace(/<search\s+query=["'][^"']+["']\s*\/?>\s*(<\/search>)?/g, '');
  visible = visible.replace(/<plan_\w+>[\s\S]*?<\/plan_\w+>/g, '');
  visible = visible.replace(/<step_\w+>[\s\S]*?<\/step_\w+>/g, '');
  return visible.trim();
}

function buildActivityText(
  elapsedMs: number,
  usage: Record<string, unknown> | null,
  responseText: string,
  tick: number
): string {
  const glyph = ACTIVITY_GLYPHS[tick % ACTIVITY_GLYPHS.length];

  return `${ACTIVITY_LABEL} ${glyph} ${formatElapsed(elapsedMs)} ${glyph} ${formatTokenLabel(usage, responseText)}`;
}

function buildChangeSummary(
  parsed: ParsedResponse,
  generatedMs: number,
  stagedMs: number,
  usage: Record<string, unknown> | null,
  responseText: string
): string {
  const segments: string[] = [];

  const editCount = parsed.edits?.length || 0;
  if (editCount > 0) {
    segments.push(`${editCount} edit${editCount === 1 ? '' : 's'}`);
  }

  if (parsed.files.length > 0) {
    segments.push(`${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'}`);
  }

  if (parsed.commands.length > 0) {
    segments.push(`${parsed.commands.length} cmd${parsed.commands.length === 1 ? '' : 's'}`);
  }

  if (segments.length === 0) {
    return `${formatElapsed(generatedMs)} · ${formatTokenLabel(usage, responseText)}`;
  }

  return `${segments.join(' + ')} · ${formatElapsed(generatedMs)} · ${formatTokenLabel(usage, responseText)}`;
}

function getProjectRoot(files: ParsedResponse['files']): string | null {
  if (files.length === 0) {
    return null;
  }

  const firstPath = files[0]?.path?.trim();
  if (!firstPath) {
    return null;
  }

  const firstSlash = firstPath.indexOf('/');
  if (firstSlash === -1) {
    return '.';
  }

  return firstPath.slice(0, firstSlash);
}

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

function buildLaunchPlan(parsed: ParsedResponse): LaunchPlan | null {
  if (parsed.files.length === 0) {
    return null;
  }

  const normalizedPaths = parsed.files.map((file) => file.path.replace(/\\/g, '/'));
  const packageFile = parsed.files.find((file) => file.path.replace(/\\/g, '/').endsWith('package.json'));
  const root = getProjectRoot(parsed.files) || '.';

  if (packageFile) {
    try {
      const parsedPackage = JSON.parse(packageFile.content) as {
        scripts?: Record<string, string>;
      };
      const scripts = parsedPackage?.scripts || {};
      const workdir = root === '.' ? '' : `cd ${root} && `;

      if (typeof scripts.dev === 'string') {
        return {
          kind: 'command',
          command: `${workdir}npm install && npm run dev`,
          label: `next • ${workdir}npm install && npm run dev`,
        };
      }

      if (typeof scripts.start === 'string') {
        return {
          kind: 'command',
          command: `${workdir}npm install && npm start`,
          label: `next • ${workdir}npm install && npm start`,
        };
      }
    } catch {
      // Ignore malformed package.json content from the model.
    }
  }

  const htmlPath = normalizedPaths.find((filePath) => filePath.endsWith('/index.html')) ||
    normalizedPaths.find((filePath) => filePath === 'index.html');

  if (htmlPath) {
    const directory = dirname(htmlPath).replace(/\\/g, '/');
    if (directory === '.' || directory === '') {
      return {
        kind: 'open-file',
        target: 'index.html',
        label: 'open index.html in your browser',
      };
    }

    return {
      kind: 'open-file',
      target: `${directory}/index.html`,
      label: `open ${directory}/index.html in your browser`,
    };
  }

  return null;
}

function openGeneratedFile(projectDir: string, relativePath: string): void {
  if (process.platform === 'darwin') {
    execFileSync('open', [relativePath], { cwd: projectDir, stdio: 'ignore' });
    return;
  }

  if (process.platform === 'win32') {
    execFileSync('cmd', ['/c', 'start', '', relativePath], { cwd: projectDir, stdio: 'ignore' });
    return;
  }

  execFileSync('xdg-open', [relativePath], { cwd: projectDir, stdio: 'ignore' });
}

// --- Noise filter: only real errors trigger retry, not npm warnings ---
const STDERR_NOISE = [
  /npm warn/i,
  /npm notice/i,
  /ExperimentalWarning/i,
  /deprecated/i,
  /\d+ packages? in \d+/,
  /up to date/i,
  /added \d+ packages?/i,
  /baseline-browser-mapping/i,
  /please update:/i,
  /To ensure accurate/i,
];

function isStderrNoise(line: string): boolean {
  return STDERR_NOISE.some((re) => re.test(line));
}

function filterRealErrors(errors: string[]): string[] {
  return errors.filter((e) => !isStderrNoise(e));
}

// Detect real errors in stdout (tsc, eslint, build tools all write errors to stdout)
const STDOUT_ERROR_PATTERNS = [
  /error TS\d+:/i,          // TypeScript errors
  /SyntaxError:/,           // JS/TS syntax errors
  /Error:/,                 // Generic errors
  /FAILED/i,                // Build failures
  /Cannot find module/i,    // Module resolution
  /Module not found/i,      // Webpack/Next.js
  /Build error/i,           // Build tools
  /ENOENT/,                 // File not found
  /Merge conflict marker/i, // Git merge conflicts left in code
];

function hasErrorPatterns(line: string): boolean {
  return STDOUT_ERROR_PATTERNS.some((re) => re.test(line));
}

// --- Smart retry: build reflection context so the AI doesn't repeat itself ---
interface RetryState {
  count: number;
  fileAttempts: Map<string, number>; // per-file failure count
  previousErrors: string[];         // episodic memory of past failures
  errorSignatures: string[];        // hash-like signatures for loop detection
}

// Normalize error to a signature for loop detection
function errorSignature(errors: string[]): string {
  return errors
    .map((e) => e.replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().toLowerCase())
    .sort()
    .join('|');
}

// Detect if the AI is stuck producing the same error
function isStuckInLoop(retryState: RetryState, currentSig: string): boolean {
  const sigs = retryState.errorSignatures;
  if (sigs.length < 2) return false;
  // Same error 3 times in a row = stuck
  const last2 = sigs.slice(-2);
  return last2.every((s) => s === currentSig);
}

function buildReflectionMessage(
  errors: string[],
  parsed: ParsedResponse,
  retryState: RetryState,
  projectDir: string
): string {
  const lines: string[] = [];

  // Header with attempt count
  lines.push(`## Fix attempt ${retryState.count + 1}\n`);

  // Episodic memory: what you already tried
  if (retryState.previousErrors.length > 0) {
    lines.push(`### Previous attempts that FAILED:`);
    for (let i = 0; i < retryState.previousErrors.length; i++) {
      lines.push(`Attempt ${i + 1}: ${retryState.previousErrors[i]}`);
    }
    lines.push('');
    lines.push('You MUST try a DIFFERENT approach. Do NOT repeat the same edit.\n');
  }

  // Current errors
  lines.push(`### Current errors:`);
  lines.push(errors.join('\n'));
  lines.push('');

  // Inject current file content for every file the AI tried to edit
  const touchedFiles = new Set<string>();
  if (parsed.edits) {
    for (const edit of parsed.edits) touchedFiles.add(edit.path);
  }
  for (const file of parsed.files) touchedFiles.add(file.path);

  for (const filePath of touchedFiles) {
    const fullPath = resolve(projectDir, filePath);
    if (existsSync(fullPath)) {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const fileAttempts = retryState.fileAttempts.get(filePath) || 0;
        retryState.fileAttempts.set(filePath, fileAttempts + 1);

        lines.push(`### Current content of ${filePath}:`);
        // Cap at 200 lines to avoid context bloat
        const fileLines = content.split('\n');
        if (fileLines.length > 200) {
          lines.push('```');
          lines.push(fileLines.slice(0, 200).join('\n'));
          lines.push(`... (${fileLines.length - 200} more lines truncated)`);
          lines.push('```');
        } else {
          lines.push('```');
          lines.push(content);
          lines.push('```');
        }
        lines.push('');

        // Escalation: after 2 failures on same file, force full rewrite
        if (fileAttempts + 1 >= 2) {
          lines.push(`**IMPORTANT: You have failed ${fileAttempts + 1} times editing ${filePath} with SEARCH/REPLACE.**`);
          lines.push(`**STOP using SEARCH/REPLACE for this file. Rewrite the ENTIRE file using <file path="${filePath}"> tags instead.**\n`);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  // Which edits succeeded (so AI doesn't re-send them)
  if (parsed.edits && parsed.edits.length > 1) {
    const failedPaths = new Set(errors.filter((e) => e.includes('Edit failed:')).map((e) => {
      const match = e.match(/Edit failed: (\S+)/);
      return match ? match[1] : '';
    }).filter(Boolean));

    const succeeded = parsed.edits.filter((e) => !failedPaths.has(e.path));
    if (succeeded.length > 0) {
      lines.push(`### Edits that SUCCEEDED (do NOT re-send these):`);
      for (const edit of succeeded) {
        lines.push(`- ${edit.path} — applied successfully`);
      }
      lines.push('');
    }
  }

  lines.push('Fix the errors above. Read the file content provided — do NOT use cat or shell commands to read files.');

  return lines.join('\n');
}

function detectComplexity(input: string): boolean {
  let score = 0;

  const lower = input.toLowerCase();

  const actionKeywords = /\b(refactor|migrate|implement|build|rewrite|integrate)\b/;
  if (actionKeywords.test(lower)) score += 2;

  const scopeWords = /\b(entire|all|whole|across|every|full)\b/;
  if (scopeWords.test(lower)) score += 2;

  const andCount = (lower.match(/\band\b/g) || []).length;
  if (andCount >= 2) score += 2;

  const actionVerbs = /\b(add|create|update|remove|fix|change|delete|rename|move|replace|convert|extract|split|merge|combine)\b/g;
  const verbMatches = lower.match(actionVerbs) || [];
  if (verbMatches.length >= 3) score += 2;

  const hasFilePaths = /[\/\\][\w.-]+\.\w+/.test(input);
  if (input.length > 150 && !hasFilePaths) score += 1;

  const sentenceCount = input.split(/[.!?]+/).filter((s) => s.trim().length > 10).length;
  if (sentenceCount >= 3) score += 1;

  return score >= 3;
}

export async function startRepl(config: AuraConfig, version: string, resumeData?: SessionData): Promise<void> {
  const history: Message[] = resumeData ? [...resumeData.history] : [];
  const addedFiles: string[] = resumeData ? [...resumeData.addedFiles] : [];
  const readTracker = createReadTracker();
  if (resumeData) {
    for (const p of resumeData.readTrackerPaths) readTracker.mark(p);
  }
  let currentModel = resumeData ? resumeData.model : config.model;
  let mode: 'code' | 'plan' = 'code';
  let currentPlan: string | null = null;
  const retryState: RetryState = { count: 0, fileAttempts: new Map(), previousErrors: [], errorSignatures: [] };
  let bootstrapping = true;
  let processing = false;
  const queue: string[] = [];
  let resolveRepl: (() => void) | null = null;
  let sessionTokensIn = resumeData ? resumeData.stats.tokensIn : 0;
  let sessionTokensOut = resumeData ? resumeData.stats.tokensOut : 0;
  let sessionRequests = resumeData ? resumeData.stats.requests : 0;
  const balanceCache = { wallet: null as number | null, deposit: null as number | null };

  function doSaveSession(): void {
    if (history.length === 0) return;
    try {
      saveSession({
        model: currentModel,
        projectDir: config.projectDir,
        history,
        addedFiles,
        readTrackerPaths: readTracker.list(),
        stats: { tokensIn: sessionTokensIn, tokensOut: sessionTokensOut, requests: sessionRequests },
      });
    } catch {
      // Best-effort — don't crash on exit
    }
  }

  const ui = new TerminalUI({
    model: currentModel,
    projectDir: config.projectDir,
    version,
  });

  if (config.configSource) {
    ui.setConfigSource(config.configSource);
  }

  // Register sub-menus for slash commands
  ui.registerSubMenu('/model', () =>
    AVAILABLE_MODELS.map((m) => ({
      label: m,
      value: m,
      hint: m === currentModel ? 'current' : undefined,
    }))
  );

  ui.registerSubMenu('/deposit', () => {
    const walBal = balanceCache.wallet;
    const presets = [
      { label: '0.05 A0GI', value: '0.05', amount: 0.05, hint: 'small test' },
      { label: '0.1 A0GI', value: '0.1', amount: 0.1 },
      { label: '0.5 A0GI', value: '0.5', amount: 0.5 },
      { label: '1 A0GI', value: '1', amount: 1 },
      { label: '5 A0GI', value: '5', amount: 5 },
    ];
    const items = (walBal !== null
      ? presets.filter((p) => p.amount <= walBal)
      : presets
    ).map((p) => ({
      label: p.label,
      value: p.value,
      hint: walBal !== null ? `wallet has ${walBal.toFixed(2)}` : p.hint,
    }));
    if (items.length === 0) {
      return [{ label: 'Wallet empty', value: '', hint: 'get A0GI at portal.0g.ai' }];
    }
    return items;
  });

  ui.registerSubMenu('/remove', () => {
    if (addedFiles.length === 0) {
      return [{ label: '(no files in context)', value: '', hint: 'empty' }];
    }
    return [
      { label: 'all', value: 'all', hint: `${addedFiles.length} file(s)` },
      ...addedFiles.map((f) => ({ label: f, value: f })),
    ];
  });

  async function processLine(line: string): Promise<void> {
    const input = line.trim();
    if (!input) {
      return;
    }

    if (input.startsWith('/')) {
      // Handle /plan and /build inline before other commands
      const cmdLower = input.split(/\s+/)[0].toLowerCase();

      if (cmdLower === '/plan') {
        if (mode === 'plan') {
          mode = 'code';
          currentPlan = null;
          ui.setMode('code');
          ui.log('info', 'Plan mode off');
        } else {
          mode = 'plan';
          ui.setMode('plan');
          ui.log('info', 'Plan mode on — describe your task and Aura will create a plan');
        }
        return;
      }

      if (cmdLower === '/build') {
        if (!currentPlan) {
          ui.log('error', 'No plan to execute. Use /plan first, then describe your task.');
          return;
        }
        mode = 'code';
        ui.setMode('code');
        ui.log('info', 'Executing plan...');
        queue.unshift('__build_plan__');
        return;
      }

      const shouldExit = await handleCommand(
        input,
        config,
        currentModel,
        addedFiles,
        history,
        ui,
        (nextModel) => {
          currentModel = nextModel;
          ui.setModel(nextModel);
        },
        { tokensIn: sessionTokensIn, tokensOut: sessionTokensOut, requests: sessionRequests },
        balanceCache
      );

      if (shouldExit) {
        doSaveSession();
        ui.stop();
        resolveRepl?.();
      }
      return;
    }

    const isFollowup = input === '__search_followup__' || input === '__error_retry__' || input === '__build_plan__';

    // Handle /build execution: inject a synthetic message to trigger code generation from the plan
    if (input === '__build_plan__' && currentPlan) {
      history.push({ role: 'user', content: 'Execute the plan above. Generate all code changes now.' });
      ui.log('user', 'Execute the plan above. Generate all code changes now.');
    } else if (!isFollowup) {
      // Auto-trigger: detect complex requests and switch to plan mode
      if (mode === 'code' && detectComplexity(input)) {
        mode = 'plan';
        ui.setMode('plan');
        ui.log('info', 'Complex task detected — planning first...');
      }

      history.push({ role: 'user', content: input });
      ui.log('user', input);
    }
    ui.setBusy(true, 'Working');

    try {
      let projectInfo = assembleContext(config.projectDir, addedFiles);
      // Mark files in context as "read" so the model knows it can edit them
      for (const path of projectInfo.files.keys()) {
        readTracker.mark(path);
      }
      for (const path of addedFiles) {
        readTracker.mark(path);
      }
      let filesInContext = readTracker.list();
      let projectContext = formatContext(projectInfo, filesInContext);
      // Auto-trim context: drop oldest added files until under budget
      const TOKEN_BUDGET = 16_000;
      let contextTokens = estimateContextTokens(projectContext);
      while (contextTokens > TOKEN_BUDGET && addedFiles.length > 0) {
        const dropped = addedFiles.shift()!;
        projectInfo = assembleContext(config.projectDir, addedFiles);
        filesInContext = readTracker.list();
        projectContext = formatContext(projectInfo, filesInContext);
        contextTokens = estimateContextTokens(projectContext);
        ui.log('info', `Auto-removed ${dropped} from context to stay fast`);
      }
      const basePrompt = buildSystemPrompt(projectContext, filesInContext, projectInfo.rules);
      let systemPrompt: string;
      if (input === '__build_plan__' && currentPlan) {
        systemPrompt = buildPlanSystemPrompt(basePrompt, currentPlan);
        currentPlan = null;
      } else if (mode === 'plan') {
        systemPrompt = buildPlanSystemPrompt(basePrompt);
      } else {
        systemPrompt = basePrompt;
      }
      const recentHistory = history.slice(-MAX_HISTORY);

      // Pre-inference deposit safety check
      if (balanceCache.deposit !== null && balanceCache.deposit <= 0) {
        ui.log('error', 'No compute deposit. Run /deposit first.');
        return;
      }
      if (balanceCache.deposit !== null && balanceCache.deposit < 0.01) {
        ui.log('warning', `Low deposit (${balanceCache.deposit.toFixed(4)} A0GI). Consider /deposit.`);
      }

      const { chunks, settle, notices, getUsage } = await zgStreamChat(
        config,
        recentHistory,
        systemPrompt,
        currentModel
      );
      const seenNotices = new Set<string>();
      const flushNotices = () => {
        for (const notice of notices) {
          const normalized = notice.trim();
          if (!normalized || seenNotices.has(normalized)) {
            continue;
          }

          seenNotices.add(normalized);
          ui.log('warning', normalized);
        }
      };

      flushNotices();
      const startedAt = Date.now();
      let streamFinishedAt = startedAt;
      let activityTick = 0;
      let fullResponse = '';

      // Stream response — file manifest appears above the response text
      const isPlanning = mode === 'plan' && input !== '__build_plan__';
      const manifestEntryId = isPlanning ? null : ui.createEntry('diff');
      const streamEntryId = isPlanning ? null : ui.createEntry('assistant');
      const renderActivity = () => {
        if (isPlanning) {
          ui.setActivity(`planning ${ACTIVITY_GLYPHS[activityTick % ACTIVITY_GLYPHS.length]} ${formatElapsed(Date.now() - startedAt)}`, '');
        } else {
          ui.setActivity(buildActivityText(Date.now() - startedAt, getUsage(), fullResponse, activityTick), '');
        }
        activityTick += 1;
      };
      renderActivity();
      const activityTimer: ReturnType<typeof setInterval> = setInterval(() => {
        renderActivity();
        flushNotices();
      }, 160);

      let lastFileCount = 0;

      try {
        for await (const chunk of chunks) {
          fullResponse += chunk;
          if (!isPlanning && streamEntryId !== null) {
            const display = getStreamDisplay(fullResponse);
            ui.updateEntry(streamEntryId, display || 'thinking...');

            // Update file manifest above the stream as new files are detected
            if (manifestEntryId !== null) {
              const filePaths: string[] = [];
              for (const m of fullResponse.matchAll(/<file\s+path=["']([^"']+)["']/g)) filePaths.push(m[1]);
              for (const m of fullResponse.matchAll(/(\S+?)\n<<<<<<< SEARCH/g)) filePaths.push(m[1]);
              const uniqueFiles = [...new Set(filePaths)];
              if (uniqueFiles.length !== lastFileCount) {
                lastFileCount = uniqueFiles.length;
                if (uniqueFiles.length > 0) {
                  const manifest = uniqueFiles.map((p) => `◆ ${p}`).join('\n');
                  ui.updateEntry(manifestEntryId, manifest);
                }
              }
            }
          }
          renderActivity();
        }
        streamFinishedAt = Date.now();
        await settle().catch(() => {});
        flushNotices();
      } finally {
        clearInterval(activityTimer);
        ui.setActivity(null);
      }

      // Remove manifest entry — diffs will show their own file headers
      if (manifestEntryId !== null) {
        if (lastFileCount === 0) {
          ui.removeEntry(manifestEntryId);
        }
      }

      history.push({ role: 'assistant', content: fullResponse });

      const parsed = parseResponse(fullResponse);
      const usage = getUsage();

      // Track session usage
      const pIn = readUsageValue(usage, 'prompt_tokens');
      const pOut = readUsageValue(usage, 'completion_tokens');
      if (pIn !== null) sessionTokensIn += pIn;
      if (pOut !== null) sessionTokensOut += pOut;
      sessionRequests += 1;

      // Handle model-triggered web searches — fetch results, then auto-call model again
      if (parsed.searches.length > 0) {
        const allResults: string[] = [];
        for (const query of parsed.searches) {
          ui.log('info', `Searching: ${query}`);
          try {
            const results = await webSearch(query);
            ui.log('diff', formatSearchResultsStyled(query, results));
            allResults.push(formatSearchResults(query, results));
          } catch (err) {
            ui.log('error', `Search failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (allResults.length > 0) {
          // Feed results back and auto-trigger a follow-up so the model can answer
          const searchContext = `Here are the search results:\n\n${allResults.join('\n\n')}\n\nNow use these results to answer the original question. Do NOT search again.`;
          history.push({ role: 'user', content: searchContext });
          ui.log('info', 'Fetched results — generating answer...');
          // Remove the stream/manifest entries for the search-only response
          if (manifestEntryId !== null) ui.removeEntry(manifestEntryId);
          if (streamEntryId !== null) ui.removeEntry(streamEntryId);
          // Re-process: the model will now see the search results and give a proper answer
          queue.unshift('__search_followup__');
        }
        return;
      }

      // Plan mode: store plan, render as visual card, then auto-execute
      if (isPlanning) {
        currentPlan = fullResponse;
        ui.log('plan', fullResponse);
        // Auto-execute: queue the build immediately
        mode = 'code';
        ui.setMode('code');
        queue.unshift('__build_plan__');
        return;
      }

      // After /build executes, reset mode back to code
      if (input === '__build_plan__') {
        mode = 'code';
        ui.setMode('code');
      }

      const stagedAt = Date.now();
      const generatedMs = streamFinishedAt - startedAt;
      const stagedMs = stagedAt - streamFinishedAt;
      const hasEdits = parsed.edits && parsed.edits.length > 0;
      if (parsed.files.length > 0 || hasEdits || parsed.commands.length > 0) {
        // Replace stream entry with just the explanation
        if (streamEntryId !== null) {
          if (parsed.explanation.trim()) {
            ui.updateEntry(streamEntryId, parsed.explanation.trim());
          } else {
            ui.removeEntry(streamEntryId);
          }
        }
        ui.log('success', buildChangeSummary(parsed, generatedMs, stagedMs, usage, fullResponse));
        const applyErrors: string[] = [];
        const commandOutputLines: string[] = [];
        const applied = await applyChanges(parsed, config.projectDir, config.noConfirm, {
          confirm: (question) => ui.confirm(question),
          onInfo: (message) => ui.log('info', message),
          onError: (message) => { ui.log('error', message); applyErrors.push(message); },
          onSuccess: (message) => ui.log('success', message),
          onDiffPreview: (_path, lines) => ui.log('diff', lines.join('\n')),
          onEditApplied: (path, layer) => ui.log('success', `Edit applied: ${path} (layer ${layer})`),
          onEditFailed: (path, reason) => { ui.log('error', `Edit failed: ${path} — ${reason}`); applyErrors.push(`Edit failed: ${path} — ${reason}`); },
          onCommand: (command) => ui.log('command', `$ ${command}`),
          onCommandOutput: (output, stream) => {
            const isNoise = stream === 'stderr' && isStderrNoise(output);
            ui.log(isNoise ? 'info' : (stream === 'stderr' ? 'error' : 'command'), output);
            // Capture ALL command output so we can feed errors back to the AI
            if (output.trim()) commandOutputLines.push(output.trim());
            if (stream === 'stderr' && output.trim() && !isNoise) applyErrors.push(output.trim());
            // Also detect errors in stdout (tsc, eslint output errors to stdout)
            if (stream === 'stdout' && output.trim() && hasErrorPatterns(output)) applyErrors.push(output.trim());
          },
        });

        // Smart error recovery with reflection and loop detection
        const realErrors = filterRealErrors(applyErrors);
        if (realErrors.length > 0 && applied) {
          const sig = errorSignature(realErrors);

          // Only stop if stuck in a loop (same error 3+ times in a row)
          if (isStuckInLoop(retryState, sig)) {
            ui.log('error', `Same error repeated ${retryState.errorSignatures.filter((s) => s === sig).length + 1} times. The AI is stuck.`);
            ui.log('info', 'Try rephrasing your request, or /undo to revert.');
            retryState.count = 0;
            retryState.fileAttempts.clear();
            retryState.previousErrors.length = 0;
            retryState.errorSignatures.length = 0;
            return;
          }

          retryState.errorSignatures.push(sig);

          // Build rich reflection context with file contents + episodic memory
          const reflectionMsg = buildReflectionMessage(realErrors, parsed, retryState, config.projectDir);
          retryState.previousErrors.push(realErrors.slice(0, 3).join('; '));
          retryState.count += 1;

          ui.log('info', `Errors detected — retrying (attempt ${retryState.count})...`);
          history.push({ role: 'user', content: reflectionMsg });
          queue.unshift('__error_retry__');
          return;
        }

        // Reset retry state on success
        if (realErrors.length === 0) {
          retryState.count = 0;
          retryState.fileAttempts.clear();
          retryState.previousErrors.length = 0;
          retryState.errorSignatures.length = 0;
        }

        // Command output feedback: feed output back to the AI so it can act on results
        if (commandOutputLines.length > 0 && parsed.commands.length > 0) {
          const hasEditsOrFiles = hasEdits || parsed.files.length > 0;
          const errorLines = commandOutputLines.filter(hasErrorPatterns);
          const shouldFeedback = hasEditsOrFiles
            ? errorLines.length > 0                   // with edits: only feed back errors
            : commandOutputLines.length > 0;          // pure commands (cat, tsc, ls): always feed back

          if (shouldFeedback) {
            // Cap output to avoid context bloat
            const outputToSend = commandOutputLines.slice(0, 50).join('\n');
            const truncated = commandOutputLines.length > 50 ? `\n... (${commandOutputLines.length - 50} more lines)` : '';
            const hasErrors = errorLines.length > 0;
            const feedbackMsg = hasErrors
              ? `The command output contains errors:\n\n${outputToSend}${truncated}\n\nFix these errors.`
              : `Command output:\n\n${outputToSend}${truncated}\n\nUse this output to continue. If there are issues to fix, fix them. If this was a diagnostic, use the information to proceed with the task.`;
            ui.log('info', hasErrors ? 'Command output has errors — generating fix...' : 'Feeding command output back to AI...');
            history.push({ role: 'user', content: feedbackMsg });
            queue.unshift('__error_retry__');
            return;
          }
        }

        const launchPlan = applied ? buildLaunchPlan(parsed) : null;
        if (launchPlan?.kind === 'open-file') {
          const shouldOpen = await ui.promptLaunch(`Open ${launchPlan.target} in browser?`);
          if (shouldOpen) {
            try {
              openGeneratedFile(config.projectDir, launchPlan.target);
              ui.log('success', `Opened ${launchPlan.target}`);
            } catch (err) {
              ui.log('error', `Failed to open ${launchPlan.target}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } else if (launchPlan?.kind === 'command') {
          ui.log('success', 'Build complete! To launch your app:');
          ui.log('info', `  ${launchPlan.command}`);
        }
      } else {
        const visibleResponse = parsed.explanation || fullResponse.trim();
        if (streamEntryId !== null) {
          ui.updateEntry(streamEntryId, visibleResponse || '(No textual response returned.)');
        }
        ui.log('system', buildChangeSummary(parsed, generatedMs, stagedMs, usage, fullResponse));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      // Provide actionable guidance for common errors
      if (message.includes('Broker init failed') || message.includes('ECONNREFUSED')) {
        ui.log('error', `Connection failed. Check your RPC endpoint or network.`);
      } else if (lower.includes('insufficient') || lower.includes('deposit too low')) {
        ui.log('error', `Deposit too low. Run /deposit to add funds.`);
      } else if (lower.includes('balance')) {
        ui.log('error', `Insufficient balance. Run /balance to check your A0GI funds.`);
      } else if (lower.includes('acknowledge')) {
        ui.log('error', `First-time provider setup failed — need A0GI for gas. Check /balance.`);
      } else if (message.includes('unavailable')) {
        ui.log('error', `${message}. Try /model to switch models or /status to check connectivity.`);
      } else {
        ui.log('error', message);
      }
      ui.setStatus('Request failed');
    } finally {
      ui.setBusy(false, 'Ready');
    }
  }

  async function drainQueue(): Promise<void> {
    if (processing || bootstrapping) {
      return;
    }

    processing = true;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) {
        continue;
      }
      await processLine(next);
    }
    processing = false;
  }

  async function warmupCompute(): Promise<void> {
    let nextStatus = 'Ready';

    ui.setBusy(true, 'Connecting');

    try {
      const [status, balance] = await Promise.all([
        checkZgComputeStatus({ ...config, model: currentModel }),
        getWalletBalance(config.rpcUrl, config.privateKey).catch(() => null),
      ]);

      if (balance !== null) {
        ui.setBalance(balance);
        const parsed = parseFloat(balance);
        balanceCache.wallet = isNaN(parsed) ? null : parsed;
      }

      // Fetch compute deposit after broker is initialized by checkZgComputeStatus
      const deposit = await getComputeDeposit(config).catch(() => null);
      if (deposit) {
        ui.setDeposit(deposit.available, deposit.total);
        const parsed = parseFloat(deposit.available);
        balanceCache.deposit = isNaN(parsed) ? null : parsed;
      }

      // Guide first-time users: no deposit
      if (deposit) {
        const avail = parseFloat(deposit.available);
        if (avail === 0 || isNaN(avail)) {
          const walletNum = parseFloat(balance || '0');
          if (walletNum > 0) {
            ui.log('warning', 'No compute deposit. Run /deposit to fund inference from your wallet.');
          } else {
            ui.log('warning', 'Wallet is empty. Get A0GI at https://portal.0g.ai then /deposit to start.');
          }
        }
      }

      if (!status.available) {
        nextStatus = 'Offline';
        if (status.error) {
          const errMsg = String(status.error).toLowerCase();
          if (errMsg.includes('no chatbot providers')) {
            ui.log('warning', `No providers for ${currentModel}. Try /model to switch.`);
          } else {
            ui.log('warning', `0G Compute unavailable. Try /status for details.`);
          }
        }
      }
    } catch {
      nextStatus = 'Offline';
      ui.log('warning', '0G Compute unreachable. Check your connection and /status.');
    } finally {
      bootstrapping = false;
      ui.setBusy(false, nextStatus);
      drainQueue().catch((err) => {
        ui.log('error', err instanceof Error ? err.message : String(err));
        processing = false;
      });
    }
  }

  return new Promise<void>((resolve) => {
    resolveRepl = resolve;

    ui.setSubmitHandler((value) => {
      queue.push(value);
      drainQueue().catch((err) => {
        ui.log('error', err instanceof Error ? err.message : String(err));
        processing = false;
      });
    });

    ui.setExitHandler(() => {
      doSaveSession();
      ui.stop();
      resolveRepl?.();
    });

    ui.start();

    // Check for project rules
    {
      const info = assembleContext(config.projectDir);
      if (info.rules) {
        ui.log('info', 'Loaded .aura/rules');
      }
    }

    // Show resumed session info
    if (resumeData) {
      const ago = formatElapsed(Date.now() - new Date(resumeData.timestamp).getTime());
      const msgCount = resumeData.history.filter((m) => m.role === 'user').length;
      ui.log('success', `Resumed session from ${ago} ago (${msgCount} message${msgCount === 1 ? '' : 's'}, ${resumeData.model})`);
      // Replay conversation history into the UI
      for (const msg of resumeData.history) {
        if (msg.role === 'user') ui.log('user', msg.content);
        else if (msg.role === 'assistant') ui.log('assistant', msg.content.slice(0, 200) + (msg.content.length > 200 ? '...' : ''));
      }
      ui.setModel(currentModel);
    }

    warmupCompute().catch((err) => {
      ui.log('error', err instanceof Error ? err.message : String(err));
      bootstrapping = false;
      ui.setBusy(false, 'Offline');
    });
  });
}

async function handleCommand(
  input: string,
  config: AuraConfig,
  currentModel: string,
  addedFiles: string[],
  history: Message[],
  ui: TerminalUI,
  setModel: (model: string) => void,
  sessionStats: { tokensIn: number; tokensOut: number; requests: number },
  balanceCache: { wallet: number | null; deposit: number | null }
): Promise<boolean> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/help':
      ui.log('info', [
        'Commands:',
        '  /model <name>      Switch AI model',
        '  /address           Show full wallet address',
        '  /deposit <amount>  Deposit A0GI into compute',
        '  /withdraw <amount> Withdraw A0GI from compute',
        '  /export-key        Export private key',
        '',
        '  /plan              Toggle plan mode (analyze before coding)',
        '  /build             Execute the current plan as code',
        '',
        '  /help              Show this help',
        '  /balance           Check wallet + deposit balance',
        '  /status            Check 0G Compute connection',
        '  /add <path>        Add file to context',
        '  /remove <path|all> Remove file from context',
        '  /files             Show project tree',
        '  /web <query>       Search the web',
        '  /undo              Revert last applied changes',
        '  /export [file]     Save conversation to markdown',
        '  /cost              Show session token usage',
        '  /clear             Clear conversation',
        '  /quit              Exit',
        '',
        'Keyboard:',
        '  Up/Down            Scroll output',
        '  PageUp/PageDown    Scroll fast',
        '  Ctrl+P/Ctrl+N      Recall previous prompts',
        '',
        'Project rules:',
        '  Create .aura/rules in your project for custom instructions',
        '',
        `Models: ${AVAILABLE_MODELS.join(', ')}`,
        '',
        'How aura billing works:',
        '  Your wallet holds A0GI tokens (get them at portal.0g.ai)',
        '  /deposit moves A0GI from wallet → compute deposit',
        '  Each AI request costs ~0.005 A0GI from your deposit',
        '  /withdraw moves unused deposit back to your wallet',
      ].join('\n'));
      return false;

    case '/add':
      if (!arg) {
        ui.log('error', 'Usage: /add <file-path>');
        return false;
      }
      {
        const fullPath = resolveWithinProject(config.projectDir, arg);
        if (!fullPath) {
          ui.log('error', `Path must stay within the project directory: ${arg}`);
          return false;
        }
        if (!existsSync(fullPath)) {
          ui.log('error', `File not found: ${arg}`);
          return false;
        }
        if (addedFiles.includes(arg)) {
          ui.log('info', `${arg} is already in context`);
          return false;
        }
        addedFiles.push(arg);
        ui.log('success', `Added ${arg} to context`);
      }
      return false;

    case '/remove':
      if (!arg) {
        ui.log('error', 'Usage: /remove <file-path> or /remove all');
        return false;
      }
      if (arg === 'all') {
        const count = addedFiles.length;
        addedFiles.length = 0;
        ui.log('success', count > 0 ? `Removed ${count} file(s) from context` : 'Context already empty');
        return false;
      }
      {
        const idx = addedFiles.indexOf(arg);
        if (idx === -1) {
          ui.log('error', `${arg} is not in context. Files: ${addedFiles.join(', ') || '(none)'}`);
          return false;
        }
        addedFiles.splice(idx, 1);
        ui.log('success', `Removed ${arg} from context`);
      }
      return false;

    case '/model':
      if (!arg) {
        ui.log('info', `Current model: ${currentModel}`);
        ui.log('info', `Available: ${AVAILABLE_MODELS.join(', ')}`);
        return false;
      }

      {
        const match = AVAILABLE_MODELS.find((model) => model.toLowerCase() === arg.toLowerCase());
        if (!match) {
          ui.log('error', `Unknown model: ${arg}`);
          ui.log('info', `Available: ${AVAILABLE_MODELS.join(', ')}`);
          return false;
        }

        clearModelDiscoveryCache();
        setModel(match);
        ui.log('success', `Model switched to ${match}`);
      }
      return false;

    case '/clear':
      history.length = 0;
      ui.clearConversation();
      ui.log('success', 'Conversation history cleared');
      return false;

    case '/files': {
      const projectInfo = assembleContext(config.projectDir, addedFiles);
      const sections = [`Project: ${projectInfo.type}`, projectInfo.tree.trim()];
      if (addedFiles.length > 0) {
        sections.push(`Added files: ${addedFiles.join(', ')}`);
      }
      ui.log('info', sections.filter(Boolean).join('\n\n'));
      return false;
    }

    case '/status': {
      ui.setBusy(true, 'Checking 0G Compute...');
      try {
        const status = await checkZgComputeStatus({ ...config, model: currentModel });
        if (status.available) {
          ui.log('success', [
            '0G Compute connected',
            `Model: ${status.model}`,
            `Endpoint: ${status.endpoint}`,
            `Provider: ${status.providerAddress}`,
            ...(status.discovered ? ['Provider was auto-discovered.'] : []),
          ].join('\n'));
        } else {
          ui.log('error', `0G Compute unavailable: ${status.error}`);
        }
      } finally {
        ui.setBusy(false, 'Ready');
      }
      return false;
    }

    case '/balance': {
      ui.setBusy(true, 'Checking balance');
      try {
        const [balance, deposit] = await Promise.all([
          getWalletBalance(config.rpcUrl, config.privateKey),
          getComputeDeposit(config).catch(() => null),
        ]);
        const address = getWalletAddress(config.privateKey);
        const short = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '???';
        ui.setBalance(balance);
        const lines = [`${short}  ${balance} A0GI (wallet)`];
        if (deposit) {
          ui.setDeposit(deposit.available, deposit.total);
          lines.push(`Compute: ${deposit.available} A0GI available / ${deposit.locked} A0GI locked / ${deposit.total} A0GI total`);
        }
        ui.log('info', lines.join('\n'));
      } catch (err) {
        ui.log('error', `Balance check failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        ui.setBusy(false, 'Ready');
      }
      return false;
    }

    case '/deposit': {
      if (!arg) {
        ui.log('error', 'Usage: /deposit <amount>  (e.g. /deposit 0.5)');
        return false;
      }
      const amount = parseFloat(arg);
      if (isNaN(amount) || amount <= 0) {
        ui.log('error', `Invalid amount: ${arg}`);
        return false;
      }
      ui.setBusy(true, `Depositing ${amount} A0GI`);
      try {
        // Check wallet balance first
        const walletBal = await getWalletBalance(config.rpcUrl, config.privateKey);
        const walletNum = parseFloat(walletBal);
        if (walletNum < amount) {
          ui.log('error', `Wallet only has ${walletBal} A0GI. Need ${amount} A0GI + gas.`);
          ui.log('info', 'Get A0GI at https://portal.0g.ai');
          return false;
        }

        const txHash = await depositToCompute(config, amount);
        ui.log('success', `Deposited ${amount} A0GI into compute`);
        if (txHash) {
          ui.log('info', `Tx: https://chainscan.0g.ai/tx/${txHash}`);
        }

        // Refresh balances
        const [newBal, deposit] = await Promise.all([
          getWalletBalance(config.rpcUrl, config.privateKey).catch(() => null),
          getComputeDeposit(config).catch(() => null),
        ]);
        if (newBal) {
          ui.setBalance(newBal);
          const parsed = parseFloat(newBal);
          balanceCache.wallet = isNaN(parsed) ? null : parsed;
        }
        if (deposit) {
          ui.setDeposit(deposit.available, deposit.total);
          const parsed = parseFloat(deposit.available);
          balanceCache.deposit = isNaN(parsed) ? null : parsed;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.log('error', `Deposit failed: ${msg}`);
      } finally {
        ui.setBusy(false, 'Ready');
      }
      return false;
    }

    case '/withdraw': {
      if (!arg) {
        ui.log('error', 'Usage: /withdraw <amount>  (e.g. /withdraw 0.3)');
        return false;
      }
      const amount = parseFloat(arg);
      if (isNaN(amount) || amount <= 0) {
        ui.log('error', `Invalid amount: ${arg}`);
        return false;
      }
      ui.setBusy(true, `Withdrawing ${amount} A0GI`);
      try {
        const depositBefore = await getComputeDeposit(config).catch(() => null);
        const txHash = await withdrawFromCompute(config, amount);
        ui.log('success', `Withdrew ${amount} A0GI from compute deposit`);
        if (txHash) {
          ui.log('info', `Tx: https://chainscan.0g.ai/tx/${txHash}`);
        }

        // Refresh balances
        const [newBal, depositAfter] = await Promise.all([
          getWalletBalance(config.rpcUrl, config.privateKey).catch(() => null),
          getComputeDeposit(config).catch(() => null),
        ]);
        if (newBal) {
          ui.setBalance(newBal);
          const parsed = parseFloat(newBal);
          balanceCache.wallet = isNaN(parsed) ? null : parsed;
        }
        if (depositAfter) {
          ui.setDeposit(depositAfter.available, depositAfter.total);
          const parsed = parseFloat(depositAfter.available);
          balanceCache.deposit = isNaN(parsed) ? null : parsed;
        }
        const beforeStr = depositBefore ? depositBefore.available : '?';
        const afterStr = depositAfter ? depositAfter.available : '?';
        ui.log('info', `Deposit: ${beforeStr} → ${afterStr} A0GI`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ui.log('error', `Withdraw failed: ${msg}`);
      } finally {
        ui.setBusy(false, 'Ready');
      }
      return false;
    }

    case '/address': {
      const fullAddress = getWalletAddressFull(config.privateKey);
      if (fullAddress) {
        ui.log('info', `Wallet address:\n  ${fullAddress}`);
      } else {
        ui.log('error', 'Could not derive wallet address from private key.');
      }
      return false;
    }

    case '/export-key': {
      ui.log('info', `Private key:\n  ${config.privateKey}`);
      return false;
    }

    case '/undo': {
      const result = undoLastChanges(config.projectDir);
      if (!result) {
        ui.log('info', 'Nothing to undo.');
        return false;
      }
      for (const path of result.restored) {
        ui.log('success', `Restored ${path}`);
      }
      for (const path of result.removed) {
        ui.log('success', `Removed ${path}`);
      }
      ui.log('success', `Undid ${result.restored.length + result.removed.length} file change(s)`);
      return false;
    }

    case '/export': {
      if (history.length === 0) {
        ui.log('info', 'No conversation to export.');
        return false;
      }
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = arg || `aura-${ts}.md`;
      let md = `# Aura Conversation\n\n`;
      md += `- **Model**: ${currentModel}\n`;
      md += `- **Date**: ${new Date().toISOString()}\n`;
      md += `- **Project**: ${config.projectDir}\n\n---\n\n`;
      for (const msg of history) {
        const label = msg.role === 'user' ? 'You' : 'Aura';
        md += `### ${label}\n\n${msg.content}\n\n---\n\n`;
      }
      try {
        writeFileSync(join(config.projectDir, filename), md, 'utf-8');
        ui.log('success', `Exported to ${filename}`);
      } catch (err) {
        ui.log('error', `Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return false;
    }

    case '/cost': {
      if (sessionStats.requests === 0) {
        ui.log('info', 'No requests made yet.');
        return false;
      }
      ui.log('info', [
        'Session usage:',
        `  Requests:   ${sessionStats.requests}`,
        `  Tokens in:  ${sessionStats.tokensIn.toLocaleString()}`,
        `  Tokens out: ${sessionStats.tokensOut.toLocaleString()}`,
        `  Total:      ${(sessionStats.tokensIn + sessionStats.tokensOut).toLocaleString()}`,
      ].join('\n'));
      return false;
    }

    case '/web': {
      if (!arg) {
        ui.log('error', 'Usage: /web <search query>');
        return false;
      }
      ui.setBusy(true, 'Searching');
      try {
        const results = await webSearch(arg);
        ui.log('diff', formatSearchResultsStyled(arg, results));
        const plain = formatSearchResults(arg, results);
        // Add plain-text results to conversation context so model can use them
        history.push({ role: 'user', content: `[Web search for: ${arg}]\n${plain}` });
      } catch (err) {
        ui.log('error', `Search failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        ui.setBusy(false, 'Ready');
      }
      return false;
    }

    case '/quit':
    case '/exit':
      return true;

    default:
      ui.log('error', `Unknown command: ${cmd}. Type /help for commands.`);
      return false;
  }
}

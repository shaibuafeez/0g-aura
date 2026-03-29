import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import chalk from 'chalk';

const CACHE_FILE = resolve(homedir(), '.aura', '.update-check');
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT = 3000; // 3 seconds

interface UpdateResult {
  updateAvailable: boolean;
  current: string;
  latest: string;
}

interface CacheData {
  timestamp: number;
  latest: string;
}

/** Compare two semver strings (X.Y.Z). Returns -1, 0, or 1. */
function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function readCache(): CacheData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, 'utf-8');
    const data = JSON.parse(raw) as CacheData;
    if (Date.now() - data.timestamp < CACHE_TTL) return data;
    return null; // expired
  } catch {
    return null;
  }
}

function writeCache(latest: string): void {
  try {
    mkdirSync(resolve(homedir(), '.aura'), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), latest }));
  } catch {
    // ignore
  }
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateResult | null> {
  try {
    // Check cache first
    const cached = readCache();
    if (cached) {
      return {
        updateAvailable: semverCompare(currentVersion, cached.latest) < 0,
        current: currentVersion,
        latest: cached.latest,
      };
    }

    // Fetch from npm registry with timeout
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const res = await fetch('https://registry.npmjs.org/0g-aura/latest', {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return null;

    writeCache(latest);

    return {
      updateAvailable: semverCompare(currentVersion, latest) < 0,
      current: currentVersion,
      latest,
    };
  } catch {
    return null; // offline, timeout, etc.
  }
}

export function promptUpdate(result: UpdateResult): Promise<boolean> {
  return new Promise((resolve) => {
    console.log('');
    console.log(
      `  ${chalk.hex('#c9a8e8')('●')} Update available  ${chalk.dim(result.current)} ${chalk.dim('→')} ${chalk.whiteBright.bold(result.latest)}`
    );
    console.log('');
    console.log(`  ${chalk.dim('[')}${chalk.whiteBright('U')}${chalk.dim(']')} Update now    ${chalk.dim('[')}${chalk.whiteBright('S')}${chalk.dim(']')} Skip`);
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    // Enable raw mode for single keypress
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onKey = (key: Buffer) => {
        const ch = key.toString().toLowerCase();
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', onKey);
        rl.close();

        if (ch === 'u' || ch === '\r' || ch === '\n') {
          resolve(true);
        } else {
          resolve(false);
        }
      };

      process.stdin.on('data', onKey);
    } else {
      // Non-TTY fallback: use readline question
      rl.question(chalk.dim('  Update? (u/s): '), (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase() === 'u');
      });
    }
  });
}

export async function runUpdate(version: string): Promise<void> {
  const frames = ['◐', '◓', '◑', '◒'];
  let frame = 0;

  process.stdout.write(`  ${chalk.hex('#c9a8e8')(frames[0])} Updating to ${version}...`);

  const spinner = setInterval(() => {
    frame = (frame + 1) % frames.length;
    process.stdout.write(`\r  ${chalk.hex('#c9a8e8')(frames[frame])} Updating to ${version}...`);
  }, 120);

  try {
    execSync('npm install -g 0g-aura@latest', { stdio: 'pipe' });
    clearInterval(spinner);
    process.stdout.write(`\r  ${chalk.greenBright('✓')} Updated to ${chalk.whiteBright.bold(version)}     \n\n`);
  } catch {
    clearInterval(spinner);
    process.stdout.write(`\r  ${chalk.yellow('!')} Update failed — run ${chalk.dim('npm i -g 0g-aura@latest')} manually\n\n`);
  }
}

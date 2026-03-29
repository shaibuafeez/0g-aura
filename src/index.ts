#!/usr/bin/env node

import { Command } from 'commander';
import { loadConfig, AVAILABLE_MODELS } from './config.js';
import { startRepl } from './repl.js';
import { showError } from './ui.js';
import { listSessions, loadSession } from './session.js';
import { checkForUpdate, promptUpdate, runUpdate } from './update-check.js';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VERSION = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')).version as string;

const program = new Command();

program
  .name('aura')
  .description('Decentralized AI coding agent on 0G Compute')
  .version(VERSION)
  .option('-m, --model <name>', `Model to use (default: GLM-5-FP8)`, 'GLM-5-FP8')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', '.')
  .option('--no-confirm', 'Skip confirmations when applying changes')
  .action(async (opts) => {
    try {
      // Validate model
      if (opts.model && !AVAILABLE_MODELS.includes(opts.model)) {
        showError(`Unknown model: ${opts.model}`);
        console.log(`  Available: ${AVAILABLE_MODELS.join(', ')}`);
        process.exit(1);
      }

      let config;
      try {
        config = loadConfig({
          model: opts.model,
          projectDir: opts.dir === '.' ? process.cwd() : opts.dir,
          noConfirm: !opts.confirm,
        });
      } catch {
        // No wallet configured — run init automatically for first-time users
        console.log('');
        console.log('  Welcome! Let\u2019s set up your wallet first.\n');
        const { runInit } = await import('./init.js');
        await runInit();

        // Try loading config again after init
        try {
          config = loadConfig({
            model: opts.model,
            projectDir: opts.dir === '.' ? process.cwd() : opts.dir,
            noConfirm: !opts.confirm,
          });
        } catch (retryErr) {
          showError(retryErr instanceof Error ? retryErr.message : String(retryErr));
          process.exit(1);
        }
      }

      // Check for updates before starting REPL
      const update = await checkForUpdate(VERSION);
      if (update?.updateAvailable) {
        const wantsUpdate = await promptUpdate(update);
        if (wantsUpdate) await runUpdate(update.latest);
      }

      await startRepl(config, VERSION);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('init')
  .description('Set up your 0G wallet and configuration')
  .action(async () => {
    try {
      const { runInit } = await import('./init.js');
      await runInit();
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

program
  .command('resume')
  .description('Resume a previous session')
  .option('-d, --dir <path>', 'Project directory (default: cwd)', '.')
  .action(async (opts) => {
    try {
      const projectDir = opts.dir === '.' ? process.cwd() : opts.dir;
      const sessions = listSessions(projectDir);

      if (sessions.length === 0) {
        console.log(chalk.dim('\n  No saved sessions for this project.\n'));
        process.exit(0);
      }

      console.log(chalk.hex('#c9a8e8')('\n  Recent sessions:\n'));

      for (let i = 0; i < sessions.length; i++) {
        const s = sessions[i];
        const ago = formatRelativeTime(new Date(s.timestamp));
        const msgCount = s.history.filter((m) => m.role === 'user').length;
        const firstMsg = s.history.find((m) => m.role === 'user');
        const preview = firstMsg
          ? firstMsg.content.replace(/\n/g, ' ').slice(0, 60) + (firstMsg.content.length > 60 ? '...' : '')
          : '(empty)';

        console.log(
          `  ${chalk.whiteBright(String(i + 1).padStart(2))}  ${chalk.dim(ago.padEnd(14))}${chalk.dim('·')}  ${chalk.white(msgCount + ' msg' + (msgCount === 1 ? '' : 's'))}  ${chalk.dim('·')}  ${chalk.hex('#c9a8e8')(s.model)}`
        );
        console.log(`      ${chalk.dim('"' + preview + '"')}`);
        console.log('');
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.dim('  Pick a session (number): '), (ans) => {
          rl.close();
          resolve(ans.trim());
        });
      });

      const choice = parseInt(answer, 10);
      if (isNaN(choice) || choice < 1 || choice > sessions.length) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        process.exit(0);
      }

      const selected = sessions[choice - 1];
      const sessionData = loadSession(selected.id);
      if (!sessionData) {
        showError('Session file not found.');
        process.exit(1);
      }

      let config;
      try {
        config = loadConfig({
          model: sessionData.model,
          projectDir: sessionData.projectDir,
        });
      } catch {
        console.log('');
        console.log('  Welcome! Let\u2019s set up your wallet first.\n');
        const { runInit } = await import('./init.js');
        await runInit();
        config = loadConfig({
          model: sessionData.model,
          projectDir: sessionData.projectDir,
        });
      }

      // Check for updates before starting REPL
      const update = await checkForUpdate(VERSION);
      if (update?.updateAvailable) {
        const wantsUpdate = await promptUpdate(update);
        if (wantsUpdate) await runUpdate(update.latest);
      }

      await startRepl(config, VERSION, sessionData);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHr = Math.floor(diffMs / 3_600_000);
  const diffDay = Math.floor(diffMs / 86_400_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
  if (diffDay === 1) return 'yesterday';
  return `${diffDay} days ago`;
}

program.parseAsync(process.argv).catch((err) => {
  showError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

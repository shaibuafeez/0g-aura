import { createInterface } from 'readline';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { generateWallet, getWalletBalance, getWalletAddress } from './wallet.js';

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(question, (answer) => {
      rl.close();
      res(answer.trim());
    });
  });
}

export async function runInit(): Promise<void> {
  console.log('');
  console.log(chalk.cyanBright.bold('  AURA') + chalk.white(' Setup'));
  console.log(chalk.gray('  ─────────────────'));
  console.log('');
  console.log(chalk.white('  Configure your 0G wallet for decentralized AI compute.'));
  console.log('');

  // Step 1: Wallet
  console.log(chalk.white('  1)') + ' Create a new wallet');
  console.log(chalk.white('  2)') + ' Import an existing private key');
  console.log('');

  let privateKey = '';
  const choice = await ask(chalk.gray('  Choose (1 or 2): '));

  if (choice === '1') {
    const wallet = generateWallet();
    privateKey = wallet.privateKey;
    console.log('');
    console.log(chalk.greenBright('  New wallet created'));
    console.log('');
    console.log(chalk.white('  Your wallet address (copy this):'));
    console.log('');
    console.log(chalk.cyanBright(`  ${wallet.address}`));
    console.log('');
    console.log(chalk.dim('  Private Key: ') + chalk.yellow(wallet.privateKey));
    console.log('');
    console.log(chalk.yellow('  Save your private key somewhere safe. It cannot be recovered.'));
  } else {
    console.log('');
    privateKey = await ask(chalk.gray('  Private key: '));
    if (!privateKey) {
      console.log(chalk.red('\n  No key provided. Aborting.\n'));
      return;
    }
    if (!privateKey.startsWith('0x')) {
      privateKey = '0x' + privateKey;
    }
    try {
      const address = getWalletAddress(privateKey);
      if (!address) throw new Error('invalid');
      console.log(chalk.dim('  Wallet: ') + chalk.white(address));
    } catch {
      console.log(chalk.red('\n  Invalid private key. Aborting.\n'));
      return;
    }
  }

  // Step 2: Save location
  console.log('');
  console.log(chalk.white('  Where to save?'));
  console.log('');
  const cwdPath = resolve(process.cwd(), '.env');
  const homePath = resolve(homedir(), '.aura', '.env');
  console.log(chalk.white('  1)') + chalk.dim(` ${cwdPath}`));
  console.log(chalk.white('  2)') + chalk.dim(` ${homePath}`) + chalk.gray(' (global)'));
  console.log('');

  const saveChoice = await ask(chalk.gray('  Choose (1 or 2): '));
  const savePath = saveChoice === '2' ? homePath : cwdPath;

  const envContent = [
    '# Aura CLI — 0G wallet configuration',
    `ZG_PRIVATE_KEY=${privateKey}`,
    '',
    '# RPC endpoint (default: https://evmrpc.0g.ai)',
    '# ZG_RPC_URL=https://evmrpc.0g.ai',
    '',
    '# Auto-discover compute providers (default: true)',
    '# ZG_AUTO_DISCOVER_PROVIDER=true',
    '',
  ].join('\n');

  mkdirSync(dirname(savePath), { recursive: true });
  writeFileSync(savePath, envContent, { mode: 0o600 });
  console.log('');
  console.log(chalk.greenBright('  Saved to ') + chalk.white(savePath));

  // Step 3: Check balance
  console.log('');
  console.log(chalk.gray('  Checking balance...'));
  const address = getWalletAddress(privateKey);
  try {
    const balance = await getWalletBalance('https://evmrpc.0g.ai', privateKey);
    const num = parseFloat(balance);
    if (isNaN(num) || num === 0) {
      console.log(chalk.yellow('  Balance: 0 A0GI'));
    } else {
      console.log(chalk.greenBright(`  Balance: ${num.toFixed(2)} A0GI`));
    }
  } catch {
    console.log(chalk.yellow('  Could not check balance. Check your RPC endpoint or network.'));
  }

  console.log('');
  console.log(chalk.white('  Next steps:'));
  console.log(chalk.gray('    1. Get A0GI tokens at ') + chalk.cyanBright('https://portal.0g.ai'));
  if (address) {
    console.log(chalk.gray('       (send to ') + chalk.white(address) + chalk.gray(')'));
  }
  console.log(chalk.gray('    2. Run: ') + chalk.cyanBright('aura'));
  console.log(chalk.gray('    3. Type: ') + chalk.white('/deposit 0.5'));
  console.log(chalk.gray('       (moves 0.5 A0GI from wallet to compute)'));
  console.log(chalk.gray('    4. Start coding!'));

  console.log('');
  console.log(chalk.gray('  ─────────────────'));
  console.log(chalk.greenBright('  Ready!') + chalk.white(' Run ') + chalk.cyanBright('aura') + chalk.white(' to start.'));
  console.log('');
}

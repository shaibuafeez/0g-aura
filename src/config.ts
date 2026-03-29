import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { AuraConfig } from './types.js';

export const AVAILABLE_MODELS = [
  'GLM-5-FP8',
  'deepseek-chat-v3-0324',
  'gpt-oss-120b',
  'qwen3-vl-30b-a3b-instruct',
];

const DEFAULT_MODEL = 'GLM-5-FP8';
const DEFAULT_RPC = 'https://evmrpc.0g.ai';

export function loadConfig(overrides: Partial<AuraConfig> = {}): AuraConfig {
  // Load .env from cwd first, fallback to ~/.aura/.env
  const cwdEnv = resolve(process.cwd(), '.env');
  const homeEnv = resolve(homedir(), '.aura', '.env');
  let configSource = '';

  if (existsSync(cwdEnv)) {
    dotenvConfig({ path: cwdEnv });
    configSource = cwdEnv;
  } else if (existsSync(homeEnv)) {
    dotenvConfig({ path: homeEnv });
    configSource = homeEnv;
  } else {
    dotenvConfig();
  }

  const privateKey = overrides.privateKey || process.env.ZG_PRIVATE_KEY || '';
  if (!privateKey) {
    throw new Error(
      'No wallet configured. Run "aura init" to set up your wallet.'
    );
  }

  const autoDiscoverEnv = (process.env.ZG_AUTO_DISCOVER_PROVIDER || '').trim().toLowerCase();
  const autoDiscover = autoDiscoverEnv
    ? autoDiscoverEnv === '1' || autoDiscoverEnv === 'true' || autoDiscoverEnv === 'yes' || autoDiscoverEnv === 'on'
    : undefined;

  return {
    privateKey,
    rpcUrl: process.env.ZG_RPC_URL || DEFAULT_RPC,
    autoDiscover: overrides.autoDiscover ?? autoDiscover ?? true,
    providerAddress: process.env.ZG_PROVIDER_ADDRESS || undefined,
    model: overrides.model || DEFAULT_MODEL,
    projectDir: overrides.projectDir || process.cwd(),
    noConfirm: overrides.noConfirm || false,
    configSource,
  };
}

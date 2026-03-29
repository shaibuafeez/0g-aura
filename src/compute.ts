/**
 * 0G Compute Network — AI inference via decentralized GPU providers
 * Adapted from lib/0g/compute.ts for CLI usage.
 */

import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0glabs/0g-serving-broker';
import type { AuraConfig, Message } from './types.js';

export interface ZgComputeStatus {
  available: boolean;
  model: string;
  endpoint: string;
  providerAddress: string;
  discovered?: boolean;
  error?: string;
}

async function captureSdkConsole<T>(operation: () => Promise<T>): Promise<{ result: T; notices: string[]; raw: string[] }> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const capturedMessages: string[] = [];

  console.log = (...args: unknown[]) => {
    capturedMessages.push(args.map((arg) => String(arg)).join(' '));
  };

  console.warn = (...args: unknown[]) => {
    capturedMessages.push(args.map((arg) => String(arg)).join(' '));
  };

  try {
    const result = await operation();
    const raw = capturedMessages.map((m) => m.trim()).filter(Boolean);
    const notices = raw
      .filter((message) => {
        const normalized = message.toLowerCase();
        if (normalized.includes('ensure stable service') || normalized.includes('neuron needs to be transferred')) {
          return false;
        }
        return normalized.includes('warning') || normalized.includes('insufficient');
      });

    return { result, notices, raw };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

/** Singleton broker (re-used across requests) */
let brokerCache: {
  broker: any;
  wallet: ethers.Wallet;
  acknowledgedProviders: Set<string>;
  discoveredChatProvidersByModel: Map<string, { address: string; model: string }>;
} | null = null;

const DEFAULT_CHAT_PROVIDER_CACHE_KEY = '__default__';
const SERVICE_MODEL_INDEX = 6;

function normalizeModelName(model?: string): string {
  const trimmed = (model || '').trim().toLowerCase();
  if (!trimmed) return '';
  const segments = trimmed.split('/').filter(Boolean);
  return segments[segments.length - 1] || trimmed;
}

function getServiceModel(service: any): string {
  if (!Array.isArray(service)) return '';
  return String(service[SERVICE_MODEL_INDEX] || '').trim();
}

function getServiceProviderAddress(service: any): string {
  if (!Array.isArray(service)) return '';
  return String(service[0] || '').trim();
}

async function resolveServiceModel(broker: any, service: any): Promise<string> {
  const listedModel = getServiceModel(service);
  const providerAddress = getServiceProviderAddress(service);
  if (!providerAddress) return listedModel;

  try {
    const metadata = await broker.inference.getServiceMetadata(providerAddress);
    const metadataModel = String(metadata?.model || '').trim();
    return metadataModel || listedModel;
  } catch {
    return listedModel;
  }
}

function selectPreferredService(services: any[]): any {
  return services.reduce((best: any, candidate: any) => {
    if (!best) return candidate;
    const bestTee = best?.[10] === true;
    const candidateTee = candidate?.[10] === true;
    if (candidateTee && !bestTee) return candidate;
    return best;
  }, null);
}

async function getBroker(config: AuraConfig) {
  if (brokerCache) return brokerCache;

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);

  try {
    const { result: broker } = await captureSdkConsole(() =>
      createZGComputeNetworkBroker(wallet as any)
    );
    brokerCache = {
      broker,
      wallet,
      acknowledgedProviders: new Set<string>(),
      discoveredChatProvidersByModel: new Map<string, { address: string; model: string }>(),
    };
    return brokerCache;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Broker init failed on ${config.rpcUrl}: ${msg}`);
  }
}

/**
 * Clear only the model→provider discovery cache.
 * The broker instance and acknowledged providers are preserved,
 * avoiding unnecessary re-initialization and re-acknowledgement
 * (which costs gas and can fail with "insufficient balance").
 */
export function clearModelDiscoveryCache(): void {
  if (brokerCache) {
    brokerCache.discoveredChatProvidersByModel.clear();
  }
}

/** Full reset — only needed if the wallet/RPC changes, not for model switches. */
export function resetBrokerCache(): void {
  brokerCache = null;
}

/**
 * Deposit A0GI from wallet into the 0G Compute Main Account.
 * This is the staked balance used to pay for inference.
 */
export async function depositToCompute(config: AuraConfig, amount: number): Promise<string | null> {
  const cache = await getBroker(config);

  // Check if ledger account exists; if not, create it with addLedger
  let hasLedger = false;
  try {
    const ledger = await cache.broker.ledger.getLedger();
    if (ledger) hasLedger = true;
  } catch {
    // No ledger exists yet
  }

  if (!hasLedger) {
    const { raw } = await captureSdkConsole(() => cache.broker.ledger.addLedger(amount));
    return extractTxHash(raw);
  }

  const { raw } = await captureSdkConsole(() => cache.broker.ledger.depositFund(amount));
  return extractTxHash(raw);
}

/**
 * Withdraw A0GI from compute deposit back to wallet.
 */
export async function withdrawFromCompute(config: AuraConfig, amount: number): Promise<string | null> {
  const cache = await getBroker(config);
  const { raw } = await captureSdkConsole(() => cache.broker.ledger.refund(amount));
  return extractTxHash(raw);
}

function extractTxHash(messages: string[]): string | null {
  for (const msg of messages) {
    const match = msg.match(/tx hash:\s*(0x[a-fA-F0-9]{64})/);
    if (match) return match[1];
  }
  return null;
}

/** Rough cost per request by model (A0GI). Conservative estimates. */
const MODEL_COST_TABLE: Record<string, number> = {
  'glm-5-fp8': 0.005,
  'deepseek-chat-v3-0324': 0.008,
  'gpt-oss-120b': 0.01,
  'qwen3-vl-30b-a3b-instruct': 0.006,
};

/**
 * Return estimated cost per request for a given model (in A0GI).
 * Falls back to 0.005 for unknown models.
 */
export function getEstimatedCost(model: string): number {
  const key = model.trim().toLowerCase();
  return MODEL_COST_TABLE[key] ?? 0.005;
}

/**
 * Get the compute deposit balance from the 0G Serving broker ledger.
 * This is the staked A0GI required to use compute providers.
 * Returns { available, total } in A0GI, or null if not reachable.
 */
export async function getComputeDeposit(config: AuraConfig): Promise<{ available: string; total: string; locked: string } | null> {
  try {
    const cache = await getBroker(config);
    const ledger = await cache.broker.ledger.getLedger();
    // Struct fields: { availableBalance, totalBalance } — also accessible as [0], [1]
    const totalRaw = BigInt((ledger as any).totalBalance ?? ledger[1] ?? 0);
    const availableRaw = BigInt((ledger as any).availableBalance ?? ledger[0] ?? 0);
    const lockedRaw = totalRaw - availableRaw;
    return {
      available: ethers.formatEther(availableRaw),
      total: ethers.formatEther(totalRaw),
      locked: ethers.formatEther(lockedRaw),
    };
  } catch {
    return null;
  }
}

async function resolveProviderAddress(
  config: AuraConfig,
  requestedModel?: string
): Promise<{ providerAddress: string; discovered: boolean; serviceModel?: string }> {
  if (config.providerAddress) {
    return { providerAddress: config.providerAddress, discovered: false };
  }

  if (!config.autoDiscover) {
    throw new Error('ZG_PROVIDER_ADDRESS not set (or enable ZG_AUTO_DISCOVER_PROVIDER=true)');
  }

  const cache = await getBroker(config);
  const normalizedRequestedModel = normalizeModelName(requestedModel);
  const cacheKey = normalizedRequestedModel || DEFAULT_CHAT_PROVIDER_CACHE_KEY;
  const cachedProvider = cache.discoveredChatProvidersByModel.get(cacheKey);
  if (cachedProvider?.address) {
    return {
      providerAddress: cachedProvider.address,
      discovered: true,
      serviceModel: cachedProvider.model,
    };
  }

  let services: any;
  try {
    services = await cache.broker.inference.listService();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Provider discovery failed: ${msg}`);
  }
  const chatbotServices = (Array.isArray(services) ? services : []).filter((service: any) => {
    if (!Array.isArray(service)) return false;
    const serviceType = String(service[1] || '').toLowerCase();
    if (serviceType !== 'chatbot') return false;
    return !!service[0];
  });

  if (chatbotServices.length === 0) {
    throw new Error('No chatbot providers found via 0G Compute discovery');
  }

  let candidateServices = chatbotServices;
  if (normalizedRequestedModel) {
    const modelMatchedServices: any[] = [];
    for (const service of chatbotServices) {
      const resolvedModel = await resolveServiceModel(cache.broker, service);
      if (normalizeModelName(resolvedModel) === normalizedRequestedModel) {
        modelMatchedServices.push(service);
      }
    }
    if (modelMatchedServices.length === 0) {
      throw new Error(`Requested 0G model is unavailable: ${requestedModel}`);
    }
    candidateServices = modelMatchedServices;
  }

  const selected = selectPreferredService(candidateServices);
  const providerAddress = String(selected[0]);
  const serviceModel = await resolveServiceModel(cache.broker, selected);

  cache.discoveredChatProvidersByModel.set(cacheKey, { address: providerAddress, model: serviceModel });
  if (serviceModel) {
    cache.discoveredChatProvidersByModel.set(normalizeModelName(serviceModel), {
      address: providerAddress,
      model: serviceModel,
    });
  }

  return { providerAddress, discovered: true, serviceModel };
}

async function ensureProviderAcknowledged(config: AuraConfig, providerAddress: string) {
  const cache = await getBroker(config);
  if (cache.acknowledgedProviders.has(providerAddress)) return;

  const acknowledgeFn = cache.broker?.inference?.acknowledgeProviderSigner;
  if (typeof acknowledgeFn !== 'function') return;

  try {
    await acknowledgeFn.call(cache.broker.inference, providerAddress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const normalized = message.toLowerCase();
    const looksAlreadyAcknowledged =
      normalized.includes('already') ||
      normalized.includes('acknowledged') ||
      normalized.includes('duplicate');
    if (!looksAlreadyAcknowledged) throw err;
  }

  cache.acknowledgedProviders.add(providerAddress);
}

/**
 * Check if 0G Compute is reachable with current config.
 */
export async function checkZgComputeStatus(config: AuraConfig): Promise<ZgComputeStatus> {
  try {
    const { providerAddress, discovered } = await resolveProviderAddress(config, config.model);
    const { broker } = await getBroker(config);
    const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
    return { available: true, model, endpoint, providerAddress, discovered };
  } catch (err) {
    return {
      available: false,
      model: '',
      endpoint: '',
      providerAddress: config.providerAddress || '',
      error: String(err),
    };
  }
}

export interface StreamResult {
  chunks: AsyncGenerator<string>;
  settle: () => Promise<void>;
  getUsage: () => Record<string, unknown> | null;
  notices: string[];
}

/**
 * Run a streaming chat completion on 0G Compute.
 * Returns a StreamResult with:
 *   - chunks: AsyncGenerator<string> to consume text deltas
 *   - settle: () => Promise<void> to call AFTER consuming all chunks (fee settlement)
 */
export async function zgStreamChat(
  config: AuraConfig,
  messages: Message[],
  systemPrompt?: string,
  requestedModel?: string
): Promise<StreamResult> {
  const { providerAddress } = await resolveProviderAddress(config, requestedModel);
  const { broker } = await getBroker(config);
  const notices: string[] = [];

  const acknowledgeResult = await captureSdkConsole(() =>
    ensureProviderAcknowledged(config, providerAddress)
  );
  notices.push(...acknowledgeResult.notices);

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const requestHeaderResult = await captureSdkConsole(() =>
    broker.inference.getRequestHeaders(providerAddress)
  );
  const headers = (requestHeaderResult.result || {}) as Record<string, string>;
  notices.push(...requestHeaderResult.notices);

  const body = {
    model,
    stream: true,
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map((m) => ({ role: m.role, content: m.content })),
    ],
  };

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`0G Compute error: ${response.status} ${await response.text()}`);
  }

  const chatID = response.headers.get('ZG-Res-Key') || response.headers.get('zg-res-key');
  let streamChatID: string | null = null;
  let usage: any = null;

  async function* streamChunks(): AsyncGenerator<string> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let streamComplete = false;

    try {
      while (!streamComplete) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        sseBuffer += chunk;

        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === 'data: [DONE]') {
            streamComplete = true;
            break;
          }

          try {
            const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
            const msg = JSON.parse(jsonStr);
            if (!streamChatID && msg.id) streamChatID = msg.id;
            if (msg.usage) usage = msg.usage;
            if (msg.choices?.[0]?.finish_reason) {
              streamComplete = true;
            }
            const delta = msg.choices?.[0]?.delta?.content;
            if (delta) yield delta;
            if (streamComplete) {
              break;
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Process trailing buffer
      const trailingLine = sseBuffer.trim();
      if (!streamComplete && trailingLine && trailingLine !== 'data: [DONE]') {
        try {
          const jsonStr = trailingLine.startsWith('data:') ? trailingLine.slice(5).trim() : trailingLine;
          const msg = JSON.parse(jsonStr);
          if (!streamChatID && msg.id) streamChatID = msg.id;
          if (msg.usage) usage = msg.usage;
          const delta = msg.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch {
          // ignore trailing parse errors
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // CRITICAL: processResponse() MUST be called after every inference request.
  // Skipping this causes fee settlement failure and potential fund lock.
  async function settle(): Promise<void> {
    const finalChatID = chatID || streamChatID;
    if (finalChatID) {
      try {
        const settleResult = await captureSdkConsole(() =>
          broker.inference.processResponse(
            providerAddress,
            finalChatID,
            JSON.stringify(usage || {})
          )
        );
        notices.push(...settleResult.notices);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notices.push(`0G settlement warning: ${message}`);
      }
    }
  }

  return {
    chunks: streamChunks(),
    settle,
    getUsage: () => (usage && typeof usage === 'object' ? { ...(usage as Record<string, unknown>) } : null),
    notices,
  };
}

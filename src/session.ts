import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, basename } from 'path';
import type { Message } from './types.js';

export interface SessionData {
  id: string;
  timestamp: string;
  model: string;
  projectDir: string;
  projectName: string;
  history: Message[];
  addedFiles: string[];
  readTrackerPaths: string[];
  stats: { tokensIn: number; tokensOut: number; requests: number };
}

const MAX_SESSIONS_PER_PROJECT = 20;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSessionDir(): string {
  const dir = join(homedir(), '.aura', 'sessions');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function projectHash(projectDir: string): string {
  return createHash('sha256').update(projectDir).digest('hex').slice(0, 6);
}

export function saveSession(data: Omit<SessionData, 'id' | 'timestamp' | 'projectName'>): string {
  const dir = getSessionDir();
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = projectHash(data.projectDir);
  const id = `${ts}-${hash}`;
  const projectName = data.projectDir.split(/[\\/]/).filter(Boolean).pop() || 'unknown';

  const session: SessionData = {
    id,
    timestamp: now.toISOString(),
    model: data.model,
    projectDir: data.projectDir,
    projectName,
    history: data.history,
    addedFiles: data.addedFiles,
    readTrackerPaths: data.readTrackerPaths,
    stats: data.stats,
  };

  const filename = `${id}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(session, null, 2), 'utf-8');

  // Auto-prune after save
  pruneOldSessions(data.projectDir);

  return id;
}

export function listSessions(projectDir: string): SessionData[] {
  const dir = getSessionDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessions: SessionData[] = [];

  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw) as SessionData;
      if (data.projectDir === projectDir) {
        sessions.push(data);
      }
    } catch {
      // Skip corrupt files
    }
  }

  // Sort newest first
  sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return sessions;
}

export function loadSession(id: string): SessionData | null {
  const dir = getSessionDir();
  const filepath = join(dir, `${id}.json`);
  if (!existsSync(filepath)) return null;

  try {
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as SessionData;
  } catch {
    return null;
  }
}

function pruneOldSessions(projectDir: string): void {
  const dir = getSessionDir();
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const now = Date.now();

  // First pass: delete sessions older than MAX_AGE_MS
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf-8');
      const data = JSON.parse(raw) as SessionData;
      const age = now - new Date(data.timestamp).getTime();
      if (age > MAX_AGE_MS) {
        unlinkSync(join(dir, file));
      }
    } catch {
      // Skip corrupt files
    }
  }

  // Second pass: enforce per-project limit
  const sessions = listSessions(projectDir);
  if (sessions.length > MAX_SESSIONS_PER_PROJECT) {
    const toRemove = sessions.slice(MAX_SESSIONS_PER_PROJECT);
    for (const session of toRemove) {
      const filepath = join(dir, `${session.id}.json`);
      try {
        unlinkSync(filepath);
      } catch {
        // Ignore
      }
    }
  }
}

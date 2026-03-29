import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const RULES_PATHS = [
  '.aura/rules',
  '.aura/rules.md',
  '.aura/RULES.md',
];

const MAX_RULES_SIZE = 8 * 1024; // 8KB

export function loadProjectRules(projectDir: string): string {
  for (const candidate of RULES_PATHS) {
    const fullPath = join(projectDir, candidate);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, 'utf-8');
      if (content.length > MAX_RULES_SIZE) {
        return content.slice(0, MAX_RULES_SIZE) + '\n[truncated — rules file exceeds 8KB]';
      }
      return content;
    } catch {
      // skip unreadable
    }
  }

  return '';
}

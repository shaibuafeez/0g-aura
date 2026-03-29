export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ParsedFile {
  path: string;
  content: string;
}

export interface ParsedEdit {
  path: string;
  search: string;
  replace: string;
}

export interface ParsedCommand {
  command: string;
}

export interface ParsedResponse {
  explanation: string;
  files: ParsedFile[];
  edits: ParsedEdit[];
  commands: ParsedCommand[];
  searches: string[];
}

export interface ReadTracker {
  mark(path: string): void;
  has(path: string): boolean;
  list(): string[];
}

export interface ProjectInfo {
  type: string;
  tree: string;
  files: Map<string, string>;
  rules: string;
}

export interface AuraConfig {
  privateKey: string;
  rpcUrl: string;
  autoDiscover: boolean;
  providerAddress?: string;
  model: string;
  projectDir: string;
  noConfirm: boolean;
  configSource: string;
}

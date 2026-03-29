import type { ParsedResponse, ParsedFile, ParsedEdit, ParsedCommand } from './types.js';

export function parseResponse(text: string): ParsedResponse {
  const files: ParsedFile[] = [];
  const edits: ParsedEdit[] = [];
  const commands: ParsedCommand[] = [];
  const strippedPatterns: RegExp[] = [];
  let match: RegExpExecArray | null;

  // Primary: <file path="...">...</file>
  const fileTagPattern = /<file\s+path=["']([^"']+)["']>([\s\S]*?)<\/file>/g;
  while ((match = fileTagPattern.exec(text)) !== null) {
    files.push({ path: match[1].trim(), content: match[2].trim() + '\n' });
  }
  if (files.length > 0) {
    strippedPatterns.push(/<file\s+path=["'][^"']+["']>[\s\S]*?<\/file>/g);
  }

  // Fallback: ```lang title="path"\ncontent```
  if (files.length === 0) {
    const titlePattern = /```[a-zA-Z]*\s+title=["']([^"']+)["']\s*\n([\s\S]*?)```/g;
    while ((match = titlePattern.exec(text)) !== null) {
      files.push({ path: match[1].trim(), content: match[2].trim() + '\n' });
    }
    if (files.length > 0) {
      strippedPatterns.push(/```[a-zA-Z]*\s+title=["'][^"']+["']\s*\n[\s\S]*?```/g);
    }
  }

  // Fallback: ```lang\n// filename: path\ncontent```
  if (files.length === 0) {
    const commentPattern = /```[a-zA-Z]+\n\/\/\s*(?:filepath|filename|file):?\s*(\S+)\n([\s\S]*?)```/g;
    while ((match = commentPattern.exec(text)) !== null) {
      files.push({ path: match[1].trim(), content: match[2].trim() + '\n' });
    }
    if (files.length > 0) {
      strippedPatterns.push(/```[a-zA-Z]+\n\/\/\s*(?:filepath|filename|file):?\s*\S+\n[\s\S]*?```/g);
    }
  }

  // SEARCH/REPLACE edits (runs in parallel with <file> parsing)
  const editPattern = /(\S+?)\n<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>> REPLACE/g;
  while ((match = editPattern.exec(text)) !== null) {
    edits.push({
      path: match[1].trim(),
      search: match[2],
      replace: match[3],
    });
  }
  if (edits.length > 0) {
    strippedPatterns.push(/\S+?\n<<<<<<< SEARCH\n[\s\S]*?\n=======\n[\s\S]*?\n>>>>>>> REPLACE/g);
  }

  // Web search requests: <search query="..."/> or <search query="..."></search>
  const searches: string[] = [];
  const searchPattern = /<search\s+query=["']([^"']+)["']\s*\/?>/g;
  while ((match = searchPattern.exec(text)) !== null) {
    searches.push(match[1].trim());
  }
  if (searches.length > 0) {
    strippedPatterns.push(/<search\s+query=["'][^"']+["']\s*\/?>\s*(<\/search>)?/g);
  }

  // Shell commands: ```shell, ```bash, ```sh
  const shellPattern = /```(?:shell|bash|sh)\n([\s\S]*?)```/g;
  while ((match = shellPattern.exec(text)) !== null) {
    const block = match[1].trim();
    for (const line of block.split('\n')) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith('#')) {
        commands.push({ command: cmd });
      }
    }
  }
  strippedPatterns.push(/```(?:shell|bash|sh)\n[\s\S]*?```/g);

  // Build explanation by stripping matched patterns
  let explanation = text;
  for (const pattern of strippedPatterns) {
    explanation = explanation.replace(pattern, '');
  }
  explanation = explanation.trim();

  return { explanation, files, edits, commands, searches };
}

/**
 * Web search via DuckDuckGo HTML — zero dependencies, no API key.
 */

import chalk from 'chalk';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DDG_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 5;
const FETCH_TIMEOUT = 8_000;

export async function webSearch(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(DDG_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; aura-cli/1.0)',
      },
      body: params.toString(),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo returned ${res.status}`);
    }

    const html = await res.text();
    return parseResults(html).slice(0, MAX_RESULTS);
  } finally {
    clearTimeout(timer);
  }
}

function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // DuckDuckGo HTML results are in <a class="result__a"> and <a class="result__snippet">
  const blockPattern = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let blockMatch;

  while ((blockMatch = blockPattern.exec(html)) !== null) {
    const block = blockMatch[1];

    // Extract title + URL from result link
    const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;

    let url = linkMatch[1];
    const title = stripHtml(linkMatch[2]).trim();

    // DuckDuckGo wraps URLs in a redirect — extract the real URL
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      url = decodeURIComponent(uddgMatch[1]);
    }

    // Extract snippet
    const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    const snippet = snippetMatch ? stripHtml(snippetMatch[1]).trim() : '';

    if (title && url) {
      results.push({ title, url, snippet });
    }
  }

  // Fallback: simpler pattern if the above didn't match
  if (results.length === 0) {
    const simplePattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
    let simpleMatch;
    while ((simpleMatch = simplePattern.exec(html)) !== null) {
      let url = simpleMatch[1];
      const title = stripHtml(simpleMatch[2]).trim();
      const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1]);
      }
      if (title && url && !url.includes('duckduckgo.com')) {
        results.push({ title, url, snippet: '' });
      }
    }
  }

  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<b>/gi, '')
    .replace(/<\/b>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPageContent(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; aura-cli/1.0)',
        'Accept': 'text/html,text/plain',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      return `[Failed to fetch: HTTP ${res.status}]`;
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/')) {
      return `[Non-text content: ${contentType}]`;
    }

    const text = await res.text();
    // Strip HTML, keep text content
    const cleaned = stripHtml(text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''));
    // Truncate to ~4KB to avoid blowing up context
    if (cleaned.length > 4096) {
      return cleaned.slice(0, 4096) + '\n[truncated]';
    }
    return cleaned;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Styled search results for terminal display (used with ui.log('diff', ...))
 */
export function formatSearchResultsStyled(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `${chalk.dim('no results for')} ${chalk.hex('#c9a8e8')(query)}`;
  }

  const header = `  ${chalk.hex('#c9a8e8')('⌕')} ${chalk.hex('#cbd5e1')(query)}  ${chalk.dim('·')} ${chalk.dim(`${results.length} results`)}`;
  const divider = `  ${chalk.dim('─'.repeat(50))}`;

  const items = results.map((r, i) => {
    const num = chalk.hex('#c9a8e8').bold(`${i + 1}`);
    const title = chalk.white.bold(r.title);
    const url = chalk.hex('#8be9fd').dim(truncateUrl(r.url));
    const snippet = r.snippet ? `  ${chalk.dim(truncateSnippet(r.snippet, 90))}` : '';
    return `  ${num}  ${title}\n     ${url}${snippet ? '\n    ' + snippet : ''}`;
  });

  return [header, divider, ...items, ''].join('\n');
}

/**
 * Plain-text search results for model context (no ANSI colors)
 */
export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `Web search for "${query}" returned no results.`;
  }

  let output = `Search results for "${query}":\n`;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    output += `\n${i + 1}. ${r.title}\n   ${r.url}`;
    if (r.snippet) {
      output += `\n   ${r.snippet}`;
    }
  }
  return output;
}

function truncateUrl(url: string): string {
  // Strip protocol and trailing slash
  let clean = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (clean.length > 60) {
    clean = clean.slice(0, 57) + '...';
  }
  return clean;
}

function truncateSnippet(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

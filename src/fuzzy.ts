/**
 * 4-layer fuzzy matching engine for SEARCH/REPLACE edits.
 * Layers (tried in order, first match wins):
 *   1. Exact substring match
 *   2. Whitespace-normalized (collapse \s+ to single space)
 *   3. Indent-flexible (strip leading whitespace per line)
 *   4. Line-level LCS similarity (threshold 0.6)
 */

export interface FuzzyMatch {
  start: number;
  end: number;
  layer: 1 | 2 | 3 | 4;
}

// ── Layer 1: Exact ──────────────────────────────────────────────

function exactMatch(haystack: string, needle: string): FuzzyMatch | null {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  return { start: idx, end: idx + needle.length, layer: 1 };
}

// ── Layer 2: Whitespace-normalized ──────────────────────────────

function normalizeWhitespace(text: string): string {
  return text.replace(/[ \t]+/g, ' ').replace(/\r\n/g, '\n');
}

function whitespaceMatch(haystack: string, needle: string): FuzzyMatch | null {
  const normHay = normalizeWhitespace(haystack);
  const normNeedle = normalizeWhitespace(needle);
  const idx = normHay.indexOf(normNeedle);
  if (idx === -1) return null;

  // Map normalized position back to original
  let origStart = mapNormToOrig(haystack, normHay, idx);
  let origEnd = mapNormToOrig(haystack, normHay, idx + normNeedle.length);
  return { start: origStart, end: origEnd, layer: 2 };
}

function mapNormToOrig(original: string, _normalized: string, normPos: number): number {
  let normIdx = 0;
  let origIdx = 0;
  const normOrig = normalizeWhitespace(original);

  while (normIdx < normPos && origIdx < original.length) {
    // Walk original char by char, tracking normalized position
    const origChar = original[origIdx];
    const normChar = normOrig[normIdx];

    if (origChar === normChar) {
      normIdx++;
      origIdx++;
    } else {
      // Original has extra whitespace that got collapsed
      origIdx++;
    }
  }

  return origIdx;
}

// ── Layer 3: Indent-flexible ────────────────────────────────────

function stripIndent(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trimStart())
    .join('\n');
}

function indentMatch(haystack: string, needle: string): FuzzyMatch | null {
  const strippedHay = stripIndent(haystack);
  const strippedNeedle = stripIndent(needle);

  const idx = strippedHay.indexOf(strippedNeedle);
  if (idx === -1) return null;

  // Map back to original lines
  const hayLines = haystack.split('\n');
  const strippedHayLines = strippedHay.split('\n');
  const needleLineCount = strippedNeedle.split('\n').length;

  // Find which stripped line the match starts on
  let charCount = 0;
  let startLine = 0;
  for (let i = 0; i < strippedHayLines.length; i++) {
    if (charCount >= idx) {
      startLine = i;
      break;
    }
    charCount += strippedHayLines[i].length + 1; // +1 for \n
    if (charCount > idx) {
      startLine = i;
      break;
    }
  }

  const endLine = Math.min(startLine + needleLineCount, hayLines.length);

  // Convert line range to char positions in original
  let origStart = 0;
  for (let i = 0; i < startLine; i++) {
    origStart += hayLines[i].length + 1;
  }

  let origEnd = origStart;
  for (let i = startLine; i < endLine; i++) {
    origEnd += hayLines[i].length + 1;
  }

  // Trim trailing newline if haystack doesn't end with one
  if (origEnd > haystack.length) {
    origEnd = haystack.length;
  }

  return { start: origStart, end: origEnd, layer: 3 };
}

// ── Layer 4: LCS similarity ────────────────────────────────────

const SIMILARITY_THRESHOLD = 0.6;

function lcsLength(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;

  // Space-optimized LCS: only keep two rows
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return prev[n];
}

function similarityMatch(haystack: string, needle: string): FuzzyMatch | null {
  const hayLines = haystack.split('\n');
  const needleLines = needle.split('\n').map((l) => l.trim()).filter(Boolean);

  if (needleLines.length === 0) return null;

  const windowSize = needleLines.length;
  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;

  // Slide a window of needleLines.length across haystack lines
  for (let i = 0; i <= hayLines.length - windowSize; i++) {
    const window = hayLines.slice(i, i + windowSize).map((l) => l.trim()).filter(Boolean);
    if (window.length === 0) continue;

    const lcs = lcsLength(window, needleLines);
    const score = (2 * lcs) / (window.length + needleLines.length);

    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestEnd = i + windowSize;
    }
  }

  if (bestScore < SIMILARITY_THRESHOLD || bestStart === -1) return null;

  // Convert line range to char positions
  let start = 0;
  for (let i = 0; i < bestStart; i++) {
    start += hayLines[i].length + 1;
  }

  let end = start;
  for (let i = bestStart; i < bestEnd; i++) {
    end += hayLines[i].length + 1;
  }

  if (end > haystack.length) end = haystack.length;

  return { start, end, layer: 4 };
}

// ── Public API ──────────────────────────────────────────────────

export function fuzzyFind(haystack: string, needle: string): FuzzyMatch | null {
  if (!needle) return null;

  return (
    exactMatch(haystack, needle) ||
    whitespaceMatch(haystack, needle) ||
    indentMatch(haystack, needle) ||
    similarityMatch(haystack, needle)
  );
}

/**
 * Adapts the replacement text's indentation to match the indentation
 * found at the match site in the original file.
 * Only used for fuzzy matches (layers 2-4) where indentation may differ.
 */
export function adaptIndentation(
  originalSlice: string,
  replacement: string
): string {
  const origLines = originalSlice.split('\n');
  const replLines = replacement.split('\n');

  if (origLines.length === 0 || replLines.length === 0) return replacement;

  // Detect the indentation of the first non-empty original line
  const firstOrigLine = origLines.find((l) => l.trim().length > 0) || '';
  const origIndentMatch = firstOrigLine.match(/^(\s*)/);
  const origIndent = origIndentMatch ? origIndentMatch[1] : '';

  // Detect the indentation of the first non-empty replacement line
  const firstReplLine = replLines.find((l) => l.trim().length > 0) || '';
  const replIndentMatch = firstReplLine.match(/^(\s*)/);
  const replIndent = replIndentMatch ? replIndentMatch[1] : '';

  if (origIndent === replIndent) return replacement;

  // Re-indent each replacement line
  return replLines
    .map((line) => {
      if (line.trim().length === 0) return line;
      if (line.startsWith(replIndent)) {
        return origIndent + line.slice(replIndent.length);
      }
      return origIndent + line.trimStart();
    })
    .join('\n');
}

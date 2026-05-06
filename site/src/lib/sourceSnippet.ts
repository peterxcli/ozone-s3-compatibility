export interface ExtractedSnippet {
  text: string;
  startLine: number | null;
}

const PYTHON_KEYWORDS = [
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "elif",
  "else",
  "except",
  "False",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "None",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "True",
  "try",
  "while",
  "with",
  "yield",
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function trimParameterizedName(symbol: string): string {
  return symbol.replace(/\[.*\]$/, "");
}

function leadingSpaces(line: string): number {
  const match = line.match(/^\s*/);
  return match ? match[0].length : 0;
}

export function extractPythonSnippet(
  source: string,
  symbol: string,
  maxLines = 80,
): ExtractedSnippet {
  const lines = source.split(/\r?\n/);
  const cleanSymbol = trimParameterizedName(symbol);
  const symbolPattern = escapeRegExp(cleanSymbol);
  const defPattern = new RegExp(`^\\s*(?:async\\s+)?def\\s+${symbolPattern}\\s*\\(`);
  const defIndex = lines.findIndex((line) => defPattern.test(line));

  if (defIndex === -1) {
    return {
      text: lines.slice(0, maxLines).join("\n"),
      startLine: lines.length ? 1 : null,
    };
  }

  let startIndex = defIndex;
  while (startIndex > 0 && lines[startIndex - 1].trimStart().startsWith("@")) {
    startIndex -= 1;
  }

  const defIndent = leadingSpaces(lines[defIndex]);
  let endIndex = lines.length;
  for (let index = defIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent <= defIndent && /^\s*(?:async\s+)?def\s+|^\s*class\s+/.test(line)) {
      endIndex = index;
      break;
    }
  }

  return {
    text: lines.slice(startIndex, Math.min(endIndex, startIndex + maxLines)).join("\n"),
    startLine: startIndex + 1,
  };
}

function highlightPythonLine(line: string): string {
  const commentIndex = line.indexOf("#");
  const code = commentIndex === -1 ? line : line.slice(0, commentIndex);
  const comment = commentIndex === -1 ? "" : line.slice(commentIndex);
  const keywordPattern = new RegExp(`\\b(${PYTHON_KEYWORDS.map(escapeRegExp).join("|")})\\b`, "g");
  const highlightedCode = code
    .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="syntax-string">$1</span>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="syntax-number">$1</span>')
    .replace(keywordPattern, '<span class="syntax-keyword">$1</span>');

  if (!comment) {
    return highlightedCode;
  }
  return `${highlightedCode}<span class="syntax-comment">${comment}</span>`;
}

function highlightShellLine(line: string): string {
  return line
    .replace(/(^|\s)(--?[A-Za-z0-9][\w-]*)/g, '$1<span class="syntax-option">$2</span>')
    .replace(/(&quot;.*?&quot;|&#39;.*?&#39;)/g, '<span class="syntax-string">$1</span>');
}

export function highlightCode(source: string, language = "text"): string {
  const escaped = escapeHtml(source);
  if (language === "python") {
    return escaped.split("\n").map(highlightPythonLine).join("\n");
  }
  if (language === "shell" || language === "bash") {
    return escaped.split("\n").map(highlightShellLine).join("\n");
  }
  return escaped;
}

function normalizeGithubRepo(repo: string): string | null {
  const trimmed = repo.trim().replace(/\.git$/, "");
  const match = trimmed.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  return match ? match[1] : null;
}

export function githubRawUrl(repo: string, ref: string, sourcePath: string): string | null {
  const slug = normalizeGithubRepo(repo);
  if (!slug || !ref || !sourcePath) {
    return null;
  }
  return `https://raw.githubusercontent.com/${slug}/${encodeURIComponent(ref)}/${sourcePath}`;
}

export function githubBlobUrl(
  repo: string,
  ref: string,
  sourcePath: string,
  startLine: number | null = null,
): string | null {
  const slug = normalizeGithubRepo(repo);
  if (!slug || !ref || !sourcePath) {
    return null;
  }
  const lineAnchor = startLine ? `#L${startLine}` : "";
  return `https://github.com/${slug}/blob/${encodeURIComponent(ref)}/${sourcePath}${lineAnchor}`;
}

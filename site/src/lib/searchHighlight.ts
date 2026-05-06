interface MatchRange {
  start: number;
  end: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeQuery(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function queryTokens(query: string): string[] {
  const seen = new Set<string>();
  return normalizeQuery(query)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => {
      if (seen.has(token)) {
        return false;
      }
      seen.add(token);
      return true;
    })
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function matchingRanges(value: string, query: string): MatchRange[] {
  const lowerValue = value.toLowerCase();
  const ranges: MatchRange[] = [];

  queryTokens(query).forEach((token) => {
    let searchFrom = 0;
    while (searchFrom < lowerValue.length) {
      const start = lowerValue.indexOf(token, searchFrom);
      if (start === -1) {
        break;
      }
      const end = start + token.length;
      ranges.push({ start, end });
      searchFrom = end;
    }
  });

  return ranges
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<MatchRange[]>((merged, range) => {
      const previous = merged.at(-1);
      if (!previous || range.start > previous.end) {
        merged.push({ ...range });
        return merged;
      }
      previous.end = Math.max(previous.end, range.end);
      return merged;
    }, []);
}

export function highlightSearchMatch(value: string | null | undefined, query: string): string {
  const text = String(value || "");
  const ranges = matchingRanges(text, query);

  if (!ranges.length) {
    return escapeHtml(text);
  }

  let html = "";
  let cursor = 0;
  ranges.forEach((range) => {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<mark class="search-match">${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  });
  html += escapeHtml(text.slice(cursor));
  return html;
}

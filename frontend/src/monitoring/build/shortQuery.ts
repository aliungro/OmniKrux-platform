// A query as one short line for a card: spaces collapsed, and when it is longer than `max` cut at a
// token boundary (never mid-word, never inside a quoted string) with an ellipsis. The card keeps the
// full text in its title.

const BOUNDARY = new Set([" ", "(", ")", "{", "}", ",", "[", "|"]);

export function shortQuery(expr: string, max = 60): string {
  const text = expr.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const limit = max - 1; // room for the ellipsis
  let quote: string | null = null;
  let quoteStart = -1;
  let boundary = -1; // the last boundary character outside a quoted string, within the limit
  for (let i = 0; i < text.length && i + 1 <= limit; i += 1) {
    const c = text[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      quoteStart = i;
    } else if (BOUNDARY.has(c)) {
      boundary = i;
    }
  }
  if (boundary >= 0) return `${text.slice(0, boundary + 1).trimEnd()}…`;
  // No boundary at all (one long word): cut before an open quote, else at the limit.
  const end = quote !== null ? quoteStart : limit;
  return `${text.slice(0, end).trimEnd()}…`;
}

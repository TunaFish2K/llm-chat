/** Match literal text without interpreting regex characters supplied by the user. */
export function literalSearchPattern(query: string): RegExp | null {
  const needle = query.trim();
  return needle ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu") : null;
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const pattern = literalSearchPattern(query);
  if (!pattern) return <>{text}</>;
  const parts = [];
  let start = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    parts.push(text.slice(start, index), <mark key={index}>{match[0]}</mark>);
    start = index + match[0].length;
  }
  parts.push(text.slice(start));
  return <>{parts}</>;
}

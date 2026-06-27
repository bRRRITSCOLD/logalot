// splitN replicates Go's strings.SplitN(s, sep, n): at most n parts, with the
// final part keeping any remaining separators. JS String.split(sep, n) instead
// DROPS the remainder, which would corrupt a secret that itself contained the
// separator — hence this helper. Shared by the API-key and refresh-token parsers
// (DRY), keeping both byte-compatible with the Go `strings.SplitN` they mirror.
export function splitN(s: string, sep: string, n: number): string[] {
  if (n <= 0) {
    return [];
  }
  const out: string[] = [];
  let rest = s;
  while (out.length < n - 1) {
    const idx = rest.indexOf(sep);
    if (idx === -1) {
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

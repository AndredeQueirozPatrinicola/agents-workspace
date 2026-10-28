/**
 * Parallel-development safety heuristics. These checks are advisory: they
 * surface risks (overlapping scopes, sensitive files, likely conflicts) for
 * a human to decide on. Nothing here resolves conflicts automatically.
 */

/** Static prefix of a glob (the part before the first wildcard), normalized. */
export function globPrefix(glob: string): string {
  const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const index = normalized.search(/[*?[{]/);
  const prefix = index === -1 ? normalized : normalized.slice(0, index);
  return prefix;
}

/**
 * Conservative overlap test for two globs: they may match a common file when
 * one static prefix contains the other at a path-segment boundary.
 * (`src/api/**` vs `src/api/users.ts` -> overlap; `src/api/**` vs `src/web/**` -> none.)
 */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = globPrefix(a);
  const pb = globPrefix(b);
  const hasWildA = pa.length !== a.replace(/\\/g, '/').replace(/^\.\//, '').length;
  const hasWildB = pb.length !== b.replace(/\\/g, '/').replace(/^\.\//, '').length;
  if (!hasWildA && !hasWildB) return pa === pb;
  const within = (longer: string, shorter: string, shorterIsGlob: boolean) =>
    longer.startsWith(shorter) && (shorterIsGlob || longer === shorter || shorter.endsWith('/') || longer[shorter.length] === '/');
  return within(pa, pb, hasWildB) || within(pb, pa, hasWildA);
}

export interface ScopeOverlap {
  a: string;
  b: string;
  patterns: Array<[string, string]>;
}

export function findScopeOverlaps(scopes: Record<string, string[]>): ScopeOverlap[] {
  const names = Object.keys(scopes).sort();
  const overlaps: ScopeOverlap[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i] as string;
      const b = names[j] as string;
      const patterns: Array<[string, string]> = [];
      for (const ga of scopes[a] ?? []) for (const gb of scopes[b] ?? []) if (globsMayOverlap(ga, gb)) patterns.push([ga, gb]);
      if (patterns.length) overlaps.push({ a, b, patterns });
    }
  }
  return overlaps;
}

/** Convert a glob to a RegExp (supports **, *, ?, and {a,b}). */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i] as string;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const slash = g[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      const end = g.indexOf('}', i);
      if (end === -1) re += '\\{';
      else {
        re += `(?:${g.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      }
    } else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  // A pattern ending in "/" or naming a directory also matches its contents.
  return new RegExp(`^${re}${g.endsWith('/') ? '.*' : '(?:/.*)?'}$`);
}

export function matchesAny(file: string, globs: string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(file));
}

const SENSITIVE_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$|sample$|template$|dist$)[^/]+$/,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.pypirc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)credentials(\.json)?$/i,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.agent-workspace\//,
  /(^|\/)\.agents\/.*\.local\.(ya?ml|json)$/,
];

export function isSensitivePath(file: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((re) => re.test(file.replace(/\\/g, '/')));
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: 'OpenAI API key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{32,}\b/ },
  { name: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

export interface SecretFinding {
  file: string;
  kind: string;
}

/** Best-effort secret scan of added lines. Not a replacement for a dedicated scanner. */
export function scanForSecrets(lines: Array<{ file: string; line: string }>): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  for (const { file, line } of lines) {
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(line) && !seen.has(`${file}:${name}`)) {
        seen.add(`${file}:${name}`);
        findings.push({ file, kind: name });
      }
    }
  }
  return findings;
}

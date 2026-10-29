// A remote URL's identity for "is this the fork?": host/owner/repo, lowercased. Only forms whose
// trust is equivalent get the same key: https on the default port, and ssh as git@host:owner/repo or
// ssh://git@host[:22]/owner/repo. Anything else (http, git://, file://, other ports, other ssh users,
// non-ASCII or malformed hosts, encoded or dotted path segments, queries) returns null, which never
// matches a fork.
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeRemoteUrl(url) {
  const s = String(url ?? '').trim();
  // Printable ASCII only; no whitespace, backslashes, percent-encoding, queries or fragments.
  if (!s || /[^\x21-\x7e]|[\\%?#]/.test(s)) return null;
  let host;
  let rest;
  let m;
  if ((m = /^https:\/\/(?:[^@/]+@)?([^/@:]+)(?::(\d+))?\/(.+)$/i.exec(s))) {
    if (m[2] !== undefined && m[2] !== '443') return null;
    [, host, , rest] = m;
  } else if ((m = /^ssh:\/\/(?:([^@/:]+)@)?([^/@:]+)(?::(\d+))?\/(.+)$/i.exec(s))) {
    if ((m[1] !== undefined && m[1] !== 'git') || (m[3] !== undefined && m[3] !== '22')) return null;
    [, , host, , rest] = m;
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && (m = /^(?:([^@/:]+)@)?([^@/:]{2,}):(?!\/\/)(.+)$/.exec(s))) {
    if (m[1] !== undefined && m[1] !== 'git') return null;
    [, , host, rest] = m;
  } else {
    return null;
  }
  host = host.toLowerCase();
  if (!HOST.test(host)) return null;
  // One trailing slash and a ".git" suffix on the repository name are allowed. An empty segment ("//") or a bare
  // ".git" segment is refused rather than dropped: git sends the path as given, and on a path-based server
  // ".../repo/.git" can be another repository (finding M-3).
  const parts = rest.replace(/\/$/, '').replace(/(?<=[^/])\.git$/i, '').split('/');
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && !p.includes('..'))) return null;
  // Lowercased: the key assumes a host whose owner and repository names are case-insensitive, as on GitHub. On a
  // case-sensitive host Owner/Repo and owner/repo would share a key.
  return `${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

// Does this remote URL name the repository owner/repo, in ANY form git can hand a hook? Deliberately looser
// than normalizeRemoteUrl, because it is used to REFUSE: any scheme (https, http, git, ssh, scp-like, file),
// any user, password or port, any host, any case, with or without ".git" or a trailing slash, with empty or
// "." path segments and percent-encoding ignored. Only the first two path segments are compared, so a
// near-miss that git would still send to that repository is not missed. `ownerRepo` is "owner/repo".
export function namesRepository(url, ownerRepo) {
  const want = String(ownerRepo ?? '').toLowerCase().replace(/\.git$/, '');
  const s = String(url ?? '').trim();
  if (!want || !s) return false;
  let pathPart;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(.*)$/i.exec(s);
  if (scheme) pathPart = scheme[2];
  else {
    const colon = s.indexOf(':');
    const slash = s.indexOf('/');
    pathPart = colon >= 0 && (slash < 0 || colon < slash) ? s.slice(colon + 1) : s;
  }
  let decoded = pathPart.replace(/\\/g, '/');
  try { decoded = decodeURIComponent(decoded); } catch { /* keep the raw text */ }
  const segs = decoded.split('/').filter((p) => p !== '' && p !== '.');
  if (segs.length < 2) return false;
  return `${segs[0]}/${segs[1].replace(/\.git$/i, '')}`.toLowerCase() === want;
}

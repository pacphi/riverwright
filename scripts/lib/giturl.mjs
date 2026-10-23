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
  const parts = rest.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2 || !parts.every((p) => SEGMENT.test(p) && !p.includes('..'))) return null;
  return `${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

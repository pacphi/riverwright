export function normalizeRemoteUrl(url) {
  const s = String(url ?? '').trim();
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/?$/i.exec(s);
  if (!m) m = /^(?:[^@\s/\\]+@)?([^:/\\\s]{2,}):(?!\/\/)(.+?)\/?$/.exec(s);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const parts = m[2].replace(/\.git$/i, '').split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return `${host}/${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const detectEol = (s) => (String(s).includes('\r\n') ? '\r\n' : '\n');
export const toLf = (s) => String(s).replace(/\r\n/g, '\n');
export const fromLf = (s, eol) => (eol === '\r\n' ? String(s).replace(/\n/g, '\r\n') : String(s));

export function readTextIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function resolveWriteTarget(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return p;
    throw e;
  }
  if (!st.isSymbolicLink()) return p;
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  }
}

export function writeFileAtomic(p, data, { mode } = {}) {
  const target = resolveWriteTarget(p);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  let existingMode;
  try {
    existingMode = fs.statSync(target).mode & 0o777;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: mode ?? existingMode ?? 0o644 });
    if (mode === undefined && existingMode !== undefined) fs.chmodSync(tmp, existingMode);
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return target;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';

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

// Writes via a temp file and rename. A symlink at `p` is refused unless the caller has vetted it and
// passes followSymlink; even then a link to a missing file is refused rather than creating its target.
export function writeFileAtomic(p, data, { mode, followSymlink = false } = {}) {
  let target = p;
  let st = null;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (st?.isSymbolicLink()) {
    if (!followSymlink) throw new RiverwrightError('SYMLINK', `${p} is a symbolic link; refusing to write through it`);
    try {
      target = fs.realpathSync(p);
    } catch {
      throw new RiverwrightError('SYMLINK', `${p} links to a file that does not exist; refusing to create it`);
    }
  }
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

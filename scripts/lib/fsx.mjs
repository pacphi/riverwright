import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RiverwrightError } from './errors.mjs';

export const detectEol = (s) => (String(s).includes('\r\n') ? '\r\n' : '\n');
export const toLf = (s) => String(s).replace(/\r\n/g, '\n');
export const fromLf = (s, eol) => (eol === '\r\n' ? String(s).replace(/\n/g, '\r\n') : String(s));

// Missing, or unreachable because a folder on the path is a regular file (ENOTDIR), reads as null.
export function readTextIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
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

// Files whose size cannot be trusted (git internals, hooks) are read through here. The file must be a regular file (a symlink to one is fine) of at
// most `cap` bytes, checked before it is opened and again on the open descriptor; it is opened without blocking (a FIFO
// opened by mistake does not wait for a writer) and read for at most `cap` bytes. Returns the text, or null when it
// does not exist. Anything else (a FIFO, a device, a socket, a directory, an oversized file) throws, and the caller
// treats the file as unreadable: git is then not trusted, which fails closed and never waits.
export function readBounded(file, cap) {
  let st;
  try { st = fs.statSync(file); } catch (err) { if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null; throw err; }
  const regular = (s) => s.isFile() && s.size <= cap;
  if (!regular(st)) throw new Error(`not a regular file of at most ${cap} bytes: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOCTTY ?? 0));
  try {
    const fst = fs.fstatSync(fd);
    if (!regular(fst)) throw new Error(`not a regular file of at most ${cap} bytes: ${file}`);
    // The buffer is the file's size plus one byte: a file that grew since the check fails closed.
    const buf = Buffer.alloc(fst.size + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= fst.size; n += got) got = fs.readSync(fd, buf, n, fst.size + 1 - n, null);
    if (n > fst.size) throw new Error(`changed while it was read: ${file}`);
    return buf.toString('utf8', 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

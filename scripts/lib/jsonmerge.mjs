import { isDeepStrictEqual } from 'node:util';
import { RiverwrightError } from './errors.mjs';
import { detectEol, fromLf } from './fsx.mjs';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const getPath = (obj, p) => p.reduce((o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), obj);

export function parseJsonStrict(text) {
  const t = String(text);
  try {
    return JSON.parse(t.charCodeAt(0) === 0xfeff ? t.slice(1) : t);
  } catch (e) {
    throw new RiverwrightError('JSON_UNPARSEABLE', `not strict JSON (comments or a syntax error): ${e.message}`);
  }
}

function addWalk(dst, src, trail, added) {
  for (const [k, v] of Object.entries(src)) {
    const p = [...trail, k];
    if (!Object.hasOwn(dst, k)) {
      dst[k] = structuredClone(v);
      added.push(p);
    } else if (isPlain(dst[k]) && isPlain(v)) {
      addWalk(dst[k], v, p, added);
    }
  }
}

export function addAbsentKeys(target, additions) {
  if (!isPlain(target)) throw new RiverwrightError('JSON_NOT_OBJECT', 'the settings file does not contain a JSON object');
  const result = structuredClone(target);
  const added = [];
  addWalk(result, additions, [], added);
  return { result, added };
}

function removeIfOurs(container, key, want, p, removed) {
  if (!isPlain(container) || !Object.hasOwn(container, key)) return;
  const have = container[key];
  if (isDeepStrictEqual(have, want)) {
    delete container[key];
    removed.push(p);
    return;
  }
  if (isPlain(have) && isPlain(want)) {
    for (const k of Object.keys(want)) removeIfOurs(have, k, want[k], [...p, k], removed);
    if (Object.keys(have).length === 0) {
      delete container[key];
      removed.push(p);
    }
  }
}

export function removeAddedKeys(target, addedPaths, additions) {
  const result = structuredClone(target);
  const removed = [];
  const deepestFirst = [...addedPaths].sort((a, b) => b.length - a.length);
  for (const p of deepestFirst) removeIfOurs(getPath(result, p.slice(0, -1)), p.at(-1), getPath(additions, p), p, removed);
  return { result, removed };
}

export function formatJsonLike(originalText, obj) {
  const src = String(originalText ?? '');
  const bom = src.charCodeAt(0) === 0xfeff ? '﻿' : '';
  const body = bom ? src.slice(1) : src;
  const indent = /\n([ \t]+)"/.exec(body.replace(/\r\n/g, '\n'))?.[1] ?? '  ';
  const eol = body ? detectEol(body) : '\n';
  const finalNewline = body === '' || /\n$/.test(body);
  return bom + fromLf(`${JSON.stringify(obj, null, indent)}${finalNewline ? '\n' : ''}`, eol);
}

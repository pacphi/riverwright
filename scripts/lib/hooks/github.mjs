// GitHub-specific rules for the hook classifier: gh subcommands, gh api, HTTP clients writing to GitHub,
// and inline interpreter code that reaches GitHub or runs git/gh. None of these recurse into shell text.
import { unCaret, isDynamic } from './shell.mjs';

export const outward = (rule, detail) => ({ outward: true, rule, detail });
export const unresolvable = (detail) => outward('unresolvable', detail);
export const nameOf = (w) => unCaret(w?.value ?? '');

const GH_OUTWARD = {
  pr: ['create', 'ready', 'comment', 'edit', 'merge', 'close', 'reopen', 'review', 'lock', 'unlock', 'update-branch', 'revert'],
  issue: ['create', 'comment', 'edit', 'close', 'reopen', 'transfer', 'delete', 'lock', 'unlock', 'pin', 'unpin', 'develop'],
  repo: ['fork', 'create', 'delete', 'edit', 'rename', 'archive', 'unarchive', 'sync', 'deploy-key', 'autolink'],
  release: ['create', 'upload', 'edit', 'delete', 'delete-asset'],
  gist: ['create', 'edit', 'delete', 'rename'],
  secret: ['set', 'delete', 'remove'],
  variable: ['set', 'delete'],
  label: ['create', 'edit', 'delete', 'clone'],
  workflow: ['run', 'enable', 'disable'],
  run: ['rerun', 'cancel', 'delete'],
  cache: ['delete'],
  project: ['create', 'edit', 'delete', 'close', 'copy', 'field-create', 'field-delete', 'item-add', 'item-archive', 'item-create', 'item-delete', 'item-edit', 'link', 'unlink', 'mark-template'],
  'ssh-key': ['add', 'delete'],
  'gpg-key': ['add', 'delete'],
  codespace: ['create', 'delete', 'edit'],
  'agent-task': ['create'],
};
const GH_KNOWN = new Set([...Object.keys(GH_OUTWARD), 'alias', 'api', 'attestation', 'auth', 'browse', 'co', 'completion', 'config', 'copilot',
  'extension', 'ext', 'help', 'org', 'preview', 'ruleset', 'search', 'status', 'version', 'accessibility']);
const GITHUB_HOST = /(?:^|[/@.])(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com)(?:[:/]|$)/i;

// Inline code (node -e, python -c, ...) is not shell; these catch GitHub API use and spawned git/gh.
const CODE_API = /api\.github\.com|uploads\.github\.com|\bgraphql\b|octokit|github\.com\/[^\s'"`]+\/[^\s'"`]+\/(?:pulls|issues|releases|git\/refs)/i;
const CODE_GIT = /\bgit\b[^\n;]{0,80}?\b(?:push|send-pack|http-push)\b/i;
const CODE_GH = /\bgh\b[^\n;]{0,60}?\b(?:pr|issue|repo|api|release|gist|workflow|alias|extension|ext|auth)\b/i;
const CODE_SPAWN = /child_process|\bexec(?:Sync|File|FileSync)?\s*\(|\bspawn(?:Sync)?\s*\(|subprocess|\bos\.(?:system|popen|exec\w*)|\bpopen\b|\bsystem\s*\(|IO\.popen|Open3|%x[({[]|\bqx\b|Deno\.(?:run|Command)|Bun\.spawn|ProcessBuilder|Runtime\.getRuntime/;
const CODE_SUSPECT = /\bgit\b|\bgh\b|base64|atob\s*\(|fromCharCode|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|b64decode|codecs\.decode|\bchr\s*\(|process\.env|os\.environ|\bENV\[|sys\.stdin|process\.stdin/i;

export function codeLooksOutward(code) {
  const s = String(code);
  return CODE_API.test(s) || CODE_GIT.test(s) || CODE_GH.test(s) || (CODE_SPAWN.test(s) && CODE_SUSPECT.test(s));
}

function classifyGhApi(args, ctx) {
  let method = null;
  let methodDynamic = false;
  let fields = false;
  let fromFile = false;
  const texts = [];
  let endpoint = null;
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const t = nameOf(w);
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      const takeValue = () => (eq === -1 ? args[++i] : { value: t.slice(eq + 1), dynamic: isDynamic(w) });
      if (name === '--method') { const v = takeValue(); method = nameOf(v).toLowerCase(); methodDynamic = isDynamic(v); }
      else if (name === '--field' || name === '--raw-field') { const v = takeValue(); fields = true; texts.push(v); if (name === '--field' && /^[^=]*=@/.test(nameOf(v))) fromFile = true; }
      else if (name === '--input') { takeValue(); fields = true; fromFile = true; }
      else if (['--header', '--jq', '--template', '--preview', '--hostname', '--cache'].includes(name) && eq === -1) i += 1;
      continue;
    }
    if (/^-[A-Za-z]/.test(t)) {
      for (let k = 1; k < t.length; k += 1) {
        const ch = t[k];
        if (!'XfFHpqt'.includes(ch)) continue;
        let v = { value: t.slice(k + 1), dynamic: isDynamic(w) };
        if (v.value === '') v = args[++i] ?? { value: '' };
        if (ch === 'X') { method = nameOf(v).toLowerCase(); methodDynamic = isDynamic(v); }
        if (ch === 'f' || ch === 'F') { fields = true; texts.push(v); if (ch === 'F' && /^[^=]*=@/.test(nameOf(v))) fromFile = true; }
        break;
      }
      continue;
    }
    if (endpoint === null) endpoint = w;
  }
  if (methodDynamic && ctx.strict) return unresolvable('the gh api method is a variable or substitution');
  const graphql = /(?:^|\/)graphql\/?$/i.test(nameOf(endpoint ?? { value: '' }));
  if (graphql && (fromFile || texts.some((v) => /mutation/i.test(nameOf(v)) || isDynamic(v)))) return outward('gh-api-graphql', 'gh api graphql mutation');
  if (method && !['get', 'head'].includes(method)) return outward('gh-api-write', `gh api ${method.toUpperCase()}`);
  if (!method && fields) return outward('gh-api-write', 'gh api with fields (sent as POST)');
  return null;
}

export function classifyGh(args, ctx) {
  const words = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = nameOf(args[i]);
    if (t === '-R' || t === '--repo') { i += 1; continue; }
    if (!t.startsWith('-')) words.push(args[i]);
  }
  const [areaWord, actionWord] = words;
  if (!areaWord) return null;
  if (isDynamic(areaWord)) return ctx.strict ? unresolvable('the gh command is a variable or substitution') : null;
  const area = nameOf(areaWord).toLowerCase();
  if (area !== 'api' && actionWord && isDynamic(actionWord)) return ctx.strict ? unresolvable(`the gh ${area} action is a variable or substitution`) : null;
  const action = actionWord ? nameOf(actionWord).toLowerCase() : undefined;
  if (area === 'auth') {
    if (['token', 'login', 'refresh', 'setup-git', 'switch'].includes(action)) return outward(`gh-auth-${action}`, `gh auth ${action}`);
    if (args.some((w) => ['--show-token', '-t'].includes(nameOf(w)))) return outward('gh-auth-token', 'printing the GitHub token');
    return null;
  }
  if (GH_OUTWARD[area]?.includes(action)) return outward(`gh-${area}-${action}`, `gh ${area} ${action}`);
  if (area === 'alias' && action && action !== 'list') return outward('gh-alias', `gh alias ${action} can make any gh word publish`);
  if ((area === 'extension' || area === 'ext') && action && !['list', 'ls', 'search', 'browse'].includes(action)) return outward('gh-extension', `gh extension ${action}`);
  if (area === 'api') return classifyGhApi(args.slice(args.indexOf(areaWord) + 1), ctx);
  if (!GH_KNOWN.has(area) && !area.startsWith('-') && ctx.strict) return outward('gh-unknown-command', `gh ${area} could be an alias or extension`);
  return null;
}

export function classifyHttp(prog, args, ctx) {
  let write = false;
  let method = null;
  let get = false;
  const urls = [];
  const setMethod = (v) => { method = nameOf(v).toUpperCase(); if (isDynamic(v)) method = '$'; };
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i];
    const t = nameOf(w);
    if (prog === 'curl') {
      if (t.startsWith('--')) {
        const eq = t.indexOf('=');
        const name = eq === -1 ? t : t.slice(0, eq);
        const val = () => (eq === -1 ? args[++i] : { value: t.slice(eq + 1), dynamic: isDynamic(w) });
        if (name === '--request') setMethod(val());
        else if (/^--(data|data-raw|data-binary|data-urlencode|data-ascii|json|form|form-string|upload-file)$/.test(name)) { write = true; if (eq === -1) i += 1; }
        else if (name === '--url') urls.push(val());
        else if (name === '--get') get = true;
        else if (eq === -1 && /^--(header|output|user|user-agent|cookie|cookie-jar|config|referer|max-time|connect-timeout|proxy|cert|key|cacert|write-out|range|retry|resolve|connect-to|oauth2-bearer)$/.test(name)) i += 1;
        continue;
      }
      if (/^-[A-Za-z0-9]/.test(t)) {
        for (let k = 1; k < t.length; k += 1) {
          const ch = t[k];
          if (ch === 'G') get = true;
          if (!'AbcCdDeEFHKmoPQrtTuUwxXyYz'.includes(ch)) continue;
          let v = { value: t.slice(k + 1), dynamic: isDynamic(w) };
          if (v.value === '') v = args[++i] ?? { value: '' };
          if (ch === 'X') setMethod(v);
          if ('dFT'.includes(ch)) write = true;
          break;
        }
        continue;
      }
      urls.push(w);
    } else if (prog === 'wget') {
      if (/^--(post-data|post-file|body-data|body-file)(=|$)/.test(t)) { write = true; if (!t.includes('=')) i += 1; }
      else if (t.startsWith('--method')) setMethod(t.includes('=') ? { value: t.slice(t.indexOf('=') + 1), dynamic: isDynamic(w) } : args[++i]);
      else if (!t.startsWith('-')) urls.push(w);
    } else {
      if (['--form', '-f', '--multipart', '--raw'].includes(t)) write = true;
      else if (['--auth', '-a', '--output', '-o', '--session', '--verify', '--cert', '--cert-key', '--proxy', '--timeout', '--print', '-p', '--method', '-m'].includes(t)) {
        if (t === '--method' || t === '-m') setMethod(args[i + 1] ?? { value: '' });
        i += 1;
      } else if (!t.startsWith('-')) {
        if (!urls.length && !method && /^(get|post|put|patch|delete|head|options)$/i.test(t)) setMethod(w);
        else if (!urls.length) urls.push(w);
        else if (/^[^=:@]+(?::=@|:=|=@|@|=)/.test(t) && !/^[^=:]+==/.test(t)) write = true;
      }
    }
  }
  const writes = (write && !get) || (method !== null && !['GET', 'HEAD'].includes(method));
  if (!writes) return null;
  if (method === '$' || urls.some(isDynamic) || !urls.length) return ctx.strict ? unresolvable(`the ${prog} target or method is a variable or substitution`) : null;
  const hit = urls.find((u) => GITHUB_HOST.test(nameOf(u)));
  return hit ? outward('http-write-github', `${prog} sending data to ${nameOf(hit)}`) : null;
}

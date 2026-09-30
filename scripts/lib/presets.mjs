import { UpfError } from './errors.mjs';

// Spec §5.2.
export const PRESETS = Object.freeze({
  frugal: { reproRuns: 2, fixAttempts: 2, reviewRounds: 1, candidates: 1, container: 'repo-ships', crossVendorReviewer: 'if-available' },
  balanced: { reproRuns: 3, fixAttempts: 3, reviewRounds: 2, candidates: 1, container: 'signals', crossVendorReviewer: 'if-available' },
  thorough: { reproRuns: 5, fixAttempts: 5, reviewRounds: 3, candidates: 3, container: 'always', crossVendorReviewer: 'required' },
});

export function preset(name) {
  const p = PRESETS[name];
  if (!p) throw new UpfError('UNKNOWN_PRESET', `unknown preset "${name}" (use frugal, balanced or thorough)`);
  return p;
}

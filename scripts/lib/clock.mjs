// RIVERWRIGHT_NOW pins recorded times for the test suite only (RIVERWRIGHT_TEST=1). Anywhere else, every recorded time
// is the real clock, so an agent cannot backdate approvals, ledger events or evidence.
export function nowIso(env = {}) {
  return env.RIVERWRIGHT_TEST === '1' && env.RIVERWRIGHT_NOW ? String(env.RIVERWRIGHT_NOW) : new Date().toISOString();
}

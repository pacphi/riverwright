// Every recorded time is the real clock, so an agent cannot backdate approvals, ledger events or evidence.
// The test suite pins it through io.testing.now, which only the in-process test helper supplies:
// scripts/riverwright.mjs never sets io.testing, so no environment variable or flag reaches this seam.
// Pass the whole io object (not io.env), so an environment variable can never be read as the pin.
export function nowIso(io) {
  const pinned = io?.testing?.now;
  return pinned ? String(pinned) : new Date().toISOString();
}

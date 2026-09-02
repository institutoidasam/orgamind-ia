/**
 * Parse a numeric tunable from `process.env` with a safe fallback.
 *
 * `Number(process.env.X ?? default)` silently yields `NaN` when X is set to a
 * non-numeric value (typo, empty string, "true", …). Downstream that NaN
 * becomes `setTimeout(resolve, NaN)` ≈ 0ms or a `concurrency: NaN` worker —
 * i.e. the anti-ban pacing is silently DISABLED with no error. This helper
 * validates with `Number.isFinite` and falls back (with a warning) instead, so
 * a misconfigured env can never quietly turn pacing off.
 *
 * @param raw      the raw env value (`process.env.SOMETHING`)
 * @param fallback the default to use when `raw` is unset or invalid
 * @param name     the env var name, used in the warning for diagnosability
 */
export function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;

  // `Number('')` and `Number('   ')` are 0 (finite) — treat a blank value as a
  // misconfiguration rather than silently meaning "0".
  const parsed = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    // Use console.warn rather than a Nest Logger: these tunables are read at
    // module-load time, before any DI container / logger config exists.
    console.warn(
      `[env-number] ${name}="${raw}" is not a finite number — falling back to ${fallback}. ` +
        `Anti-ban pacing relies on this value; fix the env var.`,
    );
    return fallback;
  }

  return parsed;
}

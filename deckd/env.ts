// deckd settings from the environment. DECKD_* is current; the pre-rename DESKD_* names still work for one
// release (with a warning) so existing service units and shells keep running.
const warned = new Set<string>();

export function env(name: string): string | undefined {
  const v = process.env[`DECKD_${name}`];
  if (v !== undefined) return v;
  const old = process.env[`DESKD_${name}`];
  if (old !== undefined && !warned.has(name)) {
    warned.add(name);
    console.warn(`deckd: DESKD_${name} is deprecated, use DECKD_${name}`);
  }
  return old;
}

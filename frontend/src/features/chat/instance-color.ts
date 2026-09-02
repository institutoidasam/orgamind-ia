/**
 * Deterministic per-instance accent color, shared by the inbox NÚMERO tabs
 * and the conversation-row instance badge so an operator can visually match
 * a conversation to the number it belongs to.
 *
 * Keyed by the instance id (NOT the display name — names are editable and
 * duplicated in prod). 8 mid-lightness hues, legible as small dots on both
 * the light and dark surface tokens.
 */
export const INSTANCE_PALETTE = [
  '#8b5cf6', // violet
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#14b8a6', // teal
  '#6366f1', // indigo
] as const;

export function instanceColor(key: string): string {
  // djb2 — tiny, stable, good spread for short id strings.
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return INSTANCE_PALETTE[Math.abs(h) % INSTANCE_PALETTE.length];
}

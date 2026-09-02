/**
 * Two-letter initials from a person's name. Falls back to the first
 * character if there's only one word, and to '?' if input is empty.
 * Used for avatars throughout the app.
 */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

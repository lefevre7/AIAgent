/**
 * Whether a completion summary only repeats text the operator has already
 * seen. A model often writes its answer as a message and then passes the same
 * words to `attempt_complete`, and both were shown: the answer twice in the
 * REPL, and "pong | pong" on WhatsApp. Compared ignoring case and spacing; a
 * summary that adds anything is still shown.
 */
export function repeatsShownText(summary: string, shown: string): boolean {
  const normalize = (text: string) => text.replace(/\s+/gu, " ").trim().toLowerCase();
  const normalizedSummary = normalize(summary);
  return normalizedSummary.length > 0 && normalize(shown).includes(normalizedSummary);
}

/** The parts of a panel embed that carry its text. */
export interface PanelText {
  title?: string | null;
  description?: string | null;
}

/**
 * Should a panel that is already posted be edited in place?
 * Yes when it has no embed, when Discord hides its embed (SuppressEmbeds), or when its
 * title or description differs from what this build would post (e.g. a new leave type).
 */
export function panelNeedsEdit(existing: PanelText[], suppressed: boolean, wanted: PanelText): boolean {
  const have = existing[0];
  if (!have || suppressed) return true;
  return (have.title ?? "") !== (wanted.title ?? "") || (have.description ?? "") !== (wanted.description ?? "");
}

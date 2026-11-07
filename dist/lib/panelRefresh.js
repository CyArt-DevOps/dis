/**
 * Should a panel that is already posted be edited in place?
 * Yes when it has no embed, when Discord hides its embed (SuppressEmbeds), or when its
 * title or description differs from what this build would post (e.g. a new leave type).
 */
export function panelNeedsEdit(existing, suppressed, wanted) {
    const have = existing[0];
    if (!have || suppressed)
        return true;
    return (have.title ?? "") !== (wanted.title ?? "") || (have.description ?? "") !== (wanted.description ?? "");
}
//# sourceMappingURL=panelRefresh.js.map
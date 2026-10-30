// What the bot says after an intern acknowledges a warning. The reminder follows the warning's kind
// (Warn.kind: hours | conduct | other), so a conduct or EMS warning never mentions attendance.
const REMINDER: Record<string, string> = {
  hours: "Please make sure to follow the attendance rules from now on.",
  conduct: "Please make sure to follow the code of conduct from now on.",
};

/** Pure. The follow-up message for an acknowledged warning. */
export function ackFollowUp(w: { id: number; kind?: string | null }, late: boolean): string {
  const reminder = REMINDER[w.kind ?? ""] ?? "Please make sure it does not happen again.";
  return `Thank you. Warning #${w.id} is acknowledged${late ? " (after the deadline)" : ""}. ${reminder}`;
}

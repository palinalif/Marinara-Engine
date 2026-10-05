// Row bookkeeping for the Chat Variables section.
//
// Also owns the patch each save sends, so the payloads can be tested without a
// browser.
//
// Kept apart from the component because the reconciliation below is the part
// that can lose a user's typing, and it is worth testing on its own.

import { validateChatVariableName, type ChatVariableNameIssue } from "@marinara-engine/shared";

export interface VariableRow {
  /** Stable key so a rename does not remount the row and drop focus. */
  key: string;
  name: string;
  value: string;
  /** The name this row is saved under, or null while it is still a draft. */
  savedName: string | null;
  /** The value last known to be saved, so an in-progress edit is recognizable. */
  savedValue: string | null;
}

export const isRowEdited = (row: VariableRow) => row.name !== row.savedName || row.value !== row.savedValue;

/**
 * Whether this row's name blocks saving.
 *
 * The creation-time rules only apply to a name being created or renamed. A name
 * already in the chat keeps whatever shape `{{setvar}}` gave it — `story.day`,
 * `my-var` — and its value stays editable, which is what the metadata route
 * permits. Renaming such a row to another loose name is still refused.
 */
export function rowNameIssue(row: VariableRow, otherRows: VariableRow[]): ChatVariableNameIssue | null {
  const name = row.name.trim();
  if (row.savedName !== null && name === row.savedName) return null;
  return validateChatVariableName(
    name,
    otherRows.filter((other) => other.key !== row.key).map((other) => other.name.trim()),
  );
}

let rowKeySeed = 0;
export const nextRowKey = () => `chat-variable-${(rowKeySeed += 1)}`;

export function toRows(variables: Record<string, string>): VariableRow[] {
  return Object.entries(variables)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => ({ key: nextRowKey(), name, value, savedName: name, savedValue: value }));
}

export const newDraftRow = (): VariableRow => ({
  key: nextRowKey(),
  name: "",
  value: "",
  savedName: null,
  savedValue: null,
});

/**
 * Fold the saved map into the rows on screen without discarding typing.
 *
 * A row the user has edited since its last commit keeps what they typed; only
 * its saved snapshot is refreshed. Untouched rows adopt the saved value, which
 * is how a {{setvar}} from a generation shows up, and names that vanished
 * elsewhere drop out. Names with no row yet are appended, drafts stay last.
 *
 * Replacing the rows outright instead would discard an edit made while an
 * earlier save was still in flight, because that save's completion is what
 * triggers the fold.
 */
export function reconcileRows(current: VariableRow[], saved: Record<string, string>): VariableRow[] {
  const reconciled: VariableRow[] = [];
  const covered = new Set<string>();
  for (const row of current) {
    if (row.savedName === null) continue; // drafts keep their place at the end
    const savedValue = Object.prototype.hasOwnProperty.call(saved, row.savedName) ? saved[row.savedName] : undefined;
    const edited = isRowEdited(row);
    if (savedValue === undefined) {
      // Gone from the chat. Keep the row only while the user is mid-edit, so a
      // deletion elsewhere cannot swallow what they are typing.
      if (!edited) continue;
      covered.add(row.savedName);
      reconciled.push(row);
      continue;
    }
    covered.add(row.savedName);
    reconciled.push(edited ? { ...row, savedValue } : { ...row, name: row.savedName, value: savedValue, savedValue });
  }
  for (const [name, value] of Object.entries(saved)) {
    if (covered.has(name)) continue;
    reconciled.push({ key: nextRowKey(), name, value, savedName: name, savedValue: value });
  }
  return [...reconciled, ...current.filter((row) => row.savedName === null)];
}

/**
 * The name a row's next write must replace.
 *
 * `savedName` is the name the server has confirmed, which is stale while an
 * earlier write for the same row is still queued: renaming `char1` to `lead`
 * and then to `hero` would otherwise send two patches that both delete `char1`,
 * leaving `lead` behind as an orphan. `pendingName` is the name the last queued
 * write will establish, and it wins whenever one is outstanding.
 */
export const effectiveSavedName = (row: VariableRow, pendingName: string | null | undefined) =>
  pendingName !== undefined ? pendingName : row.savedName;

/** The patch that commits a row, dropping the name it replaces in the same write. */
export function buildCommitPatch(
  name: string,
  value: string,
  previousName: string | null,
): Record<string, string | null> {
  return previousName && previousName !== name ? { [previousName]: null, [name]: value } : { [name]: value };
}

/** The patch that removes a row, targeting whatever name it currently occupies. */
export function buildRemovePatch(previousName: string | null): Record<string, string | null> | null {
  return previousName ? { [previousName]: null } : null;
}

// The Chat Variables editor folds saved values into its rows when a save
// settles. That fold must not throw away what the user typed in the meantime.
import assert from "node:assert/strict";
import {
  buildCommitPatch,
  buildRemovePatch,
  effectiveSavedName,
  newDraftRow,
  reconcileRows,
  rowNameIssue,
  toRows,
  type VariableRow,
} from "../../packages/client/src/features/chat-settings/sections/chat-variables-rows.js";

const byName = (rows: VariableRow[], name: string) => rows.find((row) => row.name === name);

// An edit made while an earlier save was in flight survives the fold.
const editedDuringSave: VariableRow[] = [
  { key: "a", name: "char1", value: "Mary", savedName: "char1", savedValue: "Mary" },
  { key: "b", name: "char2", value: "Anna typing", savedName: "char2", savedValue: "Ana" },
];
const afterSave = reconcileRows(editedDuringSave, { char1: "Mary", char2: "Ana" });
assert.equal(byName(afterSave, "char2")!.value, "Anna typing", "an in-progress edit must not be overwritten");
assert.equal(byName(afterSave, "char2")!.savedValue, "Ana", "its saved snapshot still tracks the server");
assert.equal(byName(afterSave, "char1")!.value, "Mary");

// A rename in progress survives too, and is not mistaken for a new row.
const renaming: VariableRow[] = [{ key: "a", name: "lead", value: "Mary", savedName: "char1", savedValue: "Mary" }];
const afterRename = reconcileRows(renaming, { char1: "Mary" });
assert.equal(afterRename.length, 1, "the old name must not come back as a second row");
assert.equal(afterRename[0]!.name, "lead");
assert.equal(afterRename[0]!.savedName, "char1");

// An untouched row adopts a value changed elsewhere — this is how a {{setvar}}
// from a generation reaches the editor.
const untouched: VariableRow[] = [{ key: "a", name: "mood", value: "calm", savedName: "mood", savedValue: "calm" }];
const afterSetvar = reconcileRows(untouched, { mood: "tense" });
assert.equal(afterSetvar[0]!.value, "tense");
assert.equal(afterSetvar[0]!.savedValue, "tense");

// A name deleted elsewhere drops out when the row is clean...
assert.deepEqual(reconcileRows(untouched, {}), [], "a clean row for a deleted name disappears");

// ...but is kept while the user is mid-edit, so a background deletion cannot
// swallow their typing.
const editedThenDeleted: VariableRow[] = [
  { key: "a", name: "mood", value: "still typing", savedName: "mood", savedValue: "calm" },
];
const afterDelete = reconcileRows(editedThenDeleted, {});
assert.equal(afterDelete.length, 1);
assert.equal(afterDelete[0]!.value, "still typing");

// A failed save leaves the row unstamped, so the fold that follows the rolled
// back metadata keeps the typed value rather than reverting it.
const failedEdit: VariableRow[] = [{ key: "a", name: "char1", value: "Anna", savedName: "char1", savedValue: "Mary" }];
const afterFailure = reconcileRows(failedEdit, { char1: "Mary" });
assert.equal(afterFailure[0]!.value, "Anna", "a rejected write must not silently revert the row");
assert.equal(afterFailure[0]!.savedValue, "Mary", "the snapshot still reflects what is stored");

// A brand-new row whose save failed stays a draft instead of vanishing.
const failedNewRow: VariableRow[] = [{ ...newDraftRow(), name: "char9", value: "Nine" }];
const afterNewRowFailure = reconcileRows(failedNewRow, {});
assert.equal(afterNewRowFailure.length, 1, "a draft whose write failed is still on screen");
assert.equal(afterNewRowFailure[0]!.value, "Nine");

// Names with no row yet are appended, and drafts stay at the end.
const withDraft: VariableRow[] = [
  { key: "a", name: "char1", value: "Mary", savedName: "char1", savedValue: "Mary" },
  { ...newDraftRow(), name: "char3", value: "half typed" },
];
const withNewName = reconcileRows(withDraft, { char1: "Mary", mood: "tense" });
assert.deepEqual(
  withNewName.map((row) => row.name),
  ["char1", "mood", "char3"],
  "a variable set elsewhere is appended before the draft row",
);
assert.equal(withNewName.at(-1)!.savedName, null, "the draft is still a draft");

// toRows seeds a saved snapshot, so a freshly loaded row reads as unedited.
const seeded = toRows({ char1: "Mary" });
assert.equal(seeded[0]!.savedName, "char1");
assert.equal(seeded[0]!.savedValue, "Mary");
assert.deepEqual(
  reconcileRows(seeded, { char1: "Mary" }).map((row) => row.value),
  ["Mary"],
);

// Non-string values in stored metadata are ignored rather than rendered.
assert.deepEqual(
  toRows({ ok: "yes", bad: 7 as unknown as string }).map((row) => row.name),
  ["ok"],
);

// ── Queued writes must target the name the previous write establishes ──
// Requests are serialized but their patches are built up front, so a rename
// followed by another rename or a delete has to chase the pending name.
const renamed: VariableRow = { key: "a", name: "lead", value: "Mary", savedName: "char1", savedValue: "Mary" };

// Rename char1 -> lead, then lead -> hero before the first write settles.
assert.deepEqual(buildCommitPatch("lead", "Mary", effectiveSavedName(renamed, undefined)), {
  lead: "Mary",
  char1: null,
});
assert.deepEqual(
  buildCommitPatch("hero", "Mary", effectiveSavedName({ ...renamed, name: "hero" }, "lead")),
  { hero: "Mary", lead: null },
  "the second rename must drop `lead`, not `char1`, or `lead` is orphaned",
);

// Rename char1 -> lead, then delete the row while the rename is pending.
assert.deepEqual(
  buildRemovePatch(effectiveSavedName(renamed, "lead")),
  { lead: null },
  "the delete follows the rename",
);
assert.deepEqual(buildRemovePatch(effectiveSavedName(renamed, undefined)), { char1: null });
assert.equal(buildRemovePatch(effectiveSavedName(newDraftRow(), undefined)), null, "a draft has nothing to remove");

// A row whose pending write removed it carries a null claim.
assert.equal(effectiveSavedName(renamed, null), null);

// A legacy prototype-key name must be an own deletion entry in the JSON patch.
assert.deepEqual(JSON.parse(JSON.stringify(buildCommitPatch("lead", "Mary", "__proto__"))), {
  ["__proto__"]: null,
  lead: "Mary",
});

// A value-only commit does not delete anything.
assert.deepEqual(buildCommitPatch("char1", "Anna", "char1"), { char1: "Anna" });

// ── Names already stored by {{setvar}} stay editable ──
const legacy: VariableRow = { key: "a", name: "story.day", value: "4", savedName: "story.day", savedValue: "3" };
assert.equal(rowNameIssue(legacy, [legacy]), null, "a stored dotted name must accept a value edit");
assert.equal(rowNameIssue({ ...legacy, name: "my-var", savedName: "my-var" }, []), null, "dashed names too");
assert.equal(
  rowNameIssue({ ...legacy, name: "story.week" }, []),
  "format",
  "renaming a legacy name still has to produce an addressable name",
);
assert.equal(rowNameIssue({ ...legacy, name: "storyWeek" }, []), null, "renaming it to a valid name is allowed");
assert.equal(rowNameIssue({ ...newDraftRow(), name: "story.day" }, []), "format", "creating one is still refused");
assert.equal(rowNameIssue({ ...newDraftRow(), name: "char" }, []), "reserved");
assert.equal(
  rowNameIssue({ ...legacy, name: "char1" }, [{ ...newDraftRow(), name: "char1" }]),
  "duplicate",
  "a rename still collides with another row",
);

console.info("chat variables row reconciliation regressions passed.");

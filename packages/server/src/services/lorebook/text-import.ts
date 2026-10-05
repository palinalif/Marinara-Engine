// ──────────────────────────────────────────────
// Lorebook import from Markdown / CSV text.
// Parses with the shared parser (the same one the client previews with),
// plans duplicates, resolves folder paths, then writes through the normal
// entry create/update storage path.
// ──────────────────────────────────────────────
import {
  createLorebookEntrySchema,
  LOREBOOK_TEXT_MAX_CHARS,
  LOREBOOK_TEXT_MAX_ENTRIES,
  createLorebookFolderSchema,
  parseLorebookText,
  planLorebookTextImport,
  summarizeLorebookTextImport,
  updateLorebookEntrySchema,
  type LorebookEntry,
  type LorebookFolder,
  type LorebookTextDuplicateMode,
  type LorebookTextFormat,
  type LorebookTextIssue,
} from "@marinara-engine/shared";
import type { createLorebooksStorage } from "../storage/lorebooks.storage.js";

type LorebooksStorage = ReturnType<typeof createLorebooksStorage>;

/** Generous, but keeps a mistaken paste of a huge file from locking the store. */
export const LOREBOOK_TEXT_IMPORT_MAX_CHARS = LOREBOOK_TEXT_MAX_CHARS;
export const LOREBOOK_TEXT_IMPORT_MAX_ENTRIES = LOREBOOK_TEXT_MAX_ENTRIES;

export interface LorebookTextImportRequest {
  format: LorebookTextFormat;
  text: string;
  duplicateMode: LorebookTextDuplicateMode;
}

export interface LorebookTextImportResult {
  lorebookId: string;
  created: number;
  renamed: number;
  overwritten: number;
  skipped: number;
  invalid: number;
  foldersCreated: number;
  issues: LorebookTextIssue[];
}

export class LorebookTextImportError extends Error {}

export function readLorebookTextImportRequest(body: unknown): LorebookTextImportRequest {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const format = record.format === "csv" ? "csv" : record.format === "markdown" ? "markdown" : null;
  if (!format) throw new LorebookTextImportError("format must be markdown or csv");
  if (typeof record.text !== "string" || !record.text.trim()) throw new LorebookTextImportError("text is required");
  if (record.text.length > LOREBOOK_TEXT_IMPORT_MAX_CHARS) throw new LorebookTextImportError("text is too large");
  const duplicateMode =
    record.duplicateMode === "rename" || record.duplicateMode === "overwrite" ? record.duplicateMode : "skip";
  return { format, text: record.text, duplicateMode };
}

export async function importLorebookText(
  storage: LorebooksStorage,
  lorebookId: string,
  request: LorebookTextImportRequest,
): Promise<LorebookTextImportResult> {
  const parsed = parseLorebookText(request.format, request.text);
  const fileErrors = parsed.issues.filter((issue) => issue.severity === "error" && issue.entryIndex === null);
  if (fileErrors.length > 0) {
    throw new LorebookTextImportError(fileErrors.map((issue) => issue.code).join(", "));
  }
  const valid = parsed.entries.filter((entry) => !entry.invalid);
  if (valid.length === 0) throw new LorebookTextImportError("no valid entries");
  if (valid.length > LOREBOOK_TEXT_IMPORT_MAX_ENTRIES) throw new LorebookTextImportError("too many entries");

  const existing = (await storage.listEntries(lorebookId)) as LorebookEntry[];
  const actions = planLorebookTextImport(valid, existing, request.duplicateMode);

  // Folder paths resolve by name under each parent; missing folders are created once.
  const folders = (await storage.listFolders(lorebookId)) as LorebookFolder[];
  const folderIdByPath = new Map<string, string>();
  const pathOf = (folder: LorebookFolder, seen = new Set<string>()): string | null => {
    if (seen.has(folder.id)) return null;
    seen.add(folder.id);
    if (!folder.parentFolderId) return folder.name.trim().toLowerCase();
    const parent = folders.find((candidate) => candidate.id === folder.parentFolderId);
    const parentPath = parent ? pathOf(parent, seen) : null;
    return parentPath === null ? null : `${parentPath}/${folder.name.trim().toLowerCase()}`;
  };
  for (const folder of folders) {
    const path = pathOf(folder);
    if (path !== null && !folderIdByPath.has(path)) folderIdByPath.set(path, folder.id);
  }
  let foldersCreated = 0;
  const resolveFolder = async (segments: string[]): Promise<string | null> => {
    let parentId: string | null = null;
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment.toLowerCase()}` : segment.toLowerCase();
      let id = folderIdByPath.get(path);
      if (!id) {
        const created = (await storage.createFolder(
          lorebookId,
          createLorebookFolderSchema.parse({ name: segment.slice(0, 200), parentFolderId: parentId }),
        )) as LorebookFolder | null;
        if (!created) throw new Error("Failed to create folder");
        id = created.id;
        folderIdByPath.set(path, id);
        foldersCreated++;
      }
      parentId = id;
    }
    return parentId;
  };

  let nextOrder = existing.reduce((max, entry) => Math.max(max, entry.order ?? 0), 0);
  for (const action of actions) {
    if (action.kind === "skip") continue;
    const { entry } = action;
    const folderId = entry.folderPath.length > 0 ? await resolveFolder(entry.folderPath) : null;
    const fields = {
      keys: entry.keys,
      content: entry.content,
      enabled: entry.enabled,
      constant: entry.constant,
      probability: entry.probability,
    };
    if (action.kind === "overwrite") {
      // An entry without a folder in the file stays where it is.
      await storage.updateEntry(
        action.targetId,
        updateLorebookEntrySchema.parse({ ...fields, ...(folderId ? { folderId } : {}) }),
      );
    } else {
      nextOrder += 10;
      await storage.createEntry(
        createLorebookEntrySchema.parse({ ...fields, lorebookId, name: action.name, folderId, order: nextOrder }),
      );
    }
  }

  return {
    lorebookId,
    ...summarizeLorebookTextImport(actions),
    invalid: parsed.entries.length - valid.length,
    foldersCreated,
    issues: parsed.issues,
  };
}

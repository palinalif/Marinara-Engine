// ──────────────────────────────────────────────
// Lorebook text formats: Markdown and CSV import/export.
//
// Markdown:
//   # Lorebook name            (optional, before the first entry)
//   ## Entry name
//   Keys: a, b                 (optional metadata lines right after the heading;
//   Folder: Places / Harbor     also Enabled, Constant, Probability)
//
//   Body text...
//
// CSV: header row with name, keys, content and optional folder, enabled,
// constant, probability. Quoted cells, doubled quotes, multiline cells,
// a UTF-8 BOM and CRLF line endings are all accepted.
//
// Parsing is pure and shared so the client can preview exactly what the
// server will import.
// ──────────────────────────────────────────────

export type LorebookTextFormat = "markdown" | "csv";
export type LorebookTextDuplicateMode = "skip" | "rename" | "overwrite";

export const LOREBOOK_TEXT_MAX_NAME_LENGTH = 200;
export const LOREBOOK_TEXT_MAX_CHARS = 1024 * 1024;
export const LOREBOOK_TEXT_MAX_ENTRIES = 20_000;
/** Folder paths are written as "Parent / Child". */
export const LOREBOOK_TEXT_FOLDER_SEPARATOR = " / ";

export interface LorebookTextEntry {
  name: string;
  keys: string[];
  content: string;
  /** Folder path segments from the root, empty for root-level entries. */
  folderPath: string[];
  enabled: boolean;
  constant: boolean;
  probability: number | null;
}

export type LorebookTextIssueCode =
  | "missing_name"
  | "name_too_long"
  | "empty_content"
  | "invalid_boolean"
  | "invalid_probability"
  | "missing_columns"
  | "unknown_column"
  | "extra_cells"
  | "unterminated_quote"
  | "duplicate_in_file"
  | "no_entries"
  | "input_too_large"
  | "too_many_entries";

export interface LorebookTextIssue {
  severity: "error" | "warning";
  code: LorebookTextIssueCode;
  /** 1-based source line where the entry (or problem) starts. */
  line: number | null;
  /** Index into `entries`, or null for file-level issues. */
  entryIndex: number | null;
  /** Column name, bad value, or missing columns, depending on the code. */
  detail?: string;
}

export interface ParsedLorebookTextEntry extends LorebookTextEntry {
  line: number;
  /** True when this entry has at least one error and will not be imported. */
  invalid: boolean;
}

export interface ParsedLorebookText {
  format: LorebookTextFormat;
  /** The "# Title" of a Markdown file, if any. */
  title: string | null;
  entries: ParsedLorebookTextEntry[];
  issues: LorebookTextIssue[];
}

const TRUE_VALUES = new Set(["true", "yes", "y", "1", "on"]);
const FALSE_VALUES = new Set(["false", "no", "n", "0", "off"]);

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Splits a comma (or newline) separated key list, trimming and dropping blanks and repeats. */
export function splitLorebookTextKeys(raw: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function splitLorebookFolderPath(raw: string): string[] {
  return raw
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

type FieldIssue = { code: LorebookTextIssueCode; detail: string };

function parseBoolean(raw: string, fallback: boolean, column: string, issues: FieldIssue[]): boolean {
  const value = raw.trim().toLowerCase();
  if (!value) return fallback;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  issues.push({ code: "invalid_boolean", detail: `${column}: ${raw.trim()}` });
  return fallback;
}

function parseProbability(raw: string, issues: FieldIssue[]): number | null {
  const value = raw.trim().replace(/%$/, "").trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    issues.push({ code: "invalid_probability", detail: raw.trim() });
    return null;
  }
  return parsed;
}

interface RawEntryFields {
  name: string;
  keys: string;
  content: string;
  folder: string;
  enabled: string;
  constant: string;
  probability: string;
}

function buildEntry(fields: RawEntryFields): { entry: LorebookTextEntry; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const name = fields.name.trim();
  const entry: LorebookTextEntry = {
    name,
    keys: splitLorebookTextKeys(fields.keys),
    content: fields.content,
    folderPath: splitLorebookFolderPath(fields.folder),
    enabled: parseBoolean(fields.enabled, true, "enabled", issues),
    constant: parseBoolean(fields.constant, false, "constant", issues),
    probability: parseProbability(fields.probability, issues),
  };
  if (!name) issues.unshift({ code: "missing_name", detail: "" });
  else if (name.length > LOREBOOK_TEXT_MAX_NAME_LENGTH) issues.unshift({ code: "name_too_long", detail: "" });
  return { entry, issues };
}

const WARNING_CODES = new Set<LorebookTextIssueCode>([
  "empty_content",
  "unknown_column",
  "extra_cells",
  "duplicate_in_file",
]);

function finish(
  format: LorebookTextFormat,
  title: string | null,
  built: Array<{ entry: LorebookTextEntry; issues: FieldIssue[]; line: number }>,
  fileIssues: LorebookTextIssue[],
): ParsedLorebookText {
  const issues: LorebookTextIssue[] = [...fileIssues];
  const entries: ParsedLorebookTextEntry[] = [];
  const seenNames = new Map<string, number>();
  built.forEach(({ entry, issues: fieldIssues, line }, entryIndex) => {
    const entryIssues: LorebookTextIssue[] = fieldIssues.map((issue) => ({
      severity: WARNING_CODES.has(issue.code) ? "warning" : "error",
      code: issue.code,
      line,
      entryIndex,
      ...(issue.detail ? { detail: issue.detail } : {}),
    }));
    if (entry.name && !entry.content.trim()) {
      entryIssues.push({ severity: "warning", code: "empty_content", line, entryIndex });
    }
    const nameKey = entry.name.toLowerCase();
    if (entry.name) {
      const firstLine = seenNames.get(nameKey);
      if (firstLine !== undefined) {
        entryIssues.push({
          severity: "warning",
          code: "duplicate_in_file",
          line,
          entryIndex,
          detail: String(firstLine),
        });
      } else {
        seenNames.set(nameKey, line);
      }
    }
    issues.push(...entryIssues);
    entries.push({ ...entry, line, invalid: entryIssues.some((issue) => issue.severity === "error") });
  });
  if (entries.length === 0 && !issues.some((issue) => issue.severity === "error")) {
    issues.push({ severity: "error", code: "no_entries", line: null, entryIndex: null });
  }
  return { format, title, entries, issues };
}

// ── Markdown ──

const MARKDOWN_META = /^(keys|keywords|folder|enabled|constant|probability)\s*:\s*(.*)$/i;

/** Content lines that would read as a heading get one backslash on export; import removes it. */
function unescapeMarkdownLine(line: string): string {
  return /^\\+#/.test(line) ? line.slice(1) : line;
}

function escapeMarkdownLine(line: string): string {
  return /^\\*#/.test(line) ? `\\${line}` : line;
}

export function parseLorebookMarkdown(text: string): ParsedLorebookText {
  if (text.length > LOREBOOK_TEXT_MAX_CHARS) {
    return finish("markdown", null, [], [{ severity: "error", code: "input_too_large", line: null, entryIndex: null }]);
  }
  const lines = normalizeNewlines(stripBom(text)).split("\n");
  let title: string | null = null;
  const built: Array<{ entry: LorebookTextEntry; issues: FieldIssue[]; line: number }> = [];
  const fileIssues: LorebookTextIssue[] = [];
  let index = 0;

  // Preamble: an optional "# Title"; anything else before the first entry is ignored.
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^##(\s|$)/.test(line)) break;
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && title === null) title = heading[1]!.trim();
  }

  while (index < lines.length) {
    if (built.length >= LOREBOOK_TEXT_MAX_ENTRIES) {
      fileIssues.push({ severity: "error", code: "too_many_entries", line: index + 1, entryIndex: null });
      break;
    }
    const headingLine = index + 1;
    const name = lines[index]!.replace(/^##/, "")
      .replace(/\s+#+\s*$/, "")
      .trim();
    index++;
    const fields: RawEntryFields = {
      name,
      keys: "",
      content: "",
      folder: "",
      enabled: "",
      constant: "",
      probability: "",
    };
    while (index < lines.length && lines[index]!.trim() === "") index++;
    for (; index < lines.length; index++) {
      const meta = MARKDOWN_META.exec(lines[index]!);
      if (!meta) break;
      const label = meta[1]!.toLowerCase();
      const value = meta[2]!.trim();
      if (label === "keys" || label === "keywords") fields.keys = value;
      else fields[label as "folder" | "enabled" | "constant" | "probability"] = value;
    }
    const body: string[] = [];
    for (; index < lines.length; index++) {
      const line = lines[index]!;
      if (/^##(\s|$)/.test(line)) break;
      body.push(unescapeMarkdownLine(line));
    }
    fields.content = body
      .join("\n")
      .replace(/^\s*\n/, "")
      .trimEnd();
    const result = buildEntry(fields);
    built.push({ ...result, line: headingLine });
  }

  return finish("markdown", title, built, fileIssues);
}

// ── CSV ──

interface CsvRow {
  cells: string[];
  line: number;
}

/** RFC 4180 style reader: quoted cells, doubled quotes, newlines inside quotes, any line ending. */
export function readCsvRows(
  text: string,
  maxRows = LOREBOOK_TEXT_MAX_ENTRIES + 1,
): { rows: CsvRow[]; unterminatedAt: number | null; truncated: boolean } {
  const source = stripBom(text);
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;
  let truncated = false;
  const pushRow = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== "")) {
      if (rows.length >= maxRows) truncated = true;
      else rows.push({ cells, line: rowLine });
    }
    cells = [];
    cell = "";
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (char === "\r") {
        cell += "\n";
        if (source[i + 1] === "\n") i++;
        line++;
      } else {
        if (char === "\n") line++;
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.trim() === "") {
      cell = "";
      inQuotes = true;
      quoteLine = line;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      pushRow();
      if (truncated) break;
      line++;
      rowLine = line;
    } else {
      cell += char;
    }
  }
  if (inQuotes) return { rows, unterminatedAt: quoteLine, truncated };
  if (cell !== "" || cells.length > 0) pushRow();
  return { rows, unterminatedAt: null, truncated };
}

const CSV_COLUMN_ALIASES: Record<string, keyof RawEntryFields> = {
  name: "name",
  title: "name",
  keys: "keys",
  key: "keys",
  keywords: "keys",
  content: "content",
  text: "content",
  body: "content",
  folder: "folder",
  enabled: "enabled",
  constant: "constant",
  probability: "probability",
};
const CSV_ESCAPE_COLUMN = "marinara_csv_escape";
const CSV_ESCAPE_VERSION = "apostrophe-v1";

export function parseLorebookCsv(text: string): ParsedLorebookText {
  if (text.length > LOREBOOK_TEXT_MAX_CHARS) {
    return finish("csv", null, [], [{ severity: "error", code: "input_too_large", line: null, entryIndex: null }]);
  }
  const { rows, unterminatedAt, truncated } = readCsvRows(text);
  const fileIssues: LorebookTextIssue[] = [];
  if (truncated) {
    fileIssues.push({
      severity: "error",
      code: "too_many_entries",
      line: rows[rows.length - 1]?.line ?? null,
      entryIndex: null,
    });
  }
  if (unterminatedAt !== null) {
    fileIssues.push({ severity: "error", code: "unterminated_quote", line: unterminatedAt, entryIndex: null });
    return finish("csv", null, [], fileIssues);
  }
  const header = rows.shift();
  if (!header) return finish("csv", null, [], fileIssues);

  const columnNames = header.cells.map((cell) => cell.trim().toLowerCase());
  const columns = columnNames.map((name) => CSV_COLUMN_ALIASES[name] ?? null);
  const escapeIndex = columnNames.indexOf(CSV_ESCAPE_COLUMN);
  const uniqueEscapeColumn = escapeIndex >= 0 && escapeIndex === columnNames.lastIndexOf(CSV_ESCAPE_COLUMN);
  header.cells.forEach((cell, index) => {
    if (!columns[index] && cell.trim() && columnNames[index] !== CSV_ESCAPE_COLUMN) {
      fileIssues.push({
        severity: "warning",
        code: "unknown_column",
        line: header.line,
        entryIndex: null,
        detail: cell.trim(),
      });
    }
  });
  const missing = (["name", "keys", "content"] as const).filter((column) => !columns.includes(column));
  if (missing.length > 0) {
    fileIssues.push({
      severity: "error",
      code: "missing_columns",
      line: header.line,
      entryIndex: null,
      detail: missing.join(", "),
    });
    return finish("csv", null, [], fileIssues);
  }

  const built = rows.map((row) => {
    // External CSV data stays literal unless this row explicitly declares our escaping format.
    const escaped = uniqueEscapeColumn && row.cells[escapeIndex] === CSV_ESCAPE_VERSION;
    const fields: RawEntryFields = {
      name: "",
      keys: "",
      content: "",
      folder: "",
      enabled: "",
      constant: "",
      probability: "",
    };
    row.cells.forEach((cell, index) => {
      const column = columns[index];
      if (column) {
        fields[column] = escaped && cell.startsWith("'") && csvNeedsTextPrefix(cell.slice(1)) ? cell.slice(1) : cell;
      }
    });
    const result = buildEntry(fields);
    if (row.cells.length > header.cells.length && row.cells.slice(header.cells.length).some((cell) => cell.trim())) {
      result.issues.push({ code: "extra_cells", detail: String(row.cells.length) });
    }
    return { ...result, line: row.line };
  });
  return finish("csv", null, built, fileIssues);
}

export function parseLorebookText(format: LorebookTextFormat, text: string): ParsedLorebookText {
  return format === "csv" ? parseLorebookCsv(text) : parseLorebookMarkdown(text);
}

/** Guesses the format from a file name, falling back to the text's shape. */
export function detectLorebookTextFormat(text: string, fileName?: string): LorebookTextFormat {
  const lower = fileName?.toLowerCase() ?? "";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".txt")) return "markdown";
  const source = stripBom(text.slice(0, LOREBOOK_TEXT_MAX_CHARS));
  let firstLine = "";
  let start = 0;
  while (start <= source.length) {
    let end = source.indexOf("\n", start);
    const crEnd = source.indexOf("\r", start);
    if (end < 0 || (crEnd >= 0 && crEnd < end)) end = crEnd;
    const line = source.slice(start, end < 0 ? source.length : end).trim();
    if (line) {
      firstLine = line;
      break;
    }
    if (end < 0) break;
    start = end + 1;
  }
  if (/^#/.test(firstLine)) return "markdown";
  return /(^|,)\s*"?name"?\s*,/i.test(firstLine) ? "csv" : "markdown";
}

// ── Export ──

export interface LorebookTextExportEntry {
  name: string;
  keys: string[];
  content: string;
  folderId?: string | null;
  enabled?: boolean;
  constant?: boolean;
  probability?: number | null;
}

export interface LorebookTextExportFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
}

export interface LorebookTextExportInput {
  name?: string;
  entries: LorebookTextExportEntry[];
  folders?: LorebookTextExportFolder[];
}

function folderPathResolver(folders: LorebookTextExportFolder[] = []) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return (folderId: string | null | undefined): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = folderId ? byId.get(folderId) : undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      // A slash inside a folder name would split the path on import.
      names.unshift(current.name.replace(/\//g, "-").trim());
      current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined;
    }
    return names.join(LOREBOOK_TEXT_FOLDER_SEPARATOR);
  };
}

/** Keys are comma separated in both formats, so commas inside a key cannot survive a round trip. */
function joinKeys(keys: string[]): string {
  return keys
    .map((key) => key.replace(/[,\n]/g, " ").trim())
    .filter(Boolean)
    .join(", ");
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, (whitespace) => (whitespace.includes("\n") ? " " : whitespace)).trim();
}

export function exportLorebookToMarkdown(input: LorebookTextExportInput): string {
  const folderPath = folderPathResolver(input.folders);
  const blocks: string[] = [];
  if (input.name?.trim()) blocks.push(`# ${singleLine(input.name)}`);
  for (const entry of input.entries) {
    const lines = [`## ${singleLine(entry.name)}`, `Keys: ${joinKeys(entry.keys)}`];
    const folder = folderPath(entry.folderId);
    if (folder) lines.push(`Folder: ${folder}`);
    if (entry.enabled === false) lines.push("Enabled: false");
    if (entry.constant) lines.push("Constant: true");
    if (entry.probability !== null && entry.probability !== undefined) lines.push(`Probability: ${entry.probability}`);
    const content = normalizeNewlines(entry.content ?? "").trim();
    if (content) lines.push("", ...content.split("\n").map(escapeMarkdownLine));
    blocks.push(lines.join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Escape literal apostrophes too, so imports can undo one spreadsheet-safety prefix without losing them. */
function csvNeedsTextPrefix(value: string): boolean {
  return value.startsWith("'") || /^[\u0000-\u0020]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value);
}

function csvCell(value: string): string {
  const safeValue = csvNeedsTextPrefix(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue) || safeValue !== safeValue.trim()
    ? `"${safeValue.replace(/"/g, '""')}"`
    : safeValue;
}

export const LOREBOOK_CSV_COLUMNS = [
  "name",
  "keys",
  "content",
  "folder",
  "enabled",
  "constant",
  "probability",
  CSV_ESCAPE_COLUMN,
] as const;

export function exportLorebookToCsv(input: LorebookTextExportInput): string {
  const folderPath = folderPathResolver(input.folders);
  const rows = [LOREBOOK_CSV_COLUMNS.join(",")];
  for (const entry of input.entries) {
    rows.push(
      [
        entry.name,
        joinKeys(entry.keys),
        normalizeNewlines(entry.content ?? ""),
        folderPath(entry.folderId),
        entry.enabled === false ? "false" : "true",
        entry.constant ? "true" : "false",
        entry.probability === null || entry.probability === undefined ? "" : String(entry.probability),
        CSV_ESCAPE_VERSION,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\r\n")}\r\n`;
}

export function exportLorebookText(format: LorebookTextFormat, input: LorebookTextExportInput): string {
  return format === "csv" ? exportLorebookToCsv(input) : exportLorebookToMarkdown(input);
}

// ── Import planning ──

export type LorebookTextImportAction =
  | { kind: "create"; entry: LorebookTextEntry; name: string }
  | { kind: "overwrite"; entry: LorebookTextEntry; targetId: string }
  | { kind: "skip"; entry: LorebookTextEntry };

/**
 * Decides what happens to each valid parsed entry given the target lorebook's
 * existing entries. Names compare case-insensitively. A repeat inside the file
 * is treated like a clash with the entry planned before it.
 */
export function planLorebookTextImport(
  entries: LorebookTextEntry[],
  existing: Array<{ id: string; name: string }>,
  mode: LorebookTextDuplicateMode,
): LorebookTextImportAction[] {
  const existingByName = new Map<string, string>();
  for (const entry of existing) {
    const key = entry.name.trim().toLowerCase();
    if (!existingByName.has(key)) existingByName.set(key, entry.id);
  }
  const taken = new Set(existing.map((entry) => entry.name.trim().toLowerCase()));
  const plannedCreate = new Map<string, number>();
  const actions: LorebookTextImportAction[] = [];

  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (!taken.has(key)) {
      taken.add(key);
      plannedCreate.set(key, actions.length);
      actions.push({ kind: "create", entry, name: entry.name });
      continue;
    }
    if (mode === "skip") {
      actions.push({ kind: "skip", entry });
    } else if (mode === "rename") {
      // Trim the base so the suffixed name still fits the entry name limit.
      const withSuffix = (n: number) => {
        const suffix = ` (${n})`;
        return `${entry.name.slice(0, LOREBOOK_TEXT_MAX_NAME_LENGTH - suffix.length).trimEnd()}${suffix}`;
      };
      let suffix = 2;
      let candidate = withSuffix(suffix);
      while (taken.has(candidate.toLowerCase())) candidate = withSuffix(++suffix);
      taken.add(candidate.toLowerCase());
      actions.push({ kind: "create", entry, name: candidate });
    } else {
      const targetId = existingByName.get(key);
      const earlier = plannedCreate.get(key);
      if (earlier !== undefined) {
        // A later copy in the same file wins over the one planned earlier.
        const previous = actions[earlier]!;
        actions[earlier] = { kind: "skip", entry: previous.entry };
        plannedCreate.set(key, actions.length);
        actions.push(
          previous.kind === "overwrite"
            ? { kind: "overwrite", entry, targetId: previous.targetId }
            : { kind: "create", entry, name: entry.name },
        );
      } else if (targetId) {
        plannedCreate.set(key, actions.length);
        actions.push({ kind: "overwrite", entry, targetId });
      } else {
        actions.push({ kind: "skip", entry });
      }
    }
  }
  return actions;
}

export function summarizeLorebookTextImport(actions: LorebookTextImportAction[]) {
  const summary = { created: 0, renamed: 0, overwritten: 0, skipped: 0 };
  for (const action of actions) {
    if (action.kind === "skip") summary.skipped++;
    else if (action.kind === "overwrite") summary.overwritten++;
    else if (action.name !== action.entry.name) summary.renamed++;
    else summary.created++;
  }
  return summary;
}

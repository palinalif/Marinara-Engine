// ──────────────────────────────────────────────
// Small avatar embedding for standalone HTML exports
// ──────────────────────────────────────────────
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { resolveStoredAvatarFile } from "../image/avatar-file-lifecycle.js";

/** Avatars larger than this are skipped so an exported story stays light. */
export const MAX_EMBEDDED_AVATAR_BYTES = 96 * 1024;

const AVATAR_MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

/** Read a stored app avatar as a data: URI, or null when missing, remote, unknown or too large. */
export async function readSmallAvatarDataUri(
  avatarPath: string | null | undefined,
  maxBytes = MAX_EMBEDDED_AVATAR_BYTES,
  avatarRoot?: string,
): Promise<string | null> {
  const filePath = avatarRoot ? resolveStoredAvatarFile(avatarPath, avatarRoot) : resolveStoredAvatarFile(avatarPath);
  if (!filePath) return null;
  const mime = AVATAR_MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (!mime) return null;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return null;
    const bytes = await readFile(filePath);
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

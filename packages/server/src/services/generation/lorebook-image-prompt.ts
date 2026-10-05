import type { ChatMLMessage } from "@marinara-engine/shared";
import { readLorebookImageDataUrl } from "../lorebook/lorebook-images.js";

export interface LorebookImageEntry {
  id: string;
  name: string;
  content: string;
  position: number;
  outletName?: string;
  outletUsed?: boolean;
  images: Array<{ path: string; caption: string }>;
}

export type LorebookImageNotice = "unsupported" | "unavailable" | "limited";

/** Images use user-role messages: several providers cannot accept them in system blocks. */
export async function appendLorebookImageMessages<T extends ChatMLMessage>(
  messages: T[],
  entries: readonly LorebookImageEntry[] = [],
  options: {
    onNotice?: (code: LorebookImageNotice) => void;
    rememberImage?: (dataUrl: string) => void;
  } = {},
): Promise<void> {
  let imageCount = 0;
  let imageBytes = 0;
  const seen = new Set<string>();
  const references: ChatMLMessage[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id) || !entry.images.length) continue;
    seen.add(entry.id);
    // An Outlet has no automatic placement; an unused Outlet must not leak its images.
    if (entry.position === 7 && entry.outletUsed !== true) continue;
    const images: string[] = [];
    const captions: string[] = [];
    for (const [index, image] of entry.images.entries()) {
      if (imageCount >= 16 || imageBytes >= 20 * 1024 * 1024) {
        options.onNotice?.("limited");
        continue;
      }
      const dataUrl = await readLorebookImageDataUrl(image.path);
      if (!dataUrl) {
        if (image.caption) captions.push(`Unavailable reference ${index + 1}: ${image.caption}`);
        options.onNotice?.("unavailable");
        continue;
      }
      const bytes = Math.floor(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4);
      if (imageBytes + bytes > 20 * 1024 * 1024) {
        options.onNotice?.("limited");
        continue;
      }
      imageCount++;
      imageBytes += bytes;
      images.push(dataUrl);
      captions.push(`Reference ${images.length}${image.caption ? `: ${image.caption}` : ""}`);
      options.rememberImage?.(dataUrl);
    }
    if (images.length || captions.length) {
      references.push({
        role: "user",
        contextKind: "injection",
        content: `Visual references for lorebook entry ${entry.name}:\n${captions.join("\n")}`,
        ...(images.length ? { images } : {}),
      });
    }
  }
  const firstHistory = messages.findIndex((message) => message.contextKind === "history");
  // Without history, a trailing assistant message is the prefill and must stay last.
  const insertAt =
    firstHistory >= 0 ? firstHistory : messages.at(-1)?.role === "assistant" ? messages.length - 1 : messages.length;
  messages.splice(insertAt, 0, ...(references as T[]));
}

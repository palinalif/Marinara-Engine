import { createHash } from "node:crypto";
import type { MemoryRecallEmbeddingOptions } from "../memory-recall.js";
import { DEFAULT_LOCAL_MEMORY_EMBEDDING_SPACE_ID, embedMemoryRecallTexts } from "../memory-recall.js";

const MAX_CACHED_SUMMARY_EMBEDDINGS = 512;
const embeddings = new Map<string, number[]>();

function cacheKey(text: string, options: MemoryRecallEmbeddingOptions): string | null {
  const spaceId = options.embeddingSource
    ? options.embeddingSource.cacheIdentity?.trim() || options.embeddingSource.spaceId?.trim()
    : options.localEmbedder
      ? null
      : DEFAULT_LOCAL_MEMORY_EMBEDDING_SPACE_ID;
  if (!spaceId) return null;
  const contentHash = createHash("sha256").update(text).digest("hex");
  return `${spaceId}:${contentHash}`;
}

/** Reuse only complete document vectors from the same configured embedding space. */
export async function embedSummaryDocuments(
  texts: string[],
  options: MemoryRecallEmbeddingOptions,
  expectedDimension?: number,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const keys = texts.map((text) => cacheKey(text, options));
  const result = new Array<number[] | undefined>(texts.length);
  const missing: number[] = [];

  for (let index = 0; index < texts.length; index += 1) {
    const key = keys[index];
    const cached = key ? embeddings.get(key) : undefined;
    if (cached && (!expectedDimension || cached.length === expectedDimension)) {
      result[index] = cached;
      embeddings.delete(key!);
      embeddings.set(key!, cached);
    } else {
      if (cached && key) embeddings.delete(key);
      missing.push(index);
    }
  }

  if (missing.length > 0) {
    const fresh = await embedMemoryRecallTexts(
      missing.map((index) => texts[index]!),
      {
        ...options,
        inputType: "document",
      },
    );
    if (fresh.length !== missing.length) return [];
    const dimension = fresh[0]?.length ?? 0;
    if (
      dimension === 0 ||
      (expectedDimension !== undefined && dimension !== expectedDimension) ||
      fresh.some((vector) => vector.length !== dimension || vector.some((value) => !Number.isFinite(value)))
    ) {
      return [];
    }
    for (let index = 0; index < missing.length; index += 1) {
      const position = missing[index]!;
      const vector = fresh[index]!;
      result[position] = vector;
      const key = keys[position];
      if (key) {
        embeddings.set(key, vector);
        while (embeddings.size > MAX_CACHED_SUMMARY_EMBEDDINGS) {
          embeddings.delete(embeddings.keys().next().value!);
        }
      }
    }
  }

  return result.every((vector): vector is number[] => vector !== undefined) ? result : [];
}

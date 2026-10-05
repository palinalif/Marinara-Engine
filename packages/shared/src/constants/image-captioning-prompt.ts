/** Built-in instructions for describing image attachments. Used when a chat has no custom captioning prompt. */
export const DEFAULT_IMAGE_CAPTIONING_PROMPT =
  "You describe image attachments for a downstream chat model that may not support vision. " +
  "Write a faithful, concise description of the visible content, including readable text, subjects, setting, style, and any details important for conversation continuity. " +
  "Do not answer the chat and do not add speculation beyond what is visible.";

import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// #6970: a local server that sends headers at once and the first token minutes later (a long
// Professor Mari prompt) must be waited on for the Text generation timeout, not a fixed 2 minutes.
process.env.CHAT_GENERATION_TIMEOUT_MS = "10000";
const { llmFetch } = await import("../../packages/server/src/services/llm/base-provider.js");

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.flushHeaders();
  const delayMs = request.url === "/late" ? 12_000 : 3_000;
  const timer = setTimeout(() => response.end("data: first\n\n"), delayMs);
  response.on("close", () => clearTimeout(timer));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address() as AddressInfo;

try {
  const slow = await llmFetch(`http://127.0.0.1:${port}/slow`);
  assert.equal(await slow.text(), "data: first\n\n", "a slow first chunk within the limit arrives");

  // Past the configured 10 seconds the wait ends, so the limit really follows the setting
  // (a fixed 2-minute chunk wait would let this one through).
  const late = await llmFetch(`http://127.0.0.1:${port}/late`);
  await assert.rejects(late.text(), "the wait for the first chunk follows CHAT_GENERATION_TIMEOUT_MS");
  console.log("LLM first-chunk wait follows the Text generation timeout.");
} finally {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}

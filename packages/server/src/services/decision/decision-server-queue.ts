/**
 * Decision requests wait here for a free slot on the model's own server.
 *
 * A time limit is per statement. A local model's server works on only a few requests
 * at once (llama-server's `--parallel`, the decision sidecar's lock) and queues the
 * rest, so a statement sent alongside thirty others used to spend its limit waiting
 * and time out without ever being worked on. Callers start their clock inside `run`,
 * after this hands them a slot. Keyed by server address, so every caller asking the
 * same server shares its slots: activation questions at different scan depths, prompt
 * statements and lorebook entries all queue together.
 */
const servers = new Map<string, { active: number; waiting: Array<() => void> }>();

export async function whenDecisionServerFree<T>(
  server: string,
  slots: number,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  let queue = servers.get(server);
  if (!queue) {
    queue = { active: 0, waiting: [] };
    servers.set(server, queue);
  }
  const current = queue;
  // A missing or odd slot count must not stall every decision behind a NaN comparison.
  const capacity = Number.isFinite(slots) && slots >= 1 ? Math.floor(slots) : 1;
  if (current.active < capacity) {
    current.active += 1;
  } else {
    const granted = await new Promise<boolean>((resolve) => {
      const grant = () => {
        signal?.removeEventListener("abort", cancel);
        resolve(true);
      };
      const cancel = () => {
        const at = current.waiting.indexOf(grant);
        if (at >= 0) current.waiting.splice(at, 1);
        resolve(false);
      };
      if (signal?.aborted) return resolve(false);
      current.waiting.push(grant);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    // Cancelled while waiting: `run` sees the aborted signal and returns at once, so it
    // needs no slot and must not take one from a caller still waiting.
    if (!granted) return run();
    // Otherwise the finishing request handed its slot straight over; `active` already
    // counts it, so a newcomer cannot slip in between.
  }
  try {
    return await run();
  } finally {
    const next = current.waiting.shift();
    if (next) next();
    else {
      current.active -= 1;
      if (current.active === 0 && servers.get(server) === current) servers.delete(server);
    }
  }
}

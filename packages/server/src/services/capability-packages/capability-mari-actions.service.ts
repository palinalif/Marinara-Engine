import { addAbortListener } from "node:events";
import { withDeadline } from "./capability-prompt-context.service.js";
import { getCapabilityService, listCapabilityServiceKeys } from "./capability-service-registry.service.js";

const SERVICE_PREFIX = "mari-actions:";
const PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const MAX_INPUT_CHARS = 64_000;
const MAX_ACTIONS = 50;
const MAX_INPUTS = 40;
const MAX_TEXT_CHARS = 300;
const MAX_ERROR_CHARS = 2_000;
const LIST_TIMEOUT_MS = 5_000;
// ponytail: one fixed ceiling for every action; a per-action deadline from list() if a package needs longer.
const RUN_TIMEOUT_MS = 300_000;

/** One action a package lets Professor Mari run. `summary` and `inputs` are what Mari reads. */
export interface CapabilityMariAction {
  name: string;
  summary?: string;
  inputs?: Record<string, string>;
}

export type CapabilityMariActionOutcome = { ok: true; value: unknown } | { ok: false; status?: number; error: string };

/**
 * Registered as `mari-actions:<package-id>` by a package holding the `mari-actions` permission.
 * `run` receives untrusted model input and must validate it against its own schema. `signal` aborts
 * when the user stops Mari or the Engine's deadline passes.
 */
export interface CapabilityMariActionsService {
  list(): readonly CapabilityMariAction[] | Promise<readonly CapabilityMariAction[]>;
  run(
    name: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<CapabilityMariActionOutcome>;
}

/** The key encodes the owner, so no package can offer Mari actions in another package's name. */
export function assertCapabilityMariActionsServiceRegistration(
  packageId: string,
  permissions: readonly string[],
  key: string,
): void {
  if (!key.startsWith(SERVICE_PREFIX)) return;
  if (!permissions.includes("mari-actions")) {
    throw new Error(`Capability package ${packageId} must declare the "mari-actions" permission`);
  }
  if (key !== `${SERVICE_PREFIX}${packageId}`) {
    throw new Error(`Capability package ${packageId} cannot register Mari actions for another package`);
  }
}

/** A data URL (a drawn picture) is megabytes of base64 that would only fill Mari's context. */
export function elideDataUrls(text: string): string {
  return text.replace(
    /data:[\w/+.-]+(?:;[\w=.-]+)*;base64,[A-Za-z0-9+/=]+/gu,
    (match) => `<data URL, ${match.length} characters, omitted>`,
  );
}

function clip(value: unknown, max: number): string {
  const text = elideDataUrls(typeof value === "string" ? value : String(value));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function serviceFor(packageId: string): CapabilityMariActionsService | null {
  const service = getCapabilityService<CapabilityMariActionsService>(`${SERVICE_PREFIX}${packageId}`);
  return service && typeof service.list === "function" && typeof service.run === "function" ? service : null;
}

/** Package-authored text reaches Mari's prompt, so only bounded strings of well-formed actions pass. */
async function actionsOf(
  packageId: string,
  service: CapabilityMariActionsService,
  signal: AbortSignal,
): Promise<CapabilityMariAction[]> {
  signal.throwIfAborted();
  let abortListener: ReturnType<typeof addAbortListener> | undefined;
  let listed: readonly CapabilityMariAction[];
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = addAbortListener(signal, () => reject(signal.reason));
    });
    listed = await withDeadline(
      Promise.race([Promise.resolve().then(() => service.list()), aborted]),
      `${packageId} Mari action list`,
      LIST_TIMEOUT_MS,
    );
  } finally {
    abortListener?.[Symbol.dispose]();
  }
  if (!Array.isArray(listed)) return [];
  return listed
    .filter((action) => !!action && typeof action.name === "string" && ACTION_NAME_PATTERN.test(action.name))
    .slice(0, MAX_ACTIONS)
    .map((action: CapabilityMariAction) => {
      const inputs = Object.entries(
        action.inputs && typeof action.inputs === "object" && !Array.isArray(action.inputs) ? action.inputs : {},
      )
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .slice(0, MAX_INPUTS)
        .map(([key, text]) => [clip(key, 80), clip(text, MAX_TEXT_CHARS)]);
      return {
        name: action.name,
        ...(typeof action.summary === "string" ? { summary: clip(action.summary, MAX_TEXT_CHARS) } : {}),
        ...(inputs.length > 0 ? { inputs: Object.fromEntries(inputs) } : {}),
      };
    });
}

/** Every active package that offers Mari actions, with the actions it offers. */
export async function listCapabilityMariActions(
  signal: AbortSignal,
): Promise<Array<{ package: string; actions: CapabilityMariAction[] }>> {
  signal.throwIfAborted();
  // In parallel, so several slow packages cost one list deadline, not one each.
  const listed = await Promise.all(
    listCapabilityServiceKeys(SERVICE_PREFIX).map(async (key) => {
      const packageId = key.slice(SERVICE_PREFIX.length);
      const service = serviceFor(packageId);
      if (!service) return null;
      try {
        const actions = await actionsOf(packageId, service, signal);
        return serviceFor(packageId) === service ? { package: packageId, actions } : null;
      } catch (error) {
        if (signal.aborted) throw error;
        return null; // One broken or slow package must not hide the others.
      }
    }),
  );
  return listed.filter((entry) => entry !== null);
}

/** Runs one action of one package. Throws a bounded message Mari can act on. */
export async function runCapabilityMariAction(
  packageId: string,
  action: string,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (!PACKAGE_ID_PATTERN.test(packageId)) throw new Error(`"${clip(packageId, 80)}" is not a package id`);
  const service = serviceFor(packageId);
  if (!service) {
    throw new Error(
      `Package "${packageId}" offers no Mari actions. Call package_service without a package to list the ones that do.`,
    );
  }
  const payload = input ?? {};
  if (typeof payload !== "object" || Array.isArray(payload)) throw new Error("input must be a JSON object");
  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_INPUT_CHARS) throw new Error(`input is larger than ${MAX_INPUT_CHARS} characters`);
  if (!(await actionsOf(packageId, service, signal)).some((entry) => entry.name === action)) {
    throw new Error(
      `Package "${packageId}" has no Mari action "${clip(action, 80)}". Call package_service with only package="${packageId}" to list its actions.`,
    );
  }
  signal.throwIfAborted();
  // Discovery can await package code while that activation is disabled, removed or replaced.
  if (serviceFor(packageId) !== service) {
    throw new Error(
      `Package "${packageId}" changed while listing its actions. List its actions again before running one.`,
    );
  }
  // The package sees Mari's stop and the deadline through one signal, and the Engine stops waiting on
  // either even if the package ignores it, so a stuck action cannot hold Mari's change lane forever.
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(`${packageId} ${action} was stopped`)), {
      once: true,
    });
  });
  // Nothing listens to `aborted` until the race below; a package whose run throws before returning
  // a promise reaches the catch first, and its abort must not become an unhandled rejection.
  aborted.catch(() => undefined);
  let outcome: CapabilityMariActionOutcome;
  try {
    // A JSON round trip hands the package plain data only: no prototypes, functions or shared references.
    const running = Promise.resolve(
      service.run(action, JSON.parse(serialized) as Record<string, unknown>, { signal: controller.signal }),
    );
    outcome = await withDeadline(Promise.race([running, aborted]), `${packageId} ${action}`, RUN_TIMEOUT_MS);
  } catch (err) {
    controller.abort();
    throw new Error(
      `${packageId} ${action} failed: ${clip(err instanceof Error ? err.message : err, MAX_ERROR_CHARS)}`,
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean") {
    throw new Error(`Package "${packageId}" returned an invalid answer for "${clip(action, 80)}"`);
  }
  if (!outcome.ok) {
    throw new Error(`${packageId} ${action} failed: ${clip(outcome.error || "no reason given", MAX_ERROR_CHARS)}`);
  }
  return outcome.value;
}

// The client NUMBERING runtime — the editor numbers its typed blocks LOCALLY via the WASM build of the
// core's pure `project_display_labels` (arch doc §5/§6.3b). No server round-trip, no TS reimplementation
// of numbering (single source of truth): the same Rust projection the server and exports use. Mirrors
// `mathRuntime`. `initNumberingRuntime` MUST be awaited once (main.tsx, before mount) before `displayLabels`.
import type { UnitLabel } from '@mathmeander/schema';
import init, { displayLabels as wasmDisplayLabels } from '../wasm/mathmeander_core_wasm.js';

let ready: Promise<void> | null = null;
let loaded = false;

/** Instantiate the WASM module once (idempotent), awaited at app startup. Rejects if it fails to load;
 *  callers mount anyway and the editor degrades to the citation's stored fallback text. */
export function initNumberingRuntime(): Promise<void> {
  if (!ready)
    ready = init().then(() => {
      loaded = true;
    });
  return ready;
}

export function isNumberingRuntimeReady(): boolean {
  return loaded;
}

/** One block's input to numbering — numbering reads only these fields (the rest defaults in the seam). */
export interface BlockInput {
  id: string;
  type: string | null;
  parent_unit_id: string | null;
  position: number;
}

/** One unit's authored name (a `Handle`, §6.3b) — `project_display_labels` resolves it into
 *  `UnitLabel.name`. The seam fills the inert `Handle` placeholders. */
export interface HandleInput {
  target_unit_id: string;
  name: string;
}

/** The numbering policy (mirrors the server's `DEFAULT_POLICY` until a document-config policy lands). */
export interface NumberingPolicyInput {
  numbered_types: string[];
  shared_counter: boolean;
}

export const DEFAULT_POLICY: NumberingPolicyInput = {
  numbered_types: ['theorem', 'lemma', 'proposition', 'corollary', 'definition', 'example'],
  shared_counter: false,
};

/** Project labels for a document's blocks via the core's numbering (WASM). `handles` carry authored
 *  names → `UnitLabel.name`. `[]` until the runtime loads (mirrors `isNumberingRuntimeReady`) — callers
 *  then fall back to the citation's stored text. */
export function displayLabels(
  blocks: BlockInput[],
  handles: HandleInput[] = [],
  policy: NumberingPolicyInput = DEFAULT_POLICY,
): UnitLabel[] {
  if (!loaded) return [];
  const json = wasmDisplayLabels(
    JSON.stringify(blocks),
    JSON.stringify(handles),
    JSON.stringify(policy),
  );
  return (JSON.parse(json) as { labels: UnitLabel[] }).labels;
}

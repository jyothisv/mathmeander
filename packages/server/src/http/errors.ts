// The HTTP error contract: ONE envelope `{ error: { code, message, details? } }`.
// Codes are the core's ValidationError serde tags (the glue maps typed core errors
// WITHOUT interpretation) plus the glue's own request-level codes.
import type { CoreError } from '@mathmeander/schema';

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Glue-level error codes (everything else comes from the core's tagged unions). */
export type GlueCode =
  | 'REVISION_CONFLICT'
  | 'DUPLICATE_ID'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'SESSION_REVOKED'
  | 'INVALID_REQUEST';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: GlueCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/**
 * Core ValidationError code → HTTP status. Client-attributable validation is 422;
 * codes that can only mean a server-side bug (the glue builds those inputs) are 500.
 * This table is exercised by a unit test so a new core error variant cannot ship
 * without a mapping decision.
 */
export const CORE_CODE_STATUS: Record<string, number> = {
  // ── Create path (slice 1a) ──
  unknown_object_type: 422,
  type_not_producible_yet: 422, // client POSTed a reserved type (valid on read, no create surface yet)
  type_not_directly_creatable: 422, // client POSTed a formal-family type — enters by declaration (§9.y)
  invalid_id: 422,
  not_uuid_v7: 422,
  title_too_long: 422,
  raw_source_too_large: 422,
  missing_created_by: 500, // glue assembles CreateContext — user origin always has an actor
  origin_not_producible: 500, // glue only produces user/system origins in the skeleton
  schema_version_mismatch: 500,
  schema_version_from_the_future: 500, // stored data newer than the running core

  // ── Ops (slice 1c): client-supplied target/offset/index against current state → 422 ──
  unit_not_found: 422,
  expression_not_found: 422,
  occurrence_out_of_range: 422,
  unsplittable_content_kind: 422,
  unmergeable_units: 422,
  split_offset_out_of_range: 422,
  occurrence_already_resolved: 422,
  target_kind_not_available_yet: 422, // e.g. resolving to notation before slice 2

  // ── Edge/content invariants the import gate (validate_graph) checks on an untrusted pack,
  //    and that a client LinkDraft (insert_reference) can trip → 422 (bad request) ──
  link_target_not_exactly_one: 422,
  off_graph_deliberate_edge: 422,
  unit_target_without_object: 422,
  typed_edge_requires_object_target: 422,
  selector_without_object_target: 422,
  content_edge_missing_anchor: 422,
  tagging_target_not_exactly_one: 422,
  inline_atom_not_zero_width: 422,
  inline_span_out_of_bounds: 422,
  occurrence_span_out_of_bounds: 422,

  // ── Ownership (slice 2a): client-attributable referential breaks on the untrusted import
  //    path + the reviewable dissolution refusal → 422 ──
  embed_target_missing: 422, // an imported pack's embed names an object absent from the pack
  unit_in_multiple_objects: 422, // an imported pack puts one unit under two objects (one home, §6.0b)
  dissolution_blocked: 422, // inbound references depend on the object — review, don't silently move (§9.y)
  type_not_materializable: 422, // client asked rehome to materialize a §6.5 surface (journal_day/trail) — surfaces are created via their own op
  detail_object_type_mismatch: 422, // imported pack: a *_detail.object_id references the wrong object type (arch §827) — untrusted, client-attributable
  content_save_invalid: 422, // editor's save_content delta would change a semantic facet (use the unit ops) or has a bad position/non-prose change (slice 2c)
  equations_row_not_permitted: 422, // insert_equations / import: an Equations container's row is not Math/Prose (one level only, §F2)
  invalid_slot_for_parent_kind: 422, // reserved vocabulary: the old heading-slot section model was replaced by `UnitContent::Heading`, so no core path emits this today; a parent-capability break now surfaces as content_save_invalid. Kept (mapped 422) since the variant stays in the error vocabulary.

  // ── Glue id-bookkeeping the client cannot cause via a well-formed request → 500 ──
  id_count_mismatch: 500,
  remap_incomplete: 500,
  duplicate_source_id: 500,
  dissolve_input_inconsistent: 500, // glue handed dissolve mismatched embed/content (a precondition bug)

  // ── §6.1a invariants no slice-1d endpoint can currently trip (fail-closed until their
  //    endpoints land in later slices) → 500 ──
  content_kind_mismatch: 500,
  example_kind_without_example_type: 500,
  detail_type_mismatch: 500,
  alias_scope_ref_mismatch: 500,
  handle_target_not_exactly_one: 500,
  declared_by_ai: 500,
};

/** Map a core error envelope to (status, body). Unknown codes fail closed as 500. */
export function coreErrorToHttp(error: CoreError): { status: number; body: ErrorBody } {
  if (error.kind === 'malformed_input') {
    // The glue built that input — malformed means a server-side bug, never the client.
    return {
      status: 500,
      body: { error: { code: 'malformed_input', message: error.message } },
    };
  }
  const { code, ...rest } = error;
  delete (rest as { kind?: string }).kind;
  return {
    status: CORE_CODE_STATUS[code] ?? 500,
    body: { error: { code, message: describeCode(code), details: rest } },
  };
}

/**
 * On the UNTRUSTED `POST /api/mathpack/import` path the request BODY is the client's uploaded
 * pack, so "the glue built it" no longer holds: a malformed/garbled body or a future-schema pack
 * is a bad request (4xx), not a server bug. Same typed codes, call-site-aware status.
 */
const IMPORT_CLIENT_ERROR = new Set(['schema_version_from_the_future', 'schema_version_mismatch']);

export function coreErrorToHttpUntrusted(error: CoreError): { status: number; body: ErrorBody } {
  if (error.kind === 'malformed_input') {
    return { status: 422, body: { error: { code: 'malformed_input', message: error.message } } };
  }
  const { code, ...rest } = error;
  delete (rest as { kind?: string }).kind;
  const status = IMPORT_CLIENT_ERROR.has(code) ? 422 : (CORE_CODE_STATUS[code] ?? 422);
  return { status, body: { error: { code, message: describeCode(code), details: rest } } };
}

function describeCode(code: string): string {
  return code.replaceAll('_', ' ');
}

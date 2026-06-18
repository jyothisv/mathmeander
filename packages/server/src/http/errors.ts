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

function describeCode(code: string): string {
  return code.replaceAll('_', ' ');
}

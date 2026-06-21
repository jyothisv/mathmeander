// MathExpression helpers + the "auto-edit a just-created math node" signal. Expression ids are
// client-minted UUIDv7 (like unit ids; the core is pure and never mints, §6.3). A fresh id per created
// expression is what makes copy-mints-fresh / transclude-references work (§6.3a).
import { v7 as uuidv7 } from 'uuid';
import type { MathExpression, ParseStatus } from '@mathmeander/schema';

/** A new expression with a freshly minted id. `mathmeander` is the surface we author in. */
export function newExpr(
  surfaceText: string,
  originalInput: string,
  parseStatus: ParseStatus,
): MathExpression {
  return {
    id: uuidv7(),
    surface_text: surfaceText,
    surface_format: 'mathmeander',
    input_syntax: 'mathmeander',
    original_input: originalInput,
    parse_status: parseStatus,
    occurrences: [],
  };
}

/** An empty expression (the `$`-just-typed state, before any source is entered). */
export function emptyExpr(): MathExpression {
  return newExpr('', '', 'renderable');
}

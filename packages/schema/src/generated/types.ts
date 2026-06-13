// GENERATED from the core schema artifact (packages/schema/artifact/) by
// scripts/generate.ts — DO NOT EDIT. Regenerate with `just codegen`.

import type { z } from 'zod';
import {
  CanonicalObjectSchema,
  CoreErrorSchema,
  CreateContextSchema,
  CreateObjectInputSchema,
  CreateObjectResultSchema,
  CreatedObjectSchema,
  ObjectPatchSchema,
  ObjectResultSchema,
  ObjectStatusSchema,
  ObjectTypeSchema,
  OriginSchema,
  ProvenanceSchema,
  ValidationErrorSchema,
} from './schemas';

export type CanonicalObject = z.infer<typeof CanonicalObjectSchema>;
export type CoreError = z.infer<typeof CoreErrorSchema>;
export type CreateContext = z.infer<typeof CreateContextSchema>;
export type CreateObjectInput = z.infer<typeof CreateObjectInputSchema>;
export type CreateObjectResult = z.infer<typeof CreateObjectResultSchema>;
export type CreatedObject = z.infer<typeof CreatedObjectSchema>;
export type ObjectPatch = z.infer<typeof ObjectPatchSchema>;
export type ObjectResult = z.infer<typeof ObjectResultSchema>;
export type ObjectStatus = z.infer<typeof ObjectStatusSchema>;
export type ObjectType = z.infer<typeof ObjectTypeSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

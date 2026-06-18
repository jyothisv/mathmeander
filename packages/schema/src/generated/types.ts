// GENERATED from the core schema artifact (packages/schema/artifact/) by
// scripts/generate.ts — DO NOT EDIT. Regenerate with `just codegen`.

import type { z } from 'zod';
import {
  AliasSchema,
  AliasKindSchema,
  AliasScopeSchema,
  AssetChecksumSchema,
  CanonicalObjectSchema,
  CharSpanSchema,
  ContentLocatorSchema,
  CoreErrorSchema,
  CreateContextSchema,
  CreateObjectInputSchema,
  CreateObjectResultSchema,
  CreatedObjectSchema,
  DeclaredBySchema,
  DefinitionDetailSchema,
  DisplayLabelsSchema,
  DissolveObjectInputSchema,
  EmbedTargetSchema,
  ExampleKindSchema,
  ExpressionIdRemapSchema,
  ExtractedStructureEnvelopeSchema,
  HandleSchema,
  HandleScopeSchema,
  HandleStatusSchema,
  InlineSchema,
  InputSyntaxSchema,
  InsertReferenceInputSchema,
  LinkSchema,
  LinkDraftSchema,
  LinkStatusSchema,
  LinkTypeSchema,
  MaterializeObjectInputSchema,
  MathContentSchema,
  MathExpressionSchema,
  MathpackSchema,
  MathpackCountsSchema,
  MathpackGraphSchema,
  MathpackImportSchema,
  MathpackImportResultSchema,
  MathpackManifestSchema,
  MathpackMetaSchema,
  MathpackResultSchema,
  MergeUnitsInputSchema,
  NumberingPolicySchema,
  NumberingResultSchema,
  ObjectPatchSchema,
  ObjectResultSchema,
  ObjectStatusSchema,
  ObjectTypeSchema,
  ObjectVersionSchema,
  OccurrenceSchema,
  OccurrenceTargetSchema,
  OpContextSchema,
  OpOutcomeSchema,
  OpOutcomeResultSchema,
  OriginSchema,
  ParseStatusSchema,
  ProvenanceSchema,
  ProvenanceDerivationSchema,
  ReferenceTargetSchema,
  RehomeSubtreeInputSchema,
  ResolveOccurrenceInputSchema,
  ResolveTargetSchema,
  RewriteSurfaceInputSchema,
  SetUnitTypeInputSchema,
  SplitUnitInputSchema,
  SurfaceFormatSchema,
  TagSchema,
  TaggingSchema,
  TargetSelectorSchema,
  ToggleExpressionPlacementInputSchema,
  UnitSchema,
  UnitContentSchema,
  UnitIdRemapSchema,
  UnitLabelSchema,
  UnitStatusSchema,
  UnitTypeSchema,
  ValidationErrorSchema,
} from './schemas';

export type Alias = z.infer<typeof AliasSchema>;
export type AliasKind = z.infer<typeof AliasKindSchema>;
export type AliasScope = z.infer<typeof AliasScopeSchema>;
export type AssetChecksum = z.infer<typeof AssetChecksumSchema>;
export type CanonicalObject = z.infer<typeof CanonicalObjectSchema>;
export type CharSpan = z.infer<typeof CharSpanSchema>;
export type ContentLocator = z.infer<typeof ContentLocatorSchema>;
export type CoreError = z.infer<typeof CoreErrorSchema>;
export type CreateContext = z.infer<typeof CreateContextSchema>;
export type CreateObjectInput = z.infer<typeof CreateObjectInputSchema>;
export type CreateObjectResult = z.infer<typeof CreateObjectResultSchema>;
export type CreatedObject = z.infer<typeof CreatedObjectSchema>;
export type DeclaredBy = z.infer<typeof DeclaredBySchema>;
export type DefinitionDetail = z.infer<typeof DefinitionDetailSchema>;
export type DisplayLabels = z.infer<typeof DisplayLabelsSchema>;
export type DissolveObjectInput = z.infer<typeof DissolveObjectInputSchema>;
export type EmbedTarget = z.infer<typeof EmbedTargetSchema>;
export type ExampleKind = z.infer<typeof ExampleKindSchema>;
export type ExpressionIdRemap = z.infer<typeof ExpressionIdRemapSchema>;
export type ExtractedStructureEnvelope = z.infer<typeof ExtractedStructureEnvelopeSchema>;
export type Handle = z.infer<typeof HandleSchema>;
export type HandleScope = z.infer<typeof HandleScopeSchema>;
export type HandleStatus = z.infer<typeof HandleStatusSchema>;
export type Inline = z.infer<typeof InlineSchema>;
export type InputSyntax = z.infer<typeof InputSyntaxSchema>;
export type InsertReferenceInput = z.infer<typeof InsertReferenceInputSchema>;
export type Link = z.infer<typeof LinkSchema>;
export type LinkDraft = z.infer<typeof LinkDraftSchema>;
export type LinkStatus = z.infer<typeof LinkStatusSchema>;
export type LinkType = z.infer<typeof LinkTypeSchema>;
export type MaterializeObjectInput = z.infer<typeof MaterializeObjectInputSchema>;
export type MathContent = z.infer<typeof MathContentSchema>;
export type MathExpression = z.infer<typeof MathExpressionSchema>;
export type Mathpack = z.infer<typeof MathpackSchema>;
export type MathpackCounts = z.infer<typeof MathpackCountsSchema>;
export type MathpackGraph = z.infer<typeof MathpackGraphSchema>;
export type MathpackImport = z.infer<typeof MathpackImportSchema>;
export type MathpackImportResult = z.infer<typeof MathpackImportResultSchema>;
export type MathpackManifest = z.infer<typeof MathpackManifestSchema>;
export type MathpackMeta = z.infer<typeof MathpackMetaSchema>;
export type MathpackResult = z.infer<typeof MathpackResultSchema>;
export type MergeUnitsInput = z.infer<typeof MergeUnitsInputSchema>;
export type NumberingPolicy = z.infer<typeof NumberingPolicySchema>;
export type NumberingResult = z.infer<typeof NumberingResultSchema>;
export type ObjectPatch = z.infer<typeof ObjectPatchSchema>;
export type ObjectResult = z.infer<typeof ObjectResultSchema>;
export type ObjectStatus = z.infer<typeof ObjectStatusSchema>;
export type ObjectType = z.infer<typeof ObjectTypeSchema>;
export type ObjectVersion = z.infer<typeof ObjectVersionSchema>;
export type Occurrence = z.infer<typeof OccurrenceSchema>;
export type OccurrenceTarget = z.infer<typeof OccurrenceTargetSchema>;
export type OpContext = z.infer<typeof OpContextSchema>;
export type OpOutcome = z.infer<typeof OpOutcomeSchema>;
export type OpOutcomeResult = z.infer<typeof OpOutcomeResultSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type ParseStatus = z.infer<typeof ParseStatusSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ProvenanceDerivation = z.infer<typeof ProvenanceDerivationSchema>;
export type ReferenceTarget = z.infer<typeof ReferenceTargetSchema>;
export type RehomeSubtreeInput = z.infer<typeof RehomeSubtreeInputSchema>;
export type ResolveOccurrenceInput = z.infer<typeof ResolveOccurrenceInputSchema>;
export type ResolveTarget = z.infer<typeof ResolveTargetSchema>;
export type RewriteSurfaceInput = z.infer<typeof RewriteSurfaceInputSchema>;
export type SetUnitTypeInput = z.infer<typeof SetUnitTypeInputSchema>;
export type SplitUnitInput = z.infer<typeof SplitUnitInputSchema>;
export type SurfaceFormat = z.infer<typeof SurfaceFormatSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type Tagging = z.infer<typeof TaggingSchema>;
export type TargetSelector = z.infer<typeof TargetSelectorSchema>;
export type ToggleExpressionPlacementInput = z.infer<typeof ToggleExpressionPlacementInputSchema>;
export type Unit = z.infer<typeof UnitSchema>;
export type UnitContent = z.infer<typeof UnitContentSchema>;
export type UnitIdRemap = z.infer<typeof UnitIdRemapSchema>;
export type UnitLabel = z.infer<typeof UnitLabelSchema>;
export type UnitStatus = z.infer<typeof UnitStatusSchema>;
export type UnitType = z.infer<typeof UnitTypeSchema>;
export type ValidationError = z.infer<typeof ValidationErrorSchema>;

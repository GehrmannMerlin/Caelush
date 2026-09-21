/**
 * Legacy batch error facade.
 *
 * ```text
 * canonical declaration   @caelush/agent  (packages/agent/src/tools/batch/batch-errors.ts)
 * this module             a re-export of the same two classes
 * ```
 *
 * These are **not** second declarations. `instanceof` is load-bearing in the Run Layer, which decides
 * between a model error and an infrastructure error by class, so a structurally identical class declared
 * twice would send one of those decisions down the wrong branch depending on which package a caller
 * imported. Re-exporting keeps
 *
 * ```text
 * one declaration
 * one instanceof identity
 * ```
 *
 * and lets an existing legacy caller keep importing `@caelush/tools` unchanged.
 */

export { ToolBatchInfrastructureError, ToolBatchInputError } from "@caelush/agent";

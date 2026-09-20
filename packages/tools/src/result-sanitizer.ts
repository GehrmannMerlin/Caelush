/**
 * The legacy result sanitizer port.
 *
 * ```text
 * @caelush/agent      declares ToolResultSanitizerPort
 * @caelush/security   implements it
 * @caelush/tools      re-exports it, under the name an existing caller imports
 * ```
 *
 * There is no second interface declaration and no second redaction implementation. The canonical
 * port and this name denote one contract: one `sanitize` call with a tool name, a result and the
 * invocation it belongs to.
 */
export type { ToolResultSanitizerPort } from "@caelush/agent";

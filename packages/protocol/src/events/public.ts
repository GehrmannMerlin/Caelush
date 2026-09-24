import { z } from "zod";
import type { EventVisibility } from "./base.js";
import { getRunEventTypeDefinition } from "./catalog.js";

export type PublicRunEventFrom<TRunEvent> = TRunEvent extends {
  readonly visibility: EventVisibility;
}
  ? Omit<TRunEvent, "visibility"> & { readonly visibility: "USER_VISIBLE" }
  : never;

/**
 * Builds the public event contract from the canonical internal event schema.
 *
 * The public boundary deliberately reuses the explicit registered event schemas, then adds two
 * independent guards: the event instance must be USER_VISIBLE and the static catalog must also
 * classify its type as USER_VISIBLE. The latter prevents a DEBUG event from becoming public merely
 * because an untrusted producer supplied a different visibility value.
 */
export function createPublicRunEventSchema<
  TRunEvent extends {
    readonly type: string;
    readonly schemaVersion: number;
    readonly visibility: EventVisibility;
  },
>(runEventSchema: z.ZodType<TRunEvent>) {
  return runEventSchema
    .and(z.object({ visibility: z.literal("USER_VISIBLE") }))
    .superRefine((event, context) => {
      const definition = getRunEventTypeDefinition(event.type, event.schemaVersion);
      if (definition?.visibility !== "USER_VISIBLE") {
        context.addIssue({
          code: "custom",
          path: ["type"],
          message: "event type is not allowed on the ordinary public stream",
        });
      }
    });
}

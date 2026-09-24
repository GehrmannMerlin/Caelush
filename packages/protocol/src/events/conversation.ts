import { z } from "zod";
import { createEventSchema } from "./base.js";

/**
 * A durable notification that one Message V2 record was committed.
 *
 * The record itself remains the conversation authority. This event deliberately carries only
 * stable identifiers and the message kind so clients can invalidate a transcript without receiving
 * conversation content, provider state, or projected Tool output on the event stream.
 */
export const ConversationMessageCommittedEventSchema = createEventSchema(
  "conversation.message.committed",
  z
    .object({
      messageId: z.string().min(1),
      conversationTurnId: z.string().min(1),
      messageType: z.string().min(1),
    })
    .strict(),
);

export type ConversationMessageCommittedEvent = z.infer<
  typeof ConversationMessageCommittedEventSchema
>;

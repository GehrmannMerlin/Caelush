import { z } from "zod";
import { AgentErrorSchema } from "../error.js";
import { createEventSchema } from "./base.js";

export const ErrorEventSchema = createEventSchema(
  "error",
  z.object({ error: AgentErrorSchema }).strict(),
);
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

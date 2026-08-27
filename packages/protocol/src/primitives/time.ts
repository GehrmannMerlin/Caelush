import { z } from "zod";

export const TimestampMsSchema = z.number().int().nonnegative().brand<"TimestampMs">();
export type TimestampMs = z.infer<typeof TimestampMsSchema>;

export function createTimestampMs(value: number): TimestampMs {
  return TimestampMsSchema.parse(value);
}

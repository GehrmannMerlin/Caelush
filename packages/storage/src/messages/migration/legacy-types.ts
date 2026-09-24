import type { LegacyParsedMessage } from "../legacy/legacy-llm-message-codec.js";

/** Parser contract used only while upgrading pre-Phase-5F database rows. */
export type LegacyMessageParser = (rawDataJson: string) => LegacyParsedMessage;

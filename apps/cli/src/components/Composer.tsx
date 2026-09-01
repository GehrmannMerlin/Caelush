import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

export function Composer({
  enabled,
  onSubmit,
}: {
  readonly enabled: boolean;
  readonly onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = async (submitted: string) => {
    if (await onSubmit(submitted)) setValue("");
  };
  return (
    <Box>
      <Text color={enabled ? "green" : "gray"}>{enabled ? "> " : "- "}</Text>
      <TextInput value={value} onChange={setValue} onSubmit={submit} focus={enabled} />
    </Box>
  );
}

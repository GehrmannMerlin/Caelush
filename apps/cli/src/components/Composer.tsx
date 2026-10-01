import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

export function Composer({
  enabled,
  permissionLabel,
  onSubmit,
}: {
  readonly enabled: boolean;
  readonly permissionLabel?: string | undefined;
  readonly onSubmit: (value: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");
  const submit = async (submitted: string) => {
    if (await onSubmit(submitted)) setValue("");
  };
  return (
    <Box>
      <Text color={enabled ? "green" : "gray"}>{enabled ? "> " : "- "}</Text>
      {permissionLabel === undefined ? null : <Text color="gray">[{permissionLabel}] </Text>}
      <TextInput value={value} onChange={setValue} onSubmit={submit} focus={enabled} />
    </Box>
  );
}

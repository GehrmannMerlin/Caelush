import { Text } from "ink";

export function FatalError({ message }: { readonly message: string }) {
  return <Text color="red">Error: {message}</Text>;
}

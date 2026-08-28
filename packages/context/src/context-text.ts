export function modelPath(targetPath: string): string {
  return targetPath.replaceAll("\\", "/");
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function cdata(value: string): string {
  return value.replaceAll("]]>", "]]]]><![CDATA[>");
}

export function truncateUtf8Bytes(
  value: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return { text: value.slice(0, end), truncated: true };
}

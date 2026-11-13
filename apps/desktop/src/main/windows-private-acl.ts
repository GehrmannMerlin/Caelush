/** Windows service principals retain access to user-owned data on standard Windows installations. */
export const WINDOWS_PRIVILEGED_SIDS = ["S-1-5-18", "S-1-5-32-544"] as const;

/** Verify the SID-based ACL snapshot produced by `icacls /save`, whose SDDL is locale-neutral. */
export function verifyPrivateWindowsAcl(
  snapshot: string,
  userSid: string,
  localAdministratorSid?: string,
): void {
  const daclLine = snapshot.split(/\r?\n/u).find((line) => /^D:(?:(?:P|AI|AR))*\(/u.test(line));
  const dacl = daclLine?.match(/^D:(?:(?:P|AI|AR))*((?:\([^()]+\))+)/u)?.[1];
  if (dacl === undefined) throw new Error("Windows ACL is invalid.");

  const entries = [...dacl.matchAll(/\(([^()]+)\)/gu)].map((match) => {
    const fields = match[1]?.split(";") ?? [];
    if (fields.length !== 6) throw new Error("Windows ACL is invalid.");
    return {
      access: fields[0],
      rights: fields[2],
      sid: normalizeWindowsSddlSid(fields[5], localAdministratorSid),
    };
  });
  const isFullControl = (rights: string | undefined) => rights === "FA" || rights === "0x10000000";
  const userFullControl = entries.some(
    (entry) => entry.access === "A" && entry.sid === userSid && isFullControl(entry.rights),
  );
  const unsafeAccess = entries.some((entry) => {
    if (entry.access !== "A") return true;
    if (entry.rights === "" || entry.sid === userSid) return false;
    const isTrustedWindowsSid = WINDOWS_PRIVILEGED_SIDS.some((sid) => sid === entry.sid);
    return !isTrustedWindowsSid || !isFullControl(entry.rights);
  });
  if (!userFullControl || unsafeAccess) throw new Error("Windows ACL is not private.");
}

function normalizeWindowsSddlSid(sid: string | undefined, localAdministratorSid?: string) {
  switch (sid) {
    case "SY":
      return "S-1-5-18";
    case "BA":
      return "S-1-5-32-544";
    case "LA":
      return localAdministratorSid;
    default:
      return sid;
  }
}

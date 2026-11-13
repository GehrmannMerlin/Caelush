import { expect, it } from "vitest";
import { verifyPrivateWindowsAcl } from "../../src/main/windows-private-acl.js";

const userSid = "S-1-5-21-100-200-300-1001";

function snapshot(...aces: string[]) {
  return `D:P${aces.map((ace) => `(${ace})`).join("")}`;
}

function allow(sid: string, rights = "FA") {
  return `A;OICI;${rights};;;${sid}`;
}

it("accepts a protected ACL granted only to the current user", () => {
  expect(() => verifyPrivateWindowsAcl(snapshot(allow(userSid)), userSid)).not.toThrow();
});

it("accepts the Windows SYSTEM and Administrators principals alongside the current user", () => {
  expect(() =>
    verifyPrivateWindowsAcl(
      snapshot(allow(userSid), allow("S-1-5-18"), allow("S-1-5-32-544")),
      userSid,
    ),
  ).not.toThrow();
});

it("requires trusted machine principals to have full control", () => {
  expect(() =>
    verifyPrivateWindowsAcl(snapshot(allow(userSid), allow("S-1-5-18", "GR")), userSid),
  ).toThrow();
});

it("continues to reject access granted to other Windows users", () => {
  expect(() =>
    verifyPrivateWindowsAcl(snapshot(allow(userSid), allow("S-1-5-11", "GR")), userSid),
  ).toThrow();
});

import { describe, expect, it } from "vitest";
import { DECLINE_COOKIES } from "../src/browser/consent.js";

describe("the choice a cookie banner offers", () => {
  it("recognizes the least-permissive button OneTrust uses", () => {
    expect(DECLINE_COOKIES.test("Only Necessary Cookies")).toBe(true);
  });
  it("recognizes the other common wordings", () => {
    for (const words of ["Necessary only", "Necessary cookies only", "Reject all", "Decline", "Deny"]) {
      expect(DECLINE_COOKIES.test(words)).toBe(true);
    }
  });
  it("never takes a button that allows more", () => {
    for (const words of ["Accept All Cookies", "Accept", "Allow all", "Cookies Settings", "Save and accept"]) {
      expect(DECLINE_COOKIES.test(words)).toBe(false);
    }
  });
});

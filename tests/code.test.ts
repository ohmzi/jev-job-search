import { describe, expect, it } from "vitest";
import { FieldsDump } from "../src/forms/fields.js";
import { cleanCode, codeTargetIn } from "../src/run/code.js";

const field = (over: Record<string, unknown>) => ({ id: "f0", selector: "#f0", kind: "text", ...over });

const dumpOf = (fields: Record<string, unknown>[]) => FieldsDump.parse({ url: "https://boards.greenhouse.io/acme/jobs/1", fields });

describe("the box that takes a mailed code", () => {
  it("takes the one box whose label asks for a security code", () => {
    const d = dumpOf([
      field({ id: "f0", selector: "#email", kind: "email", label: "Email" }),
      field({ id: "f1", selector: "#resume", kind: "file", label: "Resume" }),
      field({ id: "f2", selector: "#security-code", label: "Security code", required: true }),
      field({ id: "f3", selector: "#zip", label: "Postal code" }),
    ]);
    expect(codeTargetIn(d)).toEqual({ selector: "#security-code", kind: "text", label: "Security code" });
  });

  it("never mistakes another kind of code, or a choice, for it", () => {
    const d = dumpOf([
      field({ id: "f0", selector: "#zip", label: "Zip code" }),
      field({ id: "f1", selector: "#phone-code", label: "Country calling code" }),
      field({ id: "f2", selector: "#promo", label: "Promo code" }),
      field({ id: "f3", selector: "#ref", label: "Employee referral code" }),
      field({ id: "f4", selector: "#ok", kind: "checkbox", label: "I am human" }),
    ]);
    expect(codeTargetIn(d)).toMatchObject({ why: expect.stringContaining("no box") });
  });

  it("falls back to a plain code box when no label says security or verification", () => {
    const d = dumpOf([
      field({ id: "f0", selector: "#email", kind: "email", label: "Email" }),
      field({ id: "f1", selector: "#code", label: "Code" }),
    ]);
    expect(codeTargetIn(d)).toMatchObject({ selector: "#code" });
  });

  it("refuses to guess between two boxes that could take it", () => {
    const d = dumpOf([
      field({ id: "f0", selector: "#a", label: "Security code" }),
      field({ id: "f1", selector: "#b", label: "Verification code" }),
    ]);
    expect(codeTargetIn(d)).toMatchObject({ why: expect.stringContaining("2 boxes") });
  });

  it("says what it saw when there is no text box at all", () => {
    const d = dumpOf([field({ id: "f0", selector: "#f", kind: "file", label: "Resume" })]);
    expect(codeTargetIn(d)).toEqual({ why: "the form has no box that takes text" });
  });
});

describe("what is accepted as a code", () => {
  it("takes a code as the board writes it, and trims the input around it", () => {
    expect(cleanCode("  rymzF4mD\n")).toEqual({ code: "rymzF4mD" });
    const dashed = cleanCode("123-456");
    expect("code" in dashed && dashed.code).toBe("123-456");
  });

  it("refuses an empty input, a phrase, and anything that is not code-shaped", () => {
    expect(cleanCode("")).toHaveProperty("why");
    expect(cleanCode("   \n\n")).toHaveProperty("why");
    expect(cleanCode("here is the code 1234")).toHaveProperty("why");
    expect(cleanCode("abc")).toHaveProperty("why");
    expect(cleanCode("a".repeat(65))).toHaveProperty("why");
    expect(cleanCode("<script>alert(1)</script>")).toHaveProperty("why");
  });

  it("never repeats the text it refuses", () => {
    const why = (cleanCode("not a code at all") as { why: string }).why;
    expect(why).not.toContain("not a code");
  });
});

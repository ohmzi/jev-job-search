import { describe, expect, it } from "vitest";
import { FieldsDump, isApplicationForm } from "../src/forms/fields.js";
import { pickNext } from "../src/browser/report.js";

const dump = (over: Record<string, unknown> = {}) =>
  FieldsDump.parse({ url: "https://www.linkedin.com/jobs/view/4483157190/", fields: [], ...over });

describe("a LinkedIn Easy Apply dialog", () => {
  it("is an application even when LinkedIn already holds the name", () => {
    const d = dump({
      easyApply: true,
      fields: [
        { id: "f0", selector: "#email", kind: "email", label: "Email address", required: true },
        { id: "f1", selector: "#phone", kind: "tel", label: "Mobile phone number", required: false },
      ],
    });
    expect(isApplicationForm(d)).toBe(true);
  });

  it("is not an application when nothing marks it as one", () => {
    const d = dump({
      fields: [
        { id: "f0", selector: "#email", kind: "email", label: "Email or phone", required: true },
      ],
    });
    expect(isApplicationForm(d)).toBe(false);
  });
});

describe("the last forward step of the dialog", () => {
  it("takes Review as the way on inside the dialog", () => {
    expect(pickNext(["#next  /* Review */"], true)).toEqual({ selector: "#next", text: "Review" });
  });

  it("does not take Review as a way on for an ordinary form", () => {
    expect(pickNext(["#r  /* Review your answers */"])).toBeNull();
  });
});

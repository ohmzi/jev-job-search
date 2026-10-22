/**
 * Whether the apply loop can fill this posting's form. A board-only listing is not a form the
 * tool can read, so the hourly search keeps it for the person instead of putting it in the way
 * of an apply run. Workday counts only where the person has an account or allowed one.
 */
import { capabilityFor } from "../accounts/capability.js";
import type { Job } from "./normalize.js";

/** The boards whose forms the tool fills. SmartRecruiters is left out: its form cannot be read yet. */
export const FILLABLE_ATS: readonly string[] = ["greenhouse", "lever", "ashby", "jobvite", "rippling", "bamboohr"];

export function canFill(job: Pick<Job, "url" | "ats">): boolean {
  if (job.ats === "workday") return (capabilityFor(job.url)?.verdict ?? "no") !== "no";
  return FILLABLE_ATS.includes(job.ats);
}

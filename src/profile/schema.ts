/**
 * The candidate profile. The real file lives at data/profile.json and is
 * git-ignored. data/profile.example.json is the redacted template.
 * Every answer the tool writes into a form is derived from this file, the
 * answer bank, or the writer drafting free text from it. Nothing is invented.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { PATHS } from "../config.js";

const YesNo = z.enum(["yes", "no"]);
/** A voluntary self-identification question may be declined. */
const YesNoDecline = z.enum(["yes", "no", "decline"]);

/**
 * One portal's hourly search: the roles it wants and the places it counts as close. This is
 * candidate and region data, so it lives here and not in source. The four clones each carry
 * their own block.
 */
const SearchSchema = z.object({
  /** A short name for this portal, used in the scheduled job's name. */
  portal: z.string().min(1).max(60),
  /** Every regex must match the title. A title that matches none is not a role this portal wants. */
  titleInclude: z.array(z.string().min(1)).min(1),
  /** A title that matches any of these is left out (designers, managers, sales and the like). */
  titleExclude: z.array(z.string()).default([]),
  /** The terms handed to each board. */
  terms: z.array(z.string().min(1)).min(1),
  sites: z.array(z.enum(["indeed", "linkedin"])).default(["indeed", "linkedin"]),
  /** The Indeed country the searches belong to. */
  countryIndeed: z.string().min(2).max(60).default("USA"),
  resultsWanted: z.number().int().min(1).max(100).default(50),
  hoursOld: z.number().int().min(1).max(24).default(1),
  /** A run stops asking after this many calls, whatever the terms and places add up to. */
  maxQueries: z.number().int().min(1).max(30).default(12),
  /** Pause between two calls. */
  gapMs: z.number().int().min(0).max(60_000).default(4_000),
  /** The minute past each hour this portal's timer starts, so the four clones do not ask at once. */
  minuteOffset: z.number().int().min(0).max(59).default(0),
  /** One query per place. `accept` is tested against the location the board returns. */
  locations: z
    .array(
      z.object({
        query: z.string().min(1),
        distance: z.number().int().min(0).max(500).default(50),
        accept: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  /** Leave out a posting whose only location is Remote or the whole United States, so it cannot reach two portals. */
  excludeRemoteOnly: z.boolean().default(true),
  /** Employer names to leave out of this portal. */
  excludeCompanies: z.array(z.string()).default([]),
});
export type Search = z.infer<typeof SearchSchema>;

export const ProfileSchema = z.object({
  name: z.object({
    first: z.string().min(1),
    last: z.string().min(1),
    preferred: z.string().optional(),
  }),
  pronouns: z.string().optional(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  email: z.string().email(),
  phone: z.object({
    /** Digits only, no country code. */
    national: z.string().regex(/^\d{7,15}$/),
    countryCode: z.string().regex(/^\+\d{1,3}$/),
  }),
  address: z.object({
    line1: z.string(),
    line2: z.string().optional(),
    city: z.string(),
    region: z.string(),
    regionCode: z.string(),
    postalCode: z.string(),
    country: z.string(),
    countryCode: z.string().length(2),
  }),
  links: z.object({
    linkedin: z.string().url(),
    github: z.string().url(),
    website: z.string().url().optional(),
    portfolio: z.string().url().optional(),
  }),
  education: z
    .array(
      z.object({
        school: z.string(),
        degree: z.string(),
        field: z.string(),
        /** Other names the same field goes by, tried in this order on a list that does not have `field` ("Computer Science" for "Computing Science"). A box that takes any text still gets `field`. */
        fieldAlso: z.array(z.string()).optional(),
        minor: z.string().optional(),
        startMonth: z.number().int().min(1).max(12),
        startYear: z.number().int(),
        gradMonth: z.number().int().min(1).max(12),
        gradYear: z.number().int(),
        status: z.enum(["in_progress", "completed", "transferred", "attended"]),
        gpa: z
          .object({
            cumulative: z.number().optional(),
            major: z.number().optional(),
            scale: z.number().default(4),
            /** When false the GPA is only given if a form will not submit without it. */
            volunteer: z.boolean().default(false),
          })
          .optional(),
      }),
    )
    .min(1),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      location: z.string(),
      start: z.string(),
      end: z.string(),
      current: z.boolean().default(false),
      bullets: z.array(z.string()),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      start: z.string(),
      end: z.string(),
      link: z.string().optional(),
      bullets: z.array(z.string()),
    }),
  ),
  skills: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    tools: z.array(z.string()),
  }),
  spokenLanguages: z.array(z.object({ name: z.string(), level: z.string() })),
  workAuthorization: z.object({
    citizenships: z.array(z.string()).min(1),
    /** Countries where the candidate can work without sponsorship. */
    authorizedCountries: z.array(z.string()).min(1),
    /** Whether sponsorship would be needed in any country not listed above. */
    requiresSponsorshipElsewhere: z.boolean(),
    /** One sentence, used verbatim when a form asks to explain status. */
    statement: z.string(),
  }),
  demographics: z.object({
    gender: z.string(),
    ethnicity: z.string(),
    hispanicOrLatino: YesNoDecline,
    veteran: YesNoDecline,
    disability: YesNoDecline,
    sexualOrientation: z.string(),
    transgender: YesNoDecline,
  }),
  preferences: z.object({
    earliestStart: z.string(),
    availability: z.string(),
    /** Left empty on purpose: the tool never volunteers a number. */
    salaryExpectation: z.string(),
    /** What goes in a salary box that will not submit empty, when salaryExpectation is empty. */
    salaryIfRequired: z.string().default("Negotiable"),
    willingToRelocate: YesNo,
    remote: z.enum(["preferred", "open", "no"]),
    preferredLocations: z.array(z.string()),
    howDidYouHear: z.string(),
    /** What to do when a form requires references. "skip" logs and moves on. */
    references: z.enum(["skip"]),
    /** "never" skips a form that requires one. "when_asked" writes a cover letter for this job whenever a form has a box for one, as if apply --cover. */
    coverLetter: z.enum(["never", "when_asked"]),
  }),
  resume: z.object({
    /** Absolute path on the machine that runs the browser. */
    path: z.string(),
    filename: z.string(),
  }),
  /** An academic transcript, attached only to a file box that asks for one. Leave it out and such a form is held for you. */
  transcript: z.object({ path: z.string() }).optional(),
  /** Three or four sentences used as the candidate side of every JEV rating call. */
  summary: z.string().min(40),
  /** Short facts the writer may use when drafting free text. Nothing outside this list is claimed. */
  facts: z.array(z.string()),
  /** This portal's hourly search. Optional: a profile without it simply has no hourly run. */
  search: SearchSchema.optional(),
  /**
   * Standing answers: how the candidate wants a recurring question answered.
   * JEV reads them when it picks an option; the writer reads them when it drafts.
   */
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;

export function loadProfile(file = PATHS.profile): Profile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`No profile at ${file}. Copy data/profile.example.json to data/profile.json and fill it in.`);
  }
  const parsed = ProfileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`data/profile.json is invalid:\n${parsed.error.message}`);
  return parsed.data;
}

/**
 * The candidate's standing in the United States. Most postings on the lists are American and many
 * refuse sponsorship, so discovery needs to know whether that rules the candidate out.
 */
export function usStatus(profile: Pick<Profile, "workAuthorization">): { authorized: boolean; citizen: boolean } {
  const isUs = (c: string) => /^(united states( of america)?|u\.?s\.?a?\.?)$/i.test(c.trim());
  return { authorized: profile.workAuthorization.authorizedCountries.some(isUs), citizen: profile.workAuthorization.citizenships.some(isUs) };
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export function monthName(m: number): string {
  return MONTHS[m - 1] ?? String(m);
}

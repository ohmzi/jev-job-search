/**
 * Single source of every tunable: paths, thresholds, weights, limits.
 * Nothing else in the codebase hardcodes a number that changes behaviour.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, "data"),
  profile: path.join(ROOT, "data", "profile.json"),
  profileExample: path.join(ROOT, "data", "profile.example.json"),
  /** The style guide for written answers. data/voice.local.md, when present, is the candidate's own and wins over the shipped one. */
  voice: existsSync(path.join(ROOT, "data", "voice.local.md")) ? path.join(ROOT, "data", "voice.local.md") : path.join(ROOT, "data", "voice.md"),
  bank: path.join(ROOT, "data", "bank.json"),
  bankExample: path.join(ROOT, "data", "bank.example.json"),
  queue: path.join(ROOT, "data", "queue.json"),
  /** Every job the tool considered, with what happened to it. */
  /** The four records a person reads, in one folder at the top of the project: applications/. */
  applications: path.join(ROOT, "applications", "all.csv"),
  /** Only the applications that were sent, newest first. It sits at the top of the folder so it is easy to find. */
  applied: path.join(ROOT, "applications", "applied.csv"),
  /** Answers the writer has given before, kept so the same question is not paid for twice. */
  memory: path.join(ROOT, "data", "memory.json"),
  /** Answers the LinkedIn Easy Apply walk filled in on its own, kept until a person confirms them. */
  learned: path.join(ROOT, "data", "learned.json"),
  cache: path.join(ROOT, "data", "cache"),
  /** What every user's runs have taught the tool about sites. Shipped with the repository. */
  knowledgeShipped: path.join(ROOT, "knowledge", "sites.json"),
  /** What this machine's runs have learned since. Merged with the shipped notes on reading. */
  knowledgeLocal: path.join(ROOT, "data", "knowledge.json"),
  /** Left by earlier versions: sites found behind a sign-in. Read once more and folded into the notes above. */
  walledHosts: path.join(ROOT, "data", "cache", "walled-hosts.json"),
  /** JEV's ratings of postings, kept so an unchanged posting is not rated again. */
  ratings: path.join(ROOT, "data", "cache", "ratings.json"),
  /** The employer links the Indeed and LinkedIn MCPs gave for board listings, and the listings they had none for. */
  listingLinks: path.join(ROOT, "data", "cache", "listing-links.json"),
  /** JEV's field mappings of forms, kept so an unchanged form is not mapped again. */
  plans: path.join(ROOT, "data", "cache", "plans.json"),
  /** Jobs the tool could not finish and left for the person, with the reason and the link. */
  manual: path.join(ROOT, "applications", "manual.csv"),
  /** Applications sent to a company that also wants a take-home assignment: the link and the instructions, for the person to do. */
  takehome: path.join(ROOT, "applications", "takehome.csv"),
  runs: path.join(ROOT, "data", "runs"),
  /** The person's standing instructions for the daily run. Without this file `daily` does nothing. */
  policy: path.join(ROOT, "data", "policy.json"),
  policyExample: path.join(ROOT, "data", "policy.example.json"),
  /** Emails already looked at for replies, and the ones waiting for the person to confirm. */
  inbox: path.join(ROOT, "data", "runs", "inbox.json"),
  /** Boards the daily run leaves alone until a date, because they asked for a human check or refused a burst. */
  boardPauses: path.join(ROOT, "data", "runs", "board-pauses.json"),
  /** Left by the person to ask a daily run that is working to stop after its current application. */
  dailyStop: path.join(ROOT, "data", "runs", "daily.stop"),
  /** What the scheduled run prints. */
  dailyLog: path.join(ROOT, "data", "runs", "daily.log"),
  /** What the scheduled hourly search prints. */
  hourlyLog: path.join(ROOT, "data", "runs", "hourly.log"),
  /** When the hourly search last completed successfully, so a missed hour is not lost. */
  hourlyState: path.join(ROOT, "data", "runs", "hourly.json"),
  /** The employer-board postings this portal's hourly search has seen, so a posting with only a date counts as new once. */
  hourlyBoardsSeen: path.join(ROOT, "data", "runs", "hourly-boards.json"),
  /** What a dashboard running as a service prints. */
  reportLog: path.join(ROOT, "data", "runs", "report.log"),
  /** The job-board accounts the person allowed, and the rule for making new ones. No secret is in it. */
  accounts: path.join(ROOT, "data", "accounts.json"),
  accountsExample: path.join(ROOT, "data", "accounts.example.json"),
  /** What the tool remembers about each account between runs: when it last signed in, attempts, a pause after a lockout. */
  accountsState: path.join(ROOT, "data", "runs", "accounts-state.json"),
  /** The Gmail connection: the OAuth client id and the address. The tokens are in the Keychain. */
  gmail: path.join(ROOT, "data", "gmail.json"),
  /** Verification emails already used, so one message never answers two requests. */
  verifications: path.join(ROOT, "data", "runs", "verifications.json"),
  /** Short locks around read-modify-write of the records, and the lock a browser run holds. */
  locks: path.join(ROOT, "data", "runs", "locks"),
  runLock: path.join(ROOT, "data", "runs", "run.lock"),
  jevUsage: path.join(ROOT, "data", "runs", "jev-usage.jsonl"),
  writerUsage: path.join(ROOT, "data", "runs", "writer-usage.jsonl"),
  imports: path.join(ROOT, "data", "imports"),
  /** Tailored resumes and cover letters, one folder per job: documents/tailored/<Company>_<Role>_<job id>/. */
  documents: path.join(ROOT, "documents", "tailored"),
  /** The person's own files, at the top of the project: the resume to send, a transcript, and the tailored pairs under tailored/. */
  documentsDir: path.join(ROOT, "documents"),
  browserScripts: path.join(ROOT, "src", "forms"),
} as const;

/** Loads KEY=value lines from .env into process.env without overriding existing values. */
export function loadEnv(file = path.join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const DEEPSEEK = {
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-flash",
  /** Context window. Requests stay well under it. */
  contextTokens: 128_000,
  /** Approximate budget for the job description inside a rating request (chars, ~4 chars per token). */
  maxDescriptionChars: 14_000,
  /** Approximate budget for a page's text when deciding page state. */
  maxPageTextChars: 8_000,
  timeoutMs: 60_000,
  maxRetries: 3,
  retryBaseMs: 500,
  /** Hard stop for one run, in USD. */
  runSpendCapUsd: 1.0,
  /** List prices per million tokens, used to estimate spend from usage. Update when DeepSeek changes them. */
  pricePerMillionInputUsd: 0.28,
  pricePerMillionCachedInputUsd: 0.028,
  pricePerMillionOutputUsd: 0.42,
} as const;

/**
 * Finding the employer's own form behind an Indeed or LinkedIn listing. Each board's MCP server is
 * started as a child process and asked for the posting's apply link. The Indeed server only reads
 * the posting. The LinkedIn fork reads it too, and its apply tool walks LinkedIn's own wizard and
 * sends an Easy Apply application. Otherwise what comes back is a link, and the existing Chrome
 * flow fills it. An MCP that fails or has no link leaves the listing to Chrome, which follows the
 * page's Apply button.
 */
export const MCP = {
  /** Longest wait for a server to start and answer its handshake. The first start pulls an image or a package. */
  startupMs: 90_000,
  /** Longest wait for one tool call. */
  callMs: 30_000,
  /** Longest wait for an Easy Apply walk, which fills every page of the wizard and presses submit. */
  applyCallMs: 240_000,
  /** The most listings one hourly search or apply pass asks the servers about. */
  maxPerRun: 30,
  /** A listing the servers had no employer link for is not asked about again for this long. */
  retryAfterHours: 6,
  /**
   * LinkedIn: the local fork, whose read tool says how a posting takes applications and whose apply
   * tool sends one. `--project` installs and imports the fork, but unlike `--directory` it leaves the
   * child's working directory alone, so the fork resolves the apply identity for this project's
   * folder rather than always falling back to its default.
   */
  linkedin: { command: "uv", args: ["run", "--project", "/home/ohmz/StudioProjects/linkedin-mcp-server", "python", "-m", "linkedin_mcp_server"], tools: { search: "search_jobs", read: "get_job_apply_url", details: "get_job_details", apply: "apply_to_job" } },
  /** Indeed: the openings-mcp image, whose read tool returns a posting's details. */
  indeed: { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/amikai/openings-mcp"], tools: { read: "indeed_get_job_detail" } },
  /** The openings-mcp Indeed tools want a country name. The profile keeps JobSpy's spelling. */
  indeedCountries: { USA: "United States", US: "United States", UK: "United Kingdom", Canada: "Canada", Australia: "Australia", Ireland: "Ireland", India: "India", Germany: "Germany", France: "France", Netherlands: "Netherlands", Singapore: "Singapore" } as Record<string, string>,
  /** Hosts that are the board itself, not an employer. A link on one of these is not the employer's form. */
  boardHosts: ["linkedin.com", "licdn.com", "lnkd.in", "indeed.com", "indeedapps.com", "indeed.net", "indeedcdn.com"],
} as const;

/** The local LinkedIn fork's saved session, and the known-good copy kept beside it. */
const linkedinForkDir = (() => {
  const args: readonly string[] = MCP.linkedin.args;
  const at = args.indexOf("--project");
  const dir = at >= 0 ? args[at + 1] : undefined;
  if (!dir) throw new Error("MCP.linkedin.args must name a --project directory");
  return dir;
})();

export const LINKEDIN_SESSION = {
  /** Where the MCP keeps its saved session: cookies.json, source-state.json, profile/. */
  authRoot: path.join(os.homedir(), ".linkedin-mcp"),
  /** The known-good copy, written after a successful login. */
  backupRoot: path.join(os.homedir(), ".linkedin-mcp-backup"),
  /** The fork's checkout, read from MCP.linkedin.args' --project value. */
  forkDir: linkedinForkDir,
  /**
   * Signing in again without the person. The fork's own `--login` signs in with the email and password
   * in the credentials file the person made for it, and falls back to a window on a challenge. This
   * tool never opens that file: it only starts the fork's login, at most once per outage.
   */
  autoRelogin: {
    enabled: true,
    credentialsFile: path.join(os.homedir(), ".linkedin-mcp", "credentials.env"),
    /** Longest the fork's login may run before it is stopped. */
    timeoutMs: 240_000,
    /** When the fork says LinkedIn asked for a check only a person can pass, its window stays open this long for them. */
    personWaitMs: 10 * 60_000,
    /** After a login that worked, the next automatic one waits this long: a session LinkedIn revokes again at once is the person's. */
    minHoursBetween: 6,
  },
} as const;

export const DISCOVER = {
  /** Only postings this fresh are considered. */
  maxAgeDays: 14,
  /** Concurrency for description fetches. */
  fetchConcurrency: 8,
  /** Concurrency for JEV rating calls. */
  rateConcurrency: 6,
  /** Fetch timeout for job pages and ATS APIs. */
  fetchTimeoutMs: 15_000,
  /** How many jobs to surface in the queue per run. */
  queueSize: 150,
  /**
   * Minimum composite score to be queued. Hard rules (work authorization,
   * degree, pay, level) are skips, not scores, so this only trims the long
   * tail of weak matches. The queue is ranked, so the best apply first.
   */
  applyThreshold: 0.3,
  /**
   * Careers sites known to need an account or a login before the form, by hostname fragment.
   * Jobs there are skipped before rating. Sites the apply run finds walled are remembered in
   * data/cache/walled-hosts.json and skipped the same way next time.
   */
  accountWalledHosts: ["eightfold.ai", "careers.microsoft.com", "jobs.intuit.com", "jobs.ea.com"],
  /** Job boards whose forms the page scripts cannot read yet. Their jobs are skipped with that reason. */
  unreadableAts: ["smartrecruiters"],
} as const;

/** Reading employers' own boards: Greenhouse, Lever, Ashby and Workable in full, Workday by search. */
export const ATS_SEARCH = {
  /** Workday answers at most this many postings a page. */
  workdayPageSize: 20,
  /** Pages read for one term on one Workday site. Workday does not sort by date, so this bounds the read. */
  workdayMaxPages: 3,
  /** What a board's search is asked when the profile has no portal search. */
  defaultTerms: ["software engineer"],
  /** A board title is kept without a portal search when it says one of these. */
  defaultTitle: "software|developer|engineer|programm|full[- ]stack|backend|frontend|android|ios|mobile",
  /** Roles for students and new graduates. A board posting whose title says one is never kept. */
  earlyCareerTitle: "\\b(intern|interns|internship|co-?op|new grad|new graduate|graduate program|early career|early-career|university|student|campus|apprentice|apprenticeship)\\b",
} as const;

/**
 * freehire.me, read through the openings-mcp server the Indeed lookup already starts. It crawls
 * many employers' boards, so it is used to find employers jev does not know yet. Only postings it
 * crawled from a board jev can fill are kept, and only those it judges fresh and not recycled.
 */
export const FREEHIRE = {
  tool: "freehire_search_jobs",
  /** The boards a posting may come from. Aggregators and staffing systems are left out. */
  sources: ["greenhouse", "lever", "ashby", "workable", "workday", "bamboohr", "rippling", "jobvite", "jazzhr"],
  employmentTypes: ["full_time"],
  pageSize: 100,
  /** Pages read for one term. */
  maxPages: 2,
  /** A posting re-listed more often than this reads as a pipeline ad, not an opening. */
  maxReposts: 3,
  /** Pause between two calls. */
  gapMs: 2_000,
  /** freehire wants a lowercase country code. The profile keeps JobSpy's spelling. */
  countries: { USA: "us", US: "us", UK: "gb", Canada: "ca", Australia: "au", Ireland: "ie", India: "in", Germany: "de", France: "fr", Netherlands: "nl", Singapore: "sg" } as Record<string, string>,
} as const;

/**
 * Composite fit score. Every component is 0..1 before weighting.
 * Weights sum to 1; location and recency are multipliers applied after.
 */
export const FIT_WEIGHTS = {
  stackMatch: 0.22,
  experienceMatch: 0.18,
  callbackLikelihood: 0.3,
  levelFit: 0.15,
  termFit: 0.1,
  interviewPractical: 0.05,
} as const;

export const LOCATION_MULTIPLIER = {
  vancouver: 1.0,
  canada: 0.92,
  remote: 0.9,
  us: 0.75,
  international: 0.6,
  unclear: 0.7,
} as const;

/** Applied when the posting asks for a graduation date the candidate does not have. They can still apply, so it ranks lower instead of being dropped. */
export const GRADUATION_MISMATCH_MULTIPLIER = 0.6;

/** Recency multiplier: 1.0 for today, decaying linearly to this floor at maxAgeDays. */
export const RECENCY_FLOOR = 0.7;

export const FORM = {
  /** JEV confidence at or above which a mapping is applied without note. */
  autoConfidence: 0.9,
  /** Below this, the writer decides the field by hand. */
  reviewConfidence: 0.5,
  /**
   * Stricter rules for the answers that must be true. A checkbox is ticked at or above `tick` and
   * left at or below `leave`; between the two a person decides. An answer about the right to work
   * whose option is not a plain yes or no needs `authority` confidence. A choice among at most
   * `statementOptions` statements about the person that code cannot check (can you work in the
   * office, yes or no; office, hybrid or remote) is filled at or above `statement`; below it the
   * writer answers from the facts and the standing answers.
   */
  gates: { tick: 0.7, leave: 0.3, authority: 0.85, statement: 0.8, statementOptions: 6 },
  /** An answer this short (or a plain yes or no) must be what the box shows, not merely inside it: "No" is not "Not applicable". */
  shortAnswerChars: 3,
  /** Selects with more options than this are pre-filtered in code before JEV sees them. */
  maxOptionsForJev: 40,
  /** How many lists under a list a dropdown is followed into: a choice that is a heading opens the choices under it. */
  maxListLevels: 2,
  /** How many items of a list of several (skills) are searched for and picked in a box that takes many. */
  maxListPicks: 8,
  /** How many extra copies of an attached file are taken off a form that kept them from earlier visits. */
  maxExtraCopies: 5,
  /** How many screens of a list that only draws the rows in view are gone through, and how many of its choices are named when none fits. */
  maxListScreens: 25,
  maxListed: 120,
  /** How many times a page that grew while its lists were being read is read again before it is planned. */
  rereads: 3,
  /** How many of a form's boxes may be switched off when it is read back before the page counts as not on screen: this many, or this share of its boxes, whichever is more. */
  maxSwitchedOff: 3,
  switchedOffShare: 0.34,
  /** How many times an option's place is read while waiting for two reads in a row to agree, before the click is given up. */
  steadyReads: 6,
  /** How many times a page is read again after a fill, for questions that only appear once another is answered. */
  followUpRounds: 3,
  /** The most optional fields that may be left blank because they could not be set. More than this means the fill itself went wrong, and the form is held. */
  maxLeftBlank: 2,
  /** Fields per JEV call. Larger forms are split into several calls. */
  fieldsPerCall: 40,
} as const;

/** Answers JEV already gave to an unchanged question are reused. Turning this off only costs money and time. */
export const CACHE = {
  ratings: true,
  plans: true,
  /** The most form mappings kept. Each is a few kilobytes. */
  maxPlans: 400,
} as const;

export const BROWSER = {
  /** The Chrome binary the fill runner drives over the DevTools protocol. */
  chromePath: "/usr/bin/google-chrome",
  /** Local DevTools port of the runner's own Chrome window. */
  port: 9333,
  /**
   * One Chrome profile for every portal, outside the repositories. A sign-in the person does once
   * is reused by all four. The profile holds browser sessions, never a password the tool knows.
   */
  profileDir: path.join(process.env.JEV_SHARED_DIR?.trim() || path.join(os.homedir(), ".local", "state", "jev"), "chrome-profile"),
  /** Longest wait for a page to load and its form controls to stop changing. */
  settleMs: 15_000,
  /** A form whose labels keep changing is taken as settled once its controls have held still for this many reads. */
  settleCountPolls: 12,
  /** How long a loaded page with no form controls is given before it is read as having no form. */
  emptyPageMs: 6_000,
  /** Longest wait for a dropdown's options to appear after a click or typing. */
  optionsMs: 4_000,
  /** A page that answered with an error is reopened once after this pause. */
  retryAfterMs: 8_000,
  /** The most months a calendar is turned to reach a date. */
  calendarTurns: 48,
  /** Waits before a typed value the page did not keep is put back: once soon, once later. */
  putBackAfterMs: [1_500, 5_000],
  /** Longest wait for a form to finish saving one field to its own server before the next field is set. */
  saveMs: 3_000,
  /** Longest wait for an uploaded resume to reach the form's server. */
  uploadMs: 20_000,
  /** Longest wait for the page to change after Submit is clicked. */
  submitMs: 12_000,
  /** A page that still looks like the form after that, with no error on it, is given this much longer: some boards take their time to confirm. */
  confirmMs: 20_000,
  pollMs: 150,
  /** How often a handoff reads the page while the person works on a bot check. */
  captchaPollMs: 900,
  /** How long a bot check must stay clear, with its Submit control present, before the tool clicks. */
  captchaSettleMs: 1_500,
} as const;

/** The tool's own attempt at a bot check, before the person is asked. Nothing here solves a picture or a puzzle. */
export const PROTECTIONS = {
  /** The whole attempt at one challenge, across a click and the wait for its response. */
  attemptMs: 12_000,
  /** How long a widget is given to produce its response after its checkbox is clicked. */
  tokenWaitMs: 8_000,
  /** How often the page is read while a widget works. */
  pollMs: 250,
  /** A wall with no widget of its own is given this long to clear before the person is asked. */
  passiveWaitMs: 3_000,
  /** The checkbox sits this far from the left of a reCAPTCHA or Turnstile frame, and at this fraction of its height. */
  checkboxOffsetX: 28,
  checkboxOffsetY: 0.5,
  /** The pointer walks to the checkbox in this many moves, with this much jitter and this pause between them. */
  mouseSteps: 12,
  mouseJitterPx: 3,
  mouseStepMs: 12,
} as const;

/**
 * The writer for what JEV cannot type: open questions, fields it was unsure of, the two sheet notes,
 * and tailored resumes and cover letters. It is DeepSeek, reached with the same key as JEV, asked for
 * free text in a JSON object. No other model is called for writing.
 */
export const WRITER = {
  /** The model the writer asks for. WRITER_MODEL overrides it; otherwise it follows DEEPSEEK_MODEL, then DEEPSEEK.model. */
  get model(): string {
    return process.env.WRITER_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || DEEPSEEK.model;
  },
  /** Free text is slower to produce than a typed answer. */
  timeoutMs: 180_000,
  /** Longest reply the writer may give. A tailored resume is the longest thing it writes, and a reply cut at this limit is unusable JSON. */
  maxOutputTokens: 16_384,
  /** Tries per call when DeepSeek answers 429 or 5xx, or the network drops. */
  maxRetries: 3,
  retryBaseMs: 1_000,
  /** Job description characters handed to the writer. The posting is most of what each call costs. */
  maxDescriptionChars: 4_000,
  /** Posting characters per job when writing the two sheet notes, where the opening paragraph is enough. */
  maxNoteChars: 1_500,
} as const;

/** Tailored resumes and cover letters, written per job from the profile and rendered to PDF by the runner's Chrome. */
export const DOCUMENTS = {
  /** A second writer pass that reads the first draft as a reviewer and tightens it. Twice the writer calls per job. */
  review: true,
  /** The most skills the tailored resume lists. */
  maxSkills: 14,
  /** Bullets per experience or project entry on the tailored resume, at most. */
  maxBullets: 4,
  /** Pages the resume may run to. A longer one loses its lowest-ranked bullets until it fits. */
  resumePages: 1,
  /** Pages the cover letter may run to. */
  coverPages: 1,
  /** Paper for the PDFs, in inches. US Letter; A4 is 8.27 by 11.69. */
  paper: { width: 8.5, height: 11 },
  /** How long one headless Chrome print may take. */
  printTimeoutMs: 30_000,
  /** The stock templates shipped with the tool, and where a person's own go. */
  templatesShipped: path.join(ROOT, "src", "documents", "templates"),
  templatesLocal: path.join(ROOT, "documents", "templates"),
  /** Which template is in use, kept in data/. */
  activeTemplate: path.join(ROOT, "data", "template.json"),
  /**
   * Phrases that mark a letter as machine-written. A cover letter that uses one is sent back once to
   * be rewritten in the person's own register, and refused if it still does. Matched without case.
   */
  machinePhrases: [
    "i am writing to", "i am applying for", "i am applying to", "i would like to apply", "i am excited", "i'm excited", "i am thrilled", "i'm thrilled", "i am passionate", "passionate about", "i believe i would", "i am confident that", "great fit", "perfect fit", "strong fit",
    "aligns with", "aligned with", "resonates", "resonate with", "leverage", "utilize", "furthermore", "moreover", "additionally", "in conclusion", "in today's", "fast-paced", "cutting-edge", "innovative", "dynamic", "impactful",
    "world-class", "best-in-class", "delve", "tapestry", "journey", "seamless", "robust", "spearheaded", "synergy", "eager to contribute", "contribute to your team", "hone my skills", "hit the ground running", "thrive",
    "unique opportunity", "i look forward to hearing", "thank you for considering", "not only", "testament to", "deeply", "truly", "it is worth noting", "skill set", "wealth of experience",
  ],
  /** The longest a cover letter sentence may run, in words, and the longest letter. People write short. */
  maxSentenceWords: 28,
  maxLetterWords: 260,
  /** Words that may be capitalized in a sentence without being a claim about the candidate. */
  plainWords: ["I", "A", "An", "The", "My", "In", "At", "On", "For", "With", "And", "As", "To", "Of", "This", "That", "It", "We", "You", "Your", "Our", "If", "When", "While", "After", "Before", "Over", "Since", "Through", "Then", "There", "Here", "What", "Which", "Who", "How", "Why", "Yes", "No", "Dear", "Hi", "Hello", "Sincerely", "Best", "Regards", "Thank", "Thanks", "Team", "Hiring", "Manager", "Regarding", "Re"],
} as const;

/** Reading the mailbox for replies to applications (`src/mail/status.ts`). */
export const INBOX = {
  /** How many days back a run looks, and how many emails it reads at most. */
  days: 7,
  maxMessages: 60,
  /** How much of an email JEV is shown, when the rules cannot name it: its subject and Gmail's own preview, cut to these lengths. */
  subjectChars: 160,
  snippetChars: 240,
  /** JEV's answer is taken only at or above this confidence. Under it the email waits for the person. */
  jevConfidence: 0.8,
  /** A company name shorter than this is too common a word to match on. */
  minCompanyChars: 4,
  clockSkewMs: 10 * 60_000,
} as const;

/**
 * The daily run (`src/run/daily.ts`). No rate is known to be safe, so these are set to look like
 * one careful person: few applications, spread over boards and employers, minutes apart, and a
 * full stop at the first signs that a board is asking whether a person is there.
 */
export const DAILY = {
  /** Applications a day when the policy names no number, and the most a policy or a flag may ask for. */
  target: 15,
  maxTarget: 25,
  /** Applications to one job board in a day. */
  perBoard: 8,
  /** Applications to one employer in a day, and forms open or unconfirmed with one employer at once. */
  perEmployerPerDay: 1,
  openPerEmployer: 2,
  /** The pause between two submissions to one board: a random time between these two. */
  gapMs: [3 * 60_000, 6 * 60_000],
  /** Boards that asked for a human check in one run before the whole run stops. */
  challengesStopRun: 2,
  /** Jobs one run opens at most, whatever became of them. */
  maxAttempts: 30,
  /** Longest one run lasts. */
  maxMinutes: 90,
  /** The most JEV may cost in a day before the run stops, when the policy names no number. */
  jevBudgetUsd: 0.5,
  /** The name the scheduled run is registered under with macOS, and the time it runs when none is given. */
  label: "com.jev-job-search.daily",
  at: "09:00",
} as const;

/**
 * The hourly search and its Last 12 hours page. The search itself is read-only: it never opens
 * Chrome, fills a form, signs in or reads mail. The role terms and places come from the portal's
 * profile, not from here.
 */
export const HOURLY = {
  /** A job is recent while the tool first saw it less than this long ago and its posted date is not older. */
  windowHours: 12,
  /**
   * Employers' own boards list everything they have open. The hourly search reads only what they
   * posted this many days back, and of that keeps only what went up in its window: a board's exact
   * time when it gives one, otherwise a posting its last scan did not show. `discover` reads further
   * back (DISCOVER.maxAgeDays).
   */
  boardMaxAgeDays: 1,
  /**
   * Boards the hourly search polls besides the seed list and freehire's: those of jobs queued this
   * many days back. `discover` polls the boards of every queued job.
   */
  boardKnownDays: 3,
  /** A board posting is forgotten by the hourly search once no scan has shown it for this long. */
  boardSeenDays: 14,
  /** JobSpy asks each board for jobs at most this many hours old. One, because the run is hourly. */
  hoursOld: 1,
  /** How many results to ask for per board in one call. Two sites and more than this often time out. */
  resultsWanted: 50,
  /** The image the JobSpy command line runs from. */
  dockerImage: "jobspy:latest",
  /** Longest one JobSpy call may run. */
  timeoutMs: 90_000,
  /** Pause between two JobSpy calls, so a portal does not burst a board. */
  gapMs: 4_000,
  /** A run stops asking after this many calls, whatever the profile allows. A portal that covers half the country asks once per state. */
  maxQueries: 40,
  /** The reason a job held for the person gets when its 12 hours are over. */
  staleReason: "posted more than 12 hours ago; apply on the employer's site yourself",
  /** How many fresh fillable jobs one portal may apply to in one hourly pass. */
  applyCount: 2,
  /** How many times one job may be tried before it is left for the person. */
  maxAttempts: 2,
  /** How long an hourly apply pass keeps a sign-in page in front and waits for the person. */
  signInWaitMs: 2 * 60_000,
  /** A global apply lock older than this was left by a process that died. */
  lockStaleMs: 30 * 60_000,
  /** The prefix of the scheduled job's name. The portal id makes it unique among the four clones. */
  labelPrefix: "jev-hourly",
  /**
   * The Easy Apply step that runs between the search and the apply pass: it searches LinkedIn
   * through the local fork for postings this portal's profile wants, reads each one, and sends the
   * Easy Apply ones through the fork. Few, paced, and stopped at the first sign of a bot check.
   */
  easyApply: {
    enabled: true,
    /** Most applications this step sends in one hourly run. */
    count: 3,
    /** Most search results it reads looking for Easy Apply. */
    scan: 30,
    pages: 2,
    /** Between reads, inside the fork's rate guidance. */
    readGapMs: 6_000,
    /** Between submissions. */
    gapMs: 300_000,
    /** LinkedIn has no twelve-hour filter, so the search asks for a day and the code keeps the last twelve hours. */
    datePosted: "past_24_hours",
    maxAgeHours: 12,
  },
} as const;

/** Signing in to job boards the person has an account on, and making an account where they allowed it (`src/accounts/`). */
export const ACCOUNTS = {
  /** The name every secret is kept under in the Keychain. */
  keychainService: "jev-job-search",
  /** The one password used for employer accounts, set with `jev accounts password`. */
  passwordItem: "accounts-password",
  /** How long a password the tool makes for a new account is. */
  generatedLength: 24,
  /** How long the window that asks for the password waits for the person, in seconds, and how many times it asks again after a password that misses a rule. */
  askSeconds: 300,
  askRounds: 3,
  /** Sign-in tries per account per day. A wrong password is never retried; this bounds everything else (a sign-in before and after an email verification is two). */
  maxLoginAttempts: 3,
  /** How many times the tool asks a board to send its verification email again. */
  maxResends: 1,
  /** Steps one sign-in may take before it is handed to the person. */
  maxSteps: 16,
  /** New employer accounts per day when the person set no number of their own. */
  maxNewAccountsPerDay: 3,
  /** The pause after a click on a sign-in page before the page is read again. */
  stepMs: 2_500,
  /** Reads after a click on Sign In or Create Account, while the page has neither moved nor said anything. */
  settleReads: 6,
  /** Extra time a form on an account board gets, for the sign-in and the verification email, on top of RUN.fillTimeoutMs. */
  signInBudgetMs: 240_000,
  /** Reads of a page the sign-in does not know before it is handed to the person: a page still drawing itself gets this many. */
  unknownReads: 4,
  /** What the boards the tool supports ask of a new account's secret (Workday's rules). Only these rules are ever printed, never the secret. */
  mustHave: { minLength: 8, digit: true, lower: true, upper: true, special: true },
} as const;

/** Reading the person's Gmail, with their consent, for the email a board sends to prove an inbox is theirs (`src/mail/`). */
export const GMAIL = {
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  apiUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
  clientSecretItem: "gmail-client-secret",
  refreshTokenItem: "gmail-refresh-token",
  /** How long `gmail connect` waits for the person to finish Google's consent page. */
  consentWaitMs: 5 * 60_000,
  /** The waits between looks for a verification email. The total is how long a board gets to send it. */
  pollMs: [5_000, 8_000, 12_000, 15_000, 20_000, 30_000, 30_000],
  /** A verification email older than the request by more than this is not the one asked for. */
  clockSkewMs: 60_000,
  /** A verification request is given up after this long. */
  requestTtlMs: 15 * 60_000,
  /** Messages looked at per poll. More than one fresh match is ambiguous and is refused. */
  maxResults: 5,
  timeoutMs: 20_000,
} as const;

/** Help for the person when a form waits on them (`src/run/assist.ts`). */
export const ASSIST = {
  /** Post a notification on the Mac. */
  notify: true,
  /** For an emailed human-check code, open the person's own mail at a search for it. The tool reads no mail for this. */
  openMail: true,
  mailSearchBase: "https://mail.google.com/mail/u/0/#search/",
} as const;

/** What a child process may inherit from the environment. Keys and passwords are not on the list, so no child ever sees one. */
export const CHILD_ENV = {
  allow: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "__CF_USER_TEXT_ENCODING", "DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"],
} as const;

/** The environment for a child process: the allowed names only, plus what the caller adds on purpose. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV.allow) if (process.env[k] !== undefined) out[k] = process.env[k];
  return { ...out, ...extra };
}

/** How files are written and locked (`src/util/store.ts`). */
export const STORE = {
  /** How long a command waits for another command's write to finish. */
  lockWaitMs: 15_000,
  lockPollMs: 25,
  /** A write lock older than this was left by a process that hung. */
  lockStaleMs: 60_000,
  /** A run lock older than this was left behind: no run lasts this long. */
  runStaleMs: 6 * 60 * 60_000,
} as const;

/** The dashboard: a page on your own machine that reads the records and lets you change a status by hand. */
export const REPORT = {
  port: 4545,
  /** The statuses the page lets a person set, in the order they are offered. */
  statuses: ["applied", "needs_review", "queued", "skipped", "blocked", "failed"],
  /** The name a dashboard gets when it runs as a systemd user service. The folder name makes it unique. */
  servicePrefix: "jev-report",
  /** Rows a table draws before "Show more", so the Everything tab stays quick with thousands of jobs. */
  pageSize: 100,
  /**
   * The five dashboards, for the switcher at the top of each page. A page served on this machine
   * links to the local ports; one served from its public address links to the public addresses.
   * The accent tells the boards apart at a glance.
   */
  portals: [
    { title: "Main", port: 7411, url: "https://job.ohmzhomelab.ca", accent: "#475569" },
    { title: "Android · NJ", port: 7421, url: "https://jobnja.ohmzhomelab.ca", accent: "#0d9488" },
    { title: "Android · TX", port: 7422, url: "https://jobtxa.ohmzhomelab.ca", accent: "#7c3aed" },
    { title: "Full Stack · NJ", port: 7423, url: "https://jobnjf.ohmzhomelab.ca", accent: "#db2777" },
    { title: "Full Stack · TX", port: 7424, url: "https://jobtxf.ohmzhomelab.ca", accent: "#2563eb" },
  ],
  /** The accent of a dashboard that is not one of the five. */
  accent: "#2563eb",
  /** The page paths the combined board may pass to a portal. A portal's daily rules and schedule are its own page's alone. */
  linkedPaths: ["/api/status", "/api/answer", "/api/show", "/api/mail", "/api/confirm-answer"],
  /** How long the combined board waits for one portal's dashboard before showing it as not answering. */
  combineTimeoutMs: 8_000,
} as const;

/**
 * The secret the combined board sends with a change it passes to a portal, shared by the five
 * dashboards on this machine and outside the repositories. Made at random the first time a
 * dashboard needs it, readable by this user only, never printed. Read at call time, like the
 * shared folder it lives in.
 */
export function reportLinkKeyFile(): string {
  return path.join(process.env.JEV_SHARED_DIR?.trim() || path.join(os.homedir(), ".local", "state", "jev"), "report-link.key");
}

/**
 * True in the folder of the combined board (JEV_ROLE=combined in its .env): it shows the four
 * portals together and passes changes to them, and never searches, applies or signs in itself.
 * Read at call time, because .env is loaded after this module is evaluated.
 */
export function isCombinedBoard(): boolean {
  return process.env.JEV_ROLE?.trim() === "combined";
}

/**
 * The name at the top of a dashboard and in its browser tab: JEV_REPORT_TITLE from the portal's
 * .env, else the portal listed for this port, else the folder name. Read at call time, because
 * .env is loaded after this module is evaluated.
 */
export function reportTitle(port?: number): string {
  return process.env.JEV_REPORT_TITLE?.trim() || REPORT.portals.find((p) => p.port === port)?.title || path.basename(ROOT);
}

/**
 * Extra origins the dashboard may be served from, such as a Cloudflare tunnel. Full origins,
 * comma-separated, in JEV_REPORT_PUBLIC_ORIGINS. Empty by default: localhost only. Read at call
 * time, because .env is loaded after this module is evaluated.
 */
export function reportPublicOrigins(): string[] {
  return (process.env.JEV_REPORT_PUBLIC_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The answer memory: what the writer already answered, reused instead of asked again. */
export const MEMORY = {
  enabled: true,
  /** JEV's confidence that a new question asks for the same thing as a remembered one, at or above which the remembered answer is used. */
  sameQuestionConfidence: 0.9,
  /** Remembered questions shown to JEV per open field, closest wording first. */
  candidates: 5,
  /** Share of the shorter question's words the two must have in common before JEV is asked at all. */
  minWordOverlap: 0.3,
} as const;

/** What `doctor` checks against. */
export const DOCTOR = {
  minNodeMajor: 22,
  /** Most job boards refuse a larger resume. */
  maxResumeBytes: 5_000_000,
  /** A queue older than this is worth refreshing before a run: postings close. */
  staleQueueHours: 24,
} as const;

export const RUN = {
  /** How many queued jobs `discover` lists when it is done. */
  listed: 50,
  /**
   * Forms the runner fills side by side, one tab each. One means one job at a time: open, fill, send,
   * close, next. That is the cleanest to watch and the fastest per form, because no tab waits for the
   * window; the documents for the next job are written while this one is being filled.
   */
  fillConcurrency: 1,
  /** Of those, how many may be on the same site at once, and the pause between opening two forms there. Job boards throttle bursts. */
  perHostConcurrency: 1,
  /** Sites that save every field to their server as it changes, and rate-limit bursts: one form at a time, with a longer pause. */
  gentleHosts: ["ashbyhq.com"],
  gentleGapMs: 3_000,
  /** The pause before a submission to a site that has answered a burst with an emailed code before. */
  submitGapAfterCodeMs: 15_000,
  /** The pause between two submissions to the same site. A burst of applications from one person reads as a robot; one form at a time is most of the pacing already. */
  submitGapMs: 5_000,
  /** Longer pauses for sites that react to bursts. Greenhouse asked for an emailed code on 7 of 13 forms sent within minutes. */
  submitGapByHost: { "greenhouse.io": 90_000 } as Record<string, number>,
  /** The most forms one run takes from the same employer. The rest stay queued for another run. */
  perEmployerPerRun: 3,
  /** The pause between two submissions to the same employer, so several of its roles do not arrive within a minute. */
  employerGapMs: 8 * 60_000,
  /** The most pages of one form the tool will walk. A form that goes on longer is left for the person. */
  maxPages: 8,
  /** How long `resume` watches one waiting form for the person to finish it. */
  resumeWaitMs: 5 * 60_000,
  /**
   * The most a run keeps one page in front of the person while it waits for them (a robot check, an emailed code, a
   * sign-in). Past this the job stays on the by-hand list and the run goes on, so the forms that need nobody finish first.
   */
  humanWaitMs: 2 * 60_000,
  /** How long `apply` on a job the person named waits at a sign-in for them to sign in, before it leaves the page open and moves on. */
  signInWaitMs: 2 * 60_000,
  /** A form kept open for the person is given up after this long: its session has usually expired by then. */
  waitingExpiryHours: 12,
  /** How long an abandoned fill is given to stop before its form is tried again. */
  abortGraceMs: 5_000,
  /** How many times a form is opened and filled when values did not land. The second go comes when the other forms are done, with the window to itself. */
  fillAttempts: 2,
  /** How much of a page's own text `inspect --text` prints. */
  inspectChars: 12_000,
  /** How many times the writer is asked about one page: once, then again with what did not land and why, as long as a round changes something. */
  resolveRounds: 3,
  /** How many times a page whose Next did not move the form is put right, or pressed again, before the form is left for the person. */
  nextRetries: 2,
  /** Longest one form may take to open and fill. A page that never settles is recorded as blocked instead of holding up the run. */
  fillTimeoutMs: 180_000,
  /** Forms handed to the writer at once. */
  writerConcurrency: 3,
  hostGapMs: 1_000,
} as const;

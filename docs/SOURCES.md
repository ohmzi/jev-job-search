# Sources

*What is read, how, and how fresh. Last verified 2026-10-27.*

Every source produces the same `Job` shape (`src/jobs/normalize.ts`) and
is deduplicated by canonical URL (tracking parameters stripped), so a
posting found by three lists is rated once.

| Source | Read how | Freshness | Notes |
|---|---|---|---|
| Greenhouse boards | `boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` | Live | Polled for the seed list in `src/sources/companies.ts`, every board a queued job points at, and the boards freehire names. Full description included. |
| Lever boards | `api.lever.co/v0/postings/{slug}?mode=json` | Live | Same. |
| Ashby boards | `api.ashbyhq.com/posting-api/job-board/{slug}` | Live | Same. Includes `descriptionPlain`. |
| Workable boards | `apply.workable.com/api/v1/widget/accounts/{slug}?details=true` | Live | Same. Description included. |
| Workday sites | `POST {site origin}/wday/cxs/{tenant}/{site}/jobs` with the portal's terms, then each posting's own data | Live | Searched, not read whole: a site holds thousands of postings and does not sort by date, so `ATS_SEARCH.workdayMaxPages` bounds the read. Kept only with an account (`/accounts`). |
| freehire.me | `freehire_search_jobs` on the openings-mcp server, one call per term and page | Crawled, daily | Only postings crawled from a board the tool fills, marked fresh, not freshened and re-listed at most `FREEHIRE.maxReposts` times. Dated by when freehire first saw them. Each names its board, which is then read directly. |
| Your tracking sheet | CSV files in `data/imports/` with at least Company and Job Link columns | When you export it | Rows already marked applied are ignored. |

Every posting is put to the portal's own rules, and a student or new-grad
title is never kept. The hourly search reads the same boards and takes only
what went up since a board's last read (a third of the boards each hour,
`HOURLY.boardRotateHours`): by the board's exact time where it gives one
(Greenhouse, Lever, Ashby), otherwise a posting its last scan did not show
(`data/runs/hourly-boards.json`).

## Descriptions

The rating needs the posting text. `src/jobs/describe.ts` gets it from the
ATS API when the URL is Greenhouse, Lever or Ashby (clean text, cached six
hours) and otherwise fetches the page and strips it to text. Pages that
render only in JavaScript (some Tesla, Rubrik, Epic careers pages) come
back empty and are rated from the title and company alone.

## Workday

Workday postings come from the public lists. Each posting's text is read
from Workday's own posting data (`src/sources/ats/workday.ts`), the same
data its careers page shows, with no sign-in. Applying needs an account
with that employer, so these jobs are kept only once the person has
allowed accounts ([ACCOUNTS.md](ACCOUNTS.md)). In one run 876 of the
postings found were on Workday, across 290 employers.

## Deliberately not read yet

| Source | Why not yet | How it would be added |
|---|---|---|
| LinkedIn Jobs, Indeed, Glassdoor | They need a sign-in or block automated reading. The tool does not sign in anywhere | Not planned |
| iCIMS, Taleo, Oracle, SuccessFactors, Amazon Jobs | Every one needs an account | An adapter in `src/accounts/`, like the one for Workday. Until then these jobs are skipped |
| SmartRecruiters | Its form is drawn inside components the page scripts cannot read yet | Reading through shadow roots in `dumpFields.js` and `fillFields.js` |
| German-language boards | English only for version one | A `lang` field on `Job` and a German `voice.md` |
| Company careers pages with no public API | No structured feed | Per-company HTML parsers; the board APIs cover most of the early-career market |

## Adding a source

1. Write `src/sources/<name>.ts` exporting `fetch<Name>(): Promise<Job[]>`.
   Use `getText`/`getJson` from `src/util/http.ts` so caching and timeouts
   apply.
2. Set `source` to a short stable name, `postedAt` to an ISO date when
   known, and run every URL through `canonicalUrl`.
3. Call it from `collectJobs` in `src/discover.ts`.
4. Add a fixture under `tests/fixtures/` and a parser test.

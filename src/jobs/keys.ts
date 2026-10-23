/** The keys that let two boards, or two portals, recognize the same posting. */
export const keyPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The same posting from two boards, in the words the person would compare them by. */
export function hourlyKey(j: { company: string; title: string; locations: string[] }): string {
  return `${keyPart(j.company)}|${keyPart(j.title)}|${keyPart(j.locations.join(","))}`;
}

/**
 * The looser key an applied job is remembered by. A board can move the same role to another
 * location or another link; the employer and title are what say it is the job that was sent.
 */
export function appliedKey(j: { company: string; title: string }): string {
  return `${keyPart(j.company)}|${keyPart(j.title)}`;
}

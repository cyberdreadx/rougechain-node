/**
 * Homepage team roster — edit here when adding/removing people.
 * `id` keys the translated copy in src/i18n/locales/<lang>/marketing.json:
 * `team.members.<id>.role` (required) and `team.members.<id>.bio` (optional; without it the
 * "About" disclosure is not rendered) — add both in en, es, zh and ja.
 * Every other field except `name` is optional: leave a value empty ("") and the
 * corresponding element is simply not rendered. Do not add placeholder text or images.
 *
 *   image  — path under /public (e.g. "/team/brandon.jpg") or an imported asset; square or
 *            slightly portrait works best (rendered 4:5, desaturated until hover)
 *   x      — full URL (https://x.com/…)
 *   github — full URL
 *   website — full URL (personal site)
 *   linkedin — full LinkedIn profile URL
 */
export interface TeamMember {
  /** Key for `team.members.<id>` in the marketing locale files. */
  id: string;
  name: string;
  alias?: string;
  image?: string;
  x?: string;
  github?: string;
  website?: string;
  linkedin?: string;
}

export const team: TeamMember[] = [
  {
    id: "brandon",
    name: "Brandon Menard",
    alias: "Cyberdreadx",
    image: "/team/brandon-menard.jpg",
    x: "https://x.com/cyberdreadx",
    github: "https://github.com/cyberdreadx",
    website: "",
    linkedin: "https://www.linkedin.com/in/brandon-menard-91364273/",
  },
  {
    id: "andersen",
    name: "Andersen Scherberger",
    alias: "",
    image: "/team/andersen-scherberger.jpg",
    x: "https://x.com/derzathon",
    github: "",
    website: "",
    linkedin: "https://www.linkedin.com/in/andersscherberger/",
  },
  {
    id: "elijah",
    name: "Elijah Bowdre",
    alias: "Blockchain Bowdre",
    image: "/team/elijah-bowdre.jpg",
    x: "https://x.com/chairmanbowdre",
    github: "",
    website: "https://thebitpoint.io/",
    linkedin: "https://www.linkedin.com/in/elijah-john-bowdre-28122a35/",
  },
  {
    id: "teresa",
    name: "Teresa Castagnino",
    alias: "Tere",
    image: "/team/teresa-castagnino.jpg",
    x: "https://x.com/terecastagnino",
    github: "",
    website: "",
    linkedin: "https://www.linkedin.com/in/teresa-castagninolgm",
  },
  {
    id: "ghulam",
    name: "Dr. Ghulam Abbas",
    alias: "",
    image: "/team/ghulam-abbas.jpg",
    x: "",
    github: "",
    website: "",
    linkedin: "https://www.linkedin.com/in/dr-ghulam-abbas/",
  },
  {
    id: "brenda",
    name: "Brenda Miranda",
    alias: "",
    image: "/team/brenda-miranda.jpg",
    x: "",
    github: "",
    website: "",
    linkedin: "https://www.linkedin.com/in/miranda-brenda/",
  },
];

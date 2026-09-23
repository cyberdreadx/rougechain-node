/**
 * Homepage team roster — the ONLY place to edit when adding/removing people.
 * Every field except `name` and `role` is optional: leave a value empty ("") and the
 * corresponding element is simply not rendered. Do not add placeholder text or images.
 *
 *   image  — path under /public (e.g. "/team/brandon.jpg") or an imported asset; square or
 *            slightly portrait works best (rendered 4:5, desaturated until hover)
 *   x      — full URL (https://x.com/…)
 *   github — full URL
 *   website — full URL (personal site or LinkedIn)
 */
export interface TeamMember {
  name: string;
  alias?: string;
  role: string;
  bio?: string;
  image?: string;
  x?: string;
  github?: string;
  website?: string;
}

export const team: TeamMember[] = [
  {
    name: "Brandon Menard",
    alias: "Cyberdreadx",
    role: "CEO · Main Dev",
    bio: "Brandon Menard, professionally known as CyberDreadx, is an American music producer, AI developer, and blockchain innovator based in Miami. As the founder of Rougee and RougeCoin, he\u2019s building the next-generation music platform that merges Web3 ownership, streaming, and creator empowerment. With a background in AI and cybersecurity, Brandon leads the technical vision and development of Rougee\u2019s decentralized ecosystem, bridging art, tech, and freedom of expression.",
    image: "/team/brandon-menard.jpg",
    x: "",
    github: "",
    website: "",
  },
  {
    name: "Andersen Scherberger",
    alias: "",
    role: "Head of Growth and Operations",
    bio: "Andersen Scherberger is a veteran music industry professional with over 15 years of experience. He founded a \u201cBest of Miami\u201d award-winning nightclub, hosted countless festivals and events, and managed artists who have performed at major festivals like EDC. His NFT Gallery was featured on CBS\u2019 Destination Miami and solidified partnerships with major crypto brands like Near, Bored Ape Yacht Club, and NFT.com.",
    image: "/team/andersen-scherberger.jpg",
    x: "",
    github: "",
    website: "",
  },
];

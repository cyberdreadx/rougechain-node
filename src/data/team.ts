/**
 * Homepage team roster — the ONLY place to edit when adding/removing people.
 * Every field except `name` and `role` is optional: leave a value empty ("") and the
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
  name: string;
  alias?: string;
  role: string;
  bio?: string;
  image?: string;
  x?: string;
  github?: string;
  website?: string;
  linkedin?: string;
}

export const team: TeamMember[] = [
  {
    name: "Brandon Menard",
    alias: "Cyberdreadx",
    role: "CEO · Main Dev",
    bio: "Brandon Menard, professionally known as CyberDreadx, is an American music producer, AI developer, and blockchain innovator based in Miami. As the founder of Rougee and RougeCoin, he\u2019s building the next-generation music platform that merges Web3 ownership, streaming, and creator empowerment. With a background in AI and cybersecurity, Brandon leads the technical vision and development of Rougee\u2019s decentralized ecosystem, bridging art, tech, and freedom of expression.",
    image: "/team/brandon-menard.jpg",
    x: "https://x.com/cyberdreadx",
    github: "https://github.com/cyberdreadx",
    website: "",
    linkedin: "https://www.linkedin.com/in/brandon-menard-91364273/",
  },
  {
    name: "Andersen Scherberger",
    alias: "",
    role: "Head of Growth and Operations",
    bio: "Andersen Scherberger is a veteran music industry professional with over 15 years of experience. He founded a \u201cBest of Miami\u201d award-winning nightclub, hosted countless festivals and events, and managed artists who have performed at major festivals like EDC. His NFT Gallery was featured on CBS\u2019 Destination Miami and solidified partnerships with major crypto brands like Near, Bored Ape Yacht Club, and NFT.com.",
    image: "/team/andersen-scherberger.jpg",
    x: "https://x.com/derzathon",
    github: "",
    website: "",
    linkedin: "https://www.linkedin.com/in/andersscherberger/",
  },
  {
    name: "Elijah Bowdre",
    alias: "Blockchain Bowdre",
    role: "Chairman, Miami-Dade County Cryptocurrency Task Force",
    bio: "Elijah John Bowdre chairs the Miami-Dade County Cryptocurrency Task Force and is president and co-founder of the US Crypto Policy Alliance. He authored Florida\u2019s first state blockchain bill, Miami-Dade County\u2019s Blockchain Board ordinance and the City of Miami\u2019s crypto payment policy, hosts the crypto news show TheBitPoint, and was a candidate for Mayor of Miami in 2025.",
    image: "/team/elijah-bowdre.jpg",
    x: "https://x.com/chairmanbowdre",
    github: "",
    website: "https://thebitpoint.io/",
    linkedin: "https://www.linkedin.com/in/elijah-john-bowdre-28122a35/",
  },
];

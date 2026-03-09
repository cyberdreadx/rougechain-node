
The user wants the coin logo (xrge-logo.webp) in the mobile header bar of Sidebar.tsx to animate like "jelly" — a squash-and-stretch bounce effect — continuously within its circular container.

**Where the logo lives:**
- Mobile header: `Sidebar.tsx` line 186 — `<img src={xrgeLogo} alt="XRGE" className="w-7 h-7 rounded-full" />`
- Desktop sidebar logo section: `Sidebar.tsx` line 99 — `<img src={xrgeLogo} alt="XRGE" className="w-8 h-8 rounded-full flex-shrink-0" />`

**What to build:**
1. Add a `jelly` keyframe animation to `tailwind.config.ts` — squash/stretch scale transform that cycles continuously
2. Add the `animate-jelly` utility class to the logo `<img>` tags in both locations in `Sidebar.tsx`

**The jelly keyframe:**
```
0%, 100% → scale(1, 1)
20%       → scale(0.85, 1.15)   // squash down, stretch up
40%       → scale(1.15, 0.85)   // stretch wide, squash
60%       → scale(0.92, 1.08)   // smaller bounce
80%       → scale(1.05, 0.95)   // settle
```
Duration ~2s, ease-in-out, infinite — gentle enough not to be distracting, bouncy enough to feel like jelly.

**Files to change:**
1. `tailwind.config.ts` — add `jelly` keyframes + `animate-jelly` animation entry
2. `src/components/Sidebar.tsx` — add `animate-jelly` class to both logo `<img>` tags (lines 99 and 186)

No build errors to fix here — that's a separate TypeScript issue in pqc-messenger.ts that is pre-existing.

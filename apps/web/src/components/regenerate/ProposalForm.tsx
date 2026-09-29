import { useState } from "react";
import { Send, CheckCircle2, Loader2, MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { REGEN_CATEGORIES } from "@/lib/regenerate";

/** Must match the hidden form registered in index.html for Netlify Forms detection. */
const FORM_NAME = "regenerate-proposal";
const DISCORD_URL = "https://discord.gg/wZKsHfhXxm";

const FIELDS = ["name", "contact", "project", "location", "category", "requested_xrge", "payout_address", "description", "milestones", "links"] as const;
type Field = (typeof FIELDS)[number];
const EMPTY: Record<Field, string> = Object.fromEntries(FIELDS.map((f) => [f, ""])) as Record<Field, string>;

/**
 * Project proposal form. Submissions go to Netlify Forms (same pipeline as the
 * newsletter signup) for review; accepted projects are then listed on the page and
 * funded from the public treasury wallet, with the grant visible on-chain.
 */
export default function ProposalForm() {
  const [v, setV] = useState(EMPTY);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const set = (k: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState("sending");
    try {
      const body = new URLSearchParams({ "form-name": FORM_NAME, "bot-field": "", ...v });
      const res = await fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("sent");
      setV(EMPTY);
    } catch {
      setState("error");
    }
  };

  if (state === "sent") {
    return (
      <div className="flex flex-col items-center text-center gap-3 py-8" role="status">
        <CheckCircle2 className="w-10 h-10 text-success" aria-hidden="true" />
        <h3 className="text-xl font-semibold">Proposal received</h3>
        <p className="max-w-md text-sm text-muted-foreground">
          Thanks. We review every proposal and reply to the contact you gave. Accepted projects appear on this page,
          and their funding shows up on-chain from the treasury wallet.
        </p>
        <Button variant="outline" onClick={() => setState("idle")}>Send another</Button>
      </div>
    );
  }

  const field = "space-y-1.5";
  return (
    <form name={FORM_NAME} onSubmit={submit} className="grid gap-4 sm:grid-cols-2 text-left">
      <input type="hidden" name="form-name" value={FORM_NAME} />
      <p className="hidden"><label>Leave empty <input name="bot-field" tabIndex={-1} autoComplete="off" /></label></p>

      <div className={field}>
        <Label htmlFor="rp-name">Your name or organisation</Label>
        <Input id="rp-name" required maxLength={120} value={v.name} onChange={set("name")} />
      </div>
      <div className={field}>
        <Label htmlFor="rp-contact">Email or Telegram</Label>
        <Input id="rp-contact" required maxLength={160} value={v.contact} onChange={set("contact")} placeholder="so we can reply" />
      </div>
      <div className={field}>
        <Label htmlFor="rp-project">Project name</Label>
        <Input id="rp-project" required maxLength={120} value={v.project} onChange={set("project")} />
      </div>
      <div className={field}>
        <Label htmlFor="rp-location">Location</Label>
        <Input id="rp-location" required maxLength={120} value={v.location} onChange={set("location")} placeholder="e.g. Tulum, Quintana Roo" />
      </div>
      <div className={field}>
        <Label htmlFor="rp-category">Category</Label>
        <select
          id="rp-category" required value={v.category} onChange={set("category")}
          className="flex h-10 w-full rounded-xl border border-foreground/12 bg-foreground/[0.04] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="" disabled>Choose one</option>
          {REGEN_CATEGORIES.map((c) => <option key={c.key} value={c.title}>{c.title}</option>)}
        </select>
      </div>
      <div className={field}>
        <Label htmlFor="rp-amount">Funding requested (XRGE)</Label>
        <Input id="rp-amount" inputMode="decimal" maxLength={24} value={v.requested_xrge} onChange={(e) => setV((s) => ({ ...s, requested_xrge: e.target.value.replace(/[^0-9.]/g, "") }))} placeholder="leave blank if unsure" />
      </div>
      <div className={`${field} sm:col-span-2`}>
        <Label htmlFor="rp-payout">RougeChain address for payment (optional)</Label>
        <Input id="rp-payout" maxLength={120} value={v.payout_address} onChange={set("payout_address")} placeholder="rouge1…" className="font-mono" />
      </div>
      <div className={`${field} sm:col-span-2`}>
        <Label htmlFor="rp-desc">What will you do, and what changes for the place?</Label>
        <Textarea id="rp-desc" required minLength={40} maxLength={4000} rows={5} value={v.description} onChange={set("description")} />
      </div>
      <div className={`${field} sm:col-span-2`}>
        <Label htmlFor="rp-milestones">Milestones and how we'll see the result</Label>
        <Textarea id="rp-milestones" maxLength={2000} rows={3} value={v.milestones} onChange={set("milestones")} placeholder="One per line: what gets done, and the evidence (photos, data, receipts)" />
      </div>
      <div className={`${field} sm:col-span-2`}>
        <Label htmlFor="rp-links">Links (optional)</Label>
        <Input id="rp-links" maxLength={500} value={v.links} onChange={set("links")} placeholder="website, socials, prior work" />
      </div>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-4 pt-1">
        <Button type="submit" size="lg" disabled={state === "sending"} className="gap-2">
          {state === "sending" ? <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> : <Send className="w-5 h-5" aria-hidden="true" />}
          Submit proposal
        </Button>
        <a href={DISCORD_URL} target="_blank" rel="noopener noreferrer" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5">
          <MessageCircle className="w-4 h-4" aria-hidden="true" /> Questions first? Ask on Discord
        </a>
        {state === "error" && (
          <p className="w-full text-sm text-destructive" role="alert">
            Couldn't send that. Check your connection and try again, or post it on Discord.
          </p>
        )}
      </div>
    </form>
  );
}

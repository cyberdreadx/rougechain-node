import { useEffect, useState, type FormEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Mail, X, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Signups go to Netlify Forms (form name below). Free, exportable from the
// Netlify dashboard, and owned by us — no third-party platform can switch it off.
const FORM_NAME = "email-signup";
const STORAGE_KEY = "rc_email_v1"; // "subscribed" | "dismissed"
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readFlag(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function writeFlag(v: string) {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    /* private mode / blocked storage — non-fatal */
  }
}

async function submitEmail(email: string): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      "form-name": FORM_NAME,
      email,
      "bot-field": "",
    }).toString();
    const res = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

function EmailSignup({
  onSubscribed,
  autoFocus,
}: {
  onSubscribed?: () => void;
  autoFocus?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (!EMAIL_RE.test(email.trim())) {
      setState("error");
      return;
    }
    setState("loading");
    const ok = await submitEmail(email.trim());
    if (ok) {
      writeFlag("subscribed");
      setState("done");
      onSubscribed?.();
    } else {
      setState("error");
    }
  };

  if (state === "done") {
    return (
      <div className="flex items-center gap-2 text-success text-sm font-medium">
        <Check className="w-4 h-4" /> You're in — updates straight to your inbox. No spam.
      </div>
    );
  }

  return (
    <form onSubmit={handle} className="w-full space-y-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state === "error") setState("idle");
          }}
          placeholder="you@email.com"
          autoFocus={autoFocus}
          aria-label="Email address"
          className="flex-1"
        />
        <Button type="submit" disabled={state === "loading"} className="gap-2 whitespace-nowrap">
          {state === "loading" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
          Keep me posted
        </Button>
      </div>
      {state === "error" && (
        <p className="text-xs text-destructive">Enter a valid email address.</p>
      )}
    </form>
  );
}

/** Bottom-of-page inline capture. */
export function EmailCaptureBanner() {
  return (
    <motion.section
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      className="mb-12"
    >
      <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 to-accent/5 p-6 sm:p-8">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 mb-2">
            <Mail className="w-5 h-5 text-primary" />
            <h2 className="text-xl font-bold text-foreground">Own your line to RougeChain</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            No middleman, no algorithm, no account a corporation can switch off. Drop your email
            and get updates straight from the source — launches, drops, and where the chain is headed.
          </p>
          <EmailSignup />
          <p className="text-[11px] text-muted-foreground mt-2">We'll never share your email. Unsubscribe anytime.</p>
        </div>
      </div>
    </motion.section>
  );
}

/** Timed, dismissible popup (shows once per visitor until they act on it). */
export function EmailCapturePopup() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (readFlag()) return; // already subscribed or dismissed
    const t = setTimeout(() => {
      if (!readFlag()) setOpen(true);
    }, 18000);
    return () => clearTimeout(t);
  }, []);

  const dismiss = () => {
    writeFlag("dismissed");
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-background/70 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={dismiss}
          role="dialog"
          aria-modal="true"
          aria-label="Subscribe for updates"
        >
          <motion.div
            className="relative w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl"
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={dismiss}
              aria-label="Close"
              className="absolute top-3 right-3 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 mb-2">
              <Mail className="w-5 h-5 text-primary" />
              <h3 className="text-lg font-bold text-foreground">Don't rely on their platforms</h3>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Social accounts get switched off without warning. Get RougeChain updates on a channel
              no one can take away — straight to your inbox.
            </p>
            <EmailSignup autoFocus onSubscribed={() => setTimeout(() => setOpen(false), 1600)} />
            <button
              onClick={dismiss}
              className="mt-3 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              No thanks
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

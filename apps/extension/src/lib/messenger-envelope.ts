/**
 * Qwalla wraps chat text in a small JSON envelope before encrypting it:
 *   {"v":1,"k":"msg","b":"<body>","r":"<reply-to id>"?}   a message
 *   {"v":1,"k":"rx","t":"<target id>","e":"<emoji>"}       a reaction to message <target>
 * The site adds two optional structured fields to "msg" envelopes. Qwalla ignores unknown fields
 * and shows the human-readable `b` ("💸 Sent 5 XRGE"); the site renders the rich card instead:
 *   "pay":{...}   an in-chat payment   (token, amount, txHash?, status?, memo?)
 *   "req":{...}   a payment request    (token, amount, memo?)
 * Qwalla tips are plain bodies of the form `[tip:<amount>:<SYMBOL>]` (see parseTip).
 * Anything that isn't an envelope (older clients, legacy site messages) is a plain body.
 * Keep in sync with src/lib/messenger-envelope.ts (site) and Qwalla's parseEnvelope.
 */
/** Structured data the site attaches to a msg envelope (`pay` / `req`). Validated before rendering. */
export type EnvelopeData = Record<string, unknown>;

export type Envelope =
  | { kind: "msg"; body: string; replyTo?: string; pay?: EnvelopeData; req?: EnvelopeData }
  | { kind: "rx"; target: string; emoji: string };

function asData(x: unknown): EnvelopeData | undefined {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as EnvelopeData) : undefined;
}

export function parseEnvelope(raw: string): Envelope {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o && o.v === 1 && o.k === "msg" && typeof o.b === "string") {
      const env: Envelope = { kind: "msg", body: o.b, replyTo: typeof o.r === "string" ? o.r : undefined };
      const pay = asData(o.pay);
      const req = asData(o.req);
      if (pay) env.pay = pay;
      if (req) env.req = req;
      return env;
    }
    if (o && o.v === 1 && o.k === "rx" && typeof o.t === "string" && typeof o.e === "string") {
      return { kind: "rx", target: o.t, emoji: o.e };
    }
  } catch {
    /* not an envelope */
  }
  return { kind: "msg", body: raw };
}

/** Build a message envelope (the same shape Qwalla sends, plus the optional site fields). */
export function buildMsgEnvelope(body: string, opts: { replyTo?: string; pay?: EnvelopeData; req?: EnvelopeData } = {}): string {
  const o: Record<string, unknown> = { v: 1, k: "msg", b: body };
  if (opts.replyTo) o.r = opts.replyTo;
  if (opts.pay) o.pay = opts.pay;
  if (opts.req) o.req = opts.req;
  return JSON.stringify(o);
}

/** Build a reaction envelope: `emoji` on message `target`. */
export function buildRxEnvelope(target: string, emoji: string): string {
  return JSON.stringify({ v: 1, k: "rx", t: target, e: emoji });
}

const TIP_RE = /^\[tip:([\d.]+):([A-Za-z]{2,8})\]$/;

/** Qwalla's in-chat tip body `[tip:<amount>:<SYMBOL>]` (same regex as Qwalla), or null. */
export function parseTip(body: string | undefined): { amount: string; symbol: string } | null {
  const m = body ? TIP_RE.exec(body.trim()) : null;
  return m ? { amount: m[1], symbol: m[2] } : null;
}

/** A reaction attached by applyEnvelopes, with who sent it (when known). */
export type EnvelopeReaction = { emoji: string; sender?: string };

type EnvelopeMessage = {
  id: string;
  plaintext?: string;
  senderWalletId?: string;
  reactions?: string[];
  reactionsFrom?: EnvelopeReaction[];
  replyTo?: string;
  pay?: EnvelopeData;
  req?: EnvelopeData;
  mediaUrl?: string;
};

/**
 * Unwrap envelopes in a decrypted message list: message envelopes become their body (with
 * replyTo / pay / req carried over), reaction envelopes are removed from the list and attached
 * to the message they react to (`reactions` as emoji, `reactionsFrom` with the sender).
 * Messages that failed to decrypt ("[...]") or carry media are left as they are.
 * Idempotent: running it again over its own output changes nothing.
 */
export function applyEnvelopes<M extends EnvelopeMessage>(messages: M[]): M[] {
  const reactions = new Map<string, EnvelopeReaction[]>();
  const out: M[] = [];
  for (const m of messages) {
    const text = m.plaintext;
    if (!text || m.mediaUrl || text.startsWith("[")) { out.push(m); continue; }
    const env = parseEnvelope(text);
    if (env.kind === "rx") {
      reactions.set(env.target, [...(reactions.get(env.target) ?? []), { emoji: env.emoji, sender: m.senderWalletId }]);
      continue;
    }
    if (env.body === text) { out.push(m); continue; }
    const next: M = { ...m, plaintext: env.body, replyTo: env.replyTo };
    if (env.pay) next.pay = env.pay;
    if (env.req) next.req = env.req;
    out.push(next);
  }
  if (reactions.size === 0) return out;
  return out.map((m) => {
    const rx = reactions.get(m.id);
    if (!rx) return m;
    return {
      ...m,
      reactions: [...(m.reactions ?? []), ...rx.map((r) => r.emoji)],
      reactionsFrom: [...(m.reactionsFrom ?? []), ...rx],
    };
  });
}

/**
 * Whether a conversation is a note to self: named so, or every participant is one of my ids.
 * An empty or unresolved participant list is NOT a note to self (Array.every([]) is true, which
 * made DMs opened before participants loaded encrypt only for the sender).
 */
export function isNoteToSelf(
  conversation: { name?: string; participants?: Array<{ id?: string; signingPublicKey?: string; encryptionPublicKey?: string }>; participantIds?: string[] },
  myIds: Set<string>,
): boolean {
  if (conversation.name === "Note to Self") return true;
  const ps = conversation.participants ?? [];
  if (ps.length > 0) {
    return ps.every((p) => myIds.has(p.id ?? "") || myIds.has(p.signingPublicKey ?? "") || myIds.has(p.encryptionPublicKey ?? ""));
  }
  const ids = conversation.participantIds ?? [];
  return ids.length > 0 && ids.every((id) => myIds.has(id));
}

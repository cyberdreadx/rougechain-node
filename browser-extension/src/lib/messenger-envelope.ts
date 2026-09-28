/**
 * Qwalla wraps chat text in a small JSON envelope before encrypting it:
 *   {"v":1,"k":"msg","b":"<body>","r":"<reply-to id>"?}   a message
 *   {"v":1,"k":"rx","t":"<target id>","e":"<emoji>"}       a reaction to message <target>
 * Anything that isn't an envelope (older clients, this site, the extension) is a plain body.
 * Keep in sync with src/lib/messenger-envelope.ts (site) and Qwalla's parseEnvelope.
 */
export type Envelope =
  | { kind: "msg"; body: string; replyTo?: string }
  | { kind: "rx"; target: string; emoji: string };

export function parseEnvelope(raw: string): Envelope {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o && o.v === 1 && o.k === "msg" && typeof o.b === "string") {
      return { kind: "msg", body: o.b, replyTo: typeof o.r === "string" ? o.r : undefined };
    }
    if (o && o.v === 1 && o.k === "rx" && typeof o.t === "string" && typeof o.e === "string") {
      return { kind: "rx", target: o.t, emoji: o.e };
    }
  } catch {
    /* not an envelope */
  }
  return { kind: "msg", body: raw };
}

/**
 * Unwrap envelopes in a decrypted message list: message envelopes become their body, reaction
 * envelopes are removed from the list and attached to the message they react to (`reactions`).
 * Messages that failed to decrypt ("[...]") or carry media are left as they are.
 */
export function applyEnvelopes<M extends { id: string; plaintext?: string; reactions?: string[]; replyTo?: string; mediaUrl?: string }>(messages: M[]): M[] {
  const reactions = new Map<string, string[]>();
  const out: M[] = [];
  for (const m of messages) {
    const text = m.plaintext;
    if (!text || m.mediaUrl || text.startsWith("[")) { out.push(m); continue; }
    const env = parseEnvelope(text);
    if (env.kind === "rx") {
      reactions.set(env.target, [...(reactions.get(env.target) ?? []), env.emoji]);
      continue;
    }
    out.push(env.body === text ? m : { ...m, plaintext: env.body, replyTo: env.replyTo });
  }
  if (reactions.size === 0) return out;
  return out.map((m) => (reactions.has(m.id) ? { ...m, reactions: [...(m.reactions ?? []), ...reactions.get(m.id)!] } : m));
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

import { describe, expect, it } from "vitest";
import { applyEnvelopes, isNoteToSelf, parseEnvelope } from "@/lib/messenger-envelope";

describe("Qwalla message envelope", () => {
  it("unwraps a message envelope and keeps plain text as is", () => {
    expect(parseEnvelope('{"v":1,"k":"msg","b":"what\'s up"}')).toEqual({ kind: "msg", body: "what's up", replyTo: undefined });
    expect(parseEnvelope("yo")).toEqual({ kind: "msg", body: "yo" });
    expect(parseEnvelope('{"hello":1}')).toEqual({ kind: "msg", body: '{"hello":1}' });
  });

  it("turns reactions into emoji on their target and drops them from the list", () => {
    const out = applyEnvelopes([
      { id: "a", plaintext: '{"v":1,"k":"msg","b":"hi","r":"z"}' },
      { id: "b", plaintext: '{"v":1,"k":"rx","t":"a","e":"🔥"}' },
      { id: "c", plaintext: "[Unable to decrypt]" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["a", "c"]);
    expect(out[0]).toMatchObject({ plaintext: "hi", replyTo: "z", reactions: ["🔥"] });
    expect(out[1].plaintext).toBe("[Unable to decrypt]");
  });
});

describe("note to self detection", () => {
  const me = new Set(["uuid-me", "sign-me", "enc-me"]);
  it("does not treat an unresolved DM as a note to self", () => {
    expect(isNoteToSelf({ participants: [] }, me)).toBe(false);
    expect(isNoteToSelf({ participants: [], participantIds: ["uuid-me", "sign-other"] }, me)).toBe(false);
    expect(isNoteToSelf({}, me)).toBe(false);
  });
  it("still recognises real notes to self", () => {
    expect(isNoteToSelf({ name: "Note to Self" }, me)).toBe(true);
    expect(isNoteToSelf({ participantIds: ["uuid-me", "sign-me"] }, me)).toBe(true);
    expect(isNoteToSelf({ participants: [{ id: "uuid-me" }, { signingPublicKey: "sign-me" }] }, me)).toBe(true);
    expect(isNoteToSelf({ participants: [{ id: "uuid-me" }, { id: "other" }] }, me)).toBe(false);
  });
});

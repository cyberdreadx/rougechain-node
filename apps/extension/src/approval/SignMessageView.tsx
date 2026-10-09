import type { ReactNode } from "react";
import type { SignMessageReview } from "@rougechain/core/message-signing";

/**
 * What the user sees before signing a message for a dApp (`window.rougechain.signMessage`).
 *
 * `review` is prepared by the service worker (`reviewSignMessageRequest`): `review.display` is the
 * WHOLE message with control / invisible characters replaced by visible stand-ins. It is shown in
 * full in a scrollable box — never truncated — with its line and byte counts, so nothing can sit
 * below a cut. A sign-in message also gets a structured summary, and a red warning when the domain
 * it names is not the site asking.
 */

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="flex justify-between gap-3 text-sm">
            <span className="text-muted-foreground shrink-0">{label}</span>
            <span className="text-right min-w-0 break-all font-mono text-xs">{children}</span>
        </div>
    );
}

function Danger({ testId, title, children }: { testId: string; title: string; children: ReactNode }) {
    return (
        <div role="alert" data-testid={testId} className="rounded-xl border-2 border-red-500 bg-red-500/15 p-3 space-y-1">
            <p className="text-sm font-bold text-red-400">{title}</p>
            <p className="text-xs text-red-200 break-words">{children}</p>
        </div>
    );
}

function Caution({ testId, children }: { testId: string; children: ReactNode }) {
    return (
        <div role="alert" data-testid={testId} className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3">
            <p className="text-xs text-amber-200 break-words">{children}</p>
        </div>
    );
}

export function signMessageHasDanger(review: SignMessageReview): boolean {
    return review.domainMismatch || review.addressMismatch;
}

export default function SignMessageView({ review }: { review: SignMessageReview }) {
    const s = review.signIn;
    return (
        <div className="space-y-3">
            <p className="text-sm text-muted-foreground text-center">
                {s
                    ? "This site asks you to sign in by signing the message below."
                    : "This site asks you to sign the message below."}
            </p>

            {review.domainMismatch && (
                <Danger testId="domain-mismatch" title="This message is for a different site">
                    The message says it is for <b className="font-mono">{review.claimedDomain}</b>, but the request
                    comes from <b className="font-mono">{review.originHost || "an unknown site"}</b>. Signing it could
                    let this site sign in as you on {review.claimedDomain}. Deny unless you are certain.
                </Danger>
            )}
            {review.addressMismatch && s && (
                <Danger testId="address-mismatch" title="This message names a different wallet">
                    It names <b className="font-mono">{s.address}</b>, which is not the wallet that would sign.
                </Danger>
            )}
            {review.signInMalformed && (
                <Caution testId="sign-in-malformed">
                    This looks like a sign-in message but is not in the standard format, so its fields are not
                    shown separately. Read the full text before signing.
                </Caution>
            )}
            {review.expired && (
                <Caution testId="sign-in-expired">This sign-in message has already expired.</Caution>
            )}

            {s && (
                <div data-testid="sign-in-fields" className="rounded-xl border border-border bg-card/30 p-4 space-y-2.5">
                    <Field label="Domain">
                        <span className={review.domainMismatch ? "text-red-400 font-bold" : ""}>{s.domain}</span>
                    </Field>
                    <Field label="Address">
                        <span className={review.addressMismatch ? "text-red-400 font-bold" : ""}>{s.address}</span>
                    </Field>
                    <Field label="Nonce">{s.nonce}</Field>
                    <Field label="Expires">{s.expirationTime ?? "never (no expiry in the message)"}</Field>
                    <Field label="Issued">{s.issuedAt}</Field>
                    <Field label="Chain">{s.chainId}</Field>
                    <Field label="URI">{s.uri}</Field>
                </div>
            )}

            <div className="space-y-1">
                <p className="text-xs text-muted-foreground" data-testid="message-meta">
                    Full message · {review.lineCount.toLocaleString("en-US")} {review.lineCount === 1 ? "line" : "lines"} ·{" "}
                    {review.byteLength.toLocaleString("en-US")} bytes · scroll to read all of it
                </p>
                <div className="rounded-xl border border-border bg-card/30 p-3 max-h-[220px] overflow-auto" tabIndex={0}>
                    <pre data-testid="message-text" className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">{review.display}</pre>
                </div>
                <p className="text-[10px] text-muted-foreground">
                    Shown exactly as signed. Characters that are normally invisible appear as symbols such as ␍ or ⟨U+202E⟩.
                </p>
            </div>

            <p className="text-[11px] text-muted-foreground text-center">
                Signing a message proves you control this wallet. It cannot send a transaction or move funds.
            </p>
        </div>
    );
}

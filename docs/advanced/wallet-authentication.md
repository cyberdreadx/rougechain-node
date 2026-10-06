# Wallet Authentication (Sign a Message)

A website can ask a RougeChain wallet to **sign a message** to prove the visitor controls that
wallet. Nothing is sent to the chain and no funds can move. Use it for logins and for token
gating: "only holders of token X or an NFT from collection Y may enter".

```javascript
const { signature, publicKey, address } = await window.rougechain.signMessage({ message });
```

The site verifies the result on its server with `verifyMessage` or `verifySignIn` from
`@rougechain/sdk` (1.13.0 or later), then looks up what the wallet holds on a node.

## Which wallets support it

| Wallet | `signMessage` |
|--------|---------------|
| RougeChain Wallet browser extension | from version **1.8.0** |
| Qwalla in-app browser | after its next update (not in the builds released before this page) |
| rougechain.io built-in wallet | has no `window.rougechain` for other sites; it signs for first-party pages only |

Always feature-detect, and tell the user to update their wallet when the method is missing:

```javascript
const provider = window.rougechain;
if (!provider?.isRougeChain) throw new Error("Install the RougeChain wallet or open this page in Qwalla.");
if (typeof provider.signMessage !== "function") throw new Error("Update your RougeChain wallet to sign in.");
```

Do **not** fall back to `signTransaction` for logins. A transaction signature is a different
thing (see [Domain separation](#domain-separation)) and `verifyMessage` will not accept it.

## What the wallet does

`window.rougechain.signMessage({ message })`

- `message` is a string of at most **4,096 bytes** (UTF-8). It must be well-formed Unicode and
  not empty.
- The site must already be connected (`connect()`), otherwise the call rejects with
  `Site not connected. Call connect() first.`
- The wallet **asks the user every time**. There is no "remember this site" for signatures.
- The approval shows the requesting site, and the **whole message**: scrollable, never cut, with
  characters that are normally invisible (carriage return, zero-width and right-to-left marks,
  and so on) drawn as symbols so text cannot be hidden or reordered.
- When the message is a [sign-in message](#sign-in-message), the wallet also shows its domain,
  address, nonce and expiry, and a **red warning if the domain in the message is not the site
  that is asking**.
- A message that parses as a transaction payload (a JSON object with a `type` or `tx_type` field,
  or with `from` and `timestamp`) is refused with
  `signMessage refuses a message that looks like a transaction payload. Use signTransaction to sign a transaction.`
- It resolves to `{ signature, publicKey, address }` (hex signature, hex public key, `rouge1…`
  address), or rejects if the user declines.

## The signed bytes

The wallet does not sign the bare message. It signs:

```
UTF8("\x19RougeChain Signed Message:\n") ‖ decimal(len(message_bytes)) ‖ "\n" ‖ message_bytes
```

- `\x19` is the single byte `0x19`.
- `message_bytes` is the UTF-8 encoding of the string.
- `decimal(len(...))` is the byte length in ASCII decimal digits, without leading zeros.
- The signature scheme is **ML-DSA-65** (FIPS 204) with an empty context, the same parameters the
  wallet uses for transactions.

For the message `hello` the signed bytes are, in hex:

```
19 526f756765436861696e205369676e6564204d6573736167653a 0a 35 0a 68656c6c6f
   "RougeChain Signed Message:"                            \n "5" \n "hello"
```

ML-DSA signing is randomized, so signing the same message twice gives two different signatures.
Both verify.

**Sizes.** An ML-DSA-65 signature is **3,309 bytes** (6,618 hex characters, about 3.3 KB) and a
public key is **1,952 bytes** (3,904 hex characters, about 2 KB). Send them in a POST body, never
in a URL or a cookie, and keep the short `rouge1…` address (about 64 characters) in your session, not
the key.

### Domain separation

A signed message can never be used as a transaction, and a transaction signature can never pass
as a signed message:

- Every byte string a RougeChain node verifies a **transaction** signature over is a JSON
  document that starts with `{`: the legacy encodings (`serde_json` of the transaction struct),
  the signed payload of the `/api/v2/*` endpoints (must parse as a JSON object equal to the
  payload), and the CLI envelope (`{"tx_type",…,"payload":{…}}`). The node never verifies a
  transaction signature over raw caller-chosen bytes.
- Signed-message bytes start with `0x19`, a control character that cannot appear at the start of
  (or unescaped anywhere in) a JSON document.

So the two sets of byte strings do not overlap. The same construction, with a different prefix,
is what Ethereum's `personal_sign` uses.

## Sign-in message

For logins, sign a message in this exact format (modelled on
[Sign-In with Ethereum, EIP-4361](https://eips.ethereum.org/EIPS/eip-4361)). Wallets recognise
it and show its fields.

```
tickets.example.com wants you to sign in with your RougeChain account:
rouge1ayekjlm684n3hrpfg3fyv53s6n2r85eh4lf9hxwm4zzpw42p4p2srzg20p

Sign in to see your tickets.

URI: https://tickets.example.com/login
Version: 1
Chain ID: rougechain-mainnet-1
Nonce: 4f9c2d1e8a7b6c5d0011
Issued At: 2026-10-06T12:00:00.000Z
Expiration Time: 2026-10-06T12:10:00.000Z
Resources:
- https://tickets.example.com/events/42
```

| Line | Rule |
|------|------|
| 1 | `<domain> wants you to sign in with your RougeChain account:` — fixed wording. `domain` is your site's host, with the port if it is not the default (`localhost:5173`). No scheme, no path. |
| 2 | The signer's `rouge1…` address, lower case. |
| 3 | Empty. |
| 4 | Optional statement: one line of text. |
| 5 | Empty. (Without a statement the address is followed by two empty lines.) |
| `URI:` | The page or API the sign-in is for. No whitespace. |
| `Version:` | Always `1`. |
| `Chain ID:` | `rougechain-mainnet-1` (mainnet) or `rougechain-devnet-1` (testnet). A node reports its own in `GET /api/health`. |
| `Nonce:` | From your server, single use, **16 to 128 characters** of `A-Z a-z 0-9 - _`. |
| `Issued At:` | ISO 8601 time with a time zone, e.g. `new Date().toISOString()`. |
| `Expiration Time:` | Optional, same format. Recommended: a few minutes after `Issued At`. |
| `Resources:` | Optional. Then one `- <uri>` line per resource. |

Lines are separated by a single `\n`. There is no trailing newline. The order is fixed. There is
exactly one valid text for a given set of fields: `parseSignInMessage` returns `null` for
anything else (extra spaces, `\r\n`, another order, unknown lines).

Build it with `createSignInMessage` rather than by hand:

```typescript
import { createSignInMessage, pubkeyToAddress } from "@rougechain/sdk";

const message = createSignInMessage({
  domain: window.location.host,
  address: await pubkeyToAddress(publicKey),
  uri: window.location.origin + "/login",
  statement: "Sign in to see your tickets.",
  nonce,                                                     // from your server
  issuedAt: new Date().toISOString(),
  expirationTime: new Date(Date.now() + 10 * 60_000).toISOString(),
  chainId: "rougechain-mainnet-1",
});
```

## SDK reference

All of these are exported by `@rougechain/sdk` from 1.13.0.

| Function | Returns | Notes |
|----------|---------|-------|
| `signMessage(privateKeyHex, message)` | signature (hex) | `message` is a `string` or a `Uint8Array`. For scripts and servers that hold a key; browsers use the wallet. |
| `verifyMessage(publicKeyHex, message, signatureHex)` | `boolean` | `false` for anything that is not a valid signature of exactly that message by that key, including malformed input. Never throws. |
| `messageSigningBytes(message)` | `Uint8Array` | The exact bytes that are signed. |
| `createSignInMessage(fields)` | `string` | Throws on an invalid field. |
| `parseSignInMessage(text)` | fields or `null` | `null` unless the text is exactly canonical. |
| `verifySignIn(params)` | `Promise<{ valid: true, address, publicKey, fields } \| { valid: false, error }>` | See below. Never throws or rejects. |

`verifySignIn({ message, signature, publicKey, expectedDomain, expectedNonce, expectedChainId, now?, maxClockSkewMs?, maxAgeMs? })`
checks, in this order, and reports the first failure in `error`:

| `error` | Meaning |
|---------|---------|
| `malformed_message` | The text is not a canonical sign-in message. |
| `invalid_signature` | The signature is not valid for this text and public key. |
| `address_mismatch` | The address in the message is not the address of `publicKey`. |
| `domain_mismatch` | The message is for another site than `expectedDomain` (compared case-insensitively). |
| `nonce_mismatch` | The nonce is not `expectedNonce`. |
| `chain_id_mismatch` | The chain id is not `expectedChainId`. |
| `issued_in_future` | `Issued At` is later than `now` plus `maxClockSkewMs` (default 60 seconds). |
| `expired` | `now` is at or after `Expiration Time`. |
| `too_old` | Only with `maxAgeMs`: `Issued At` is longer ago than that. |

## Token gating: a complete example

The flow:

1. The browser asks your server for a **nonce**.
2. The browser connects the wallet, builds the sign-in message and calls `signMessage`.
3. Your server runs `verifySignIn`, marks the nonce used, and starts a session for the address.
4. Your server reads the wallet's **holdings from a node** and decides.
5. At the door (ticket scan, download, entry to the room) your server **reads the holdings
   again**.

### Browser

```javascript
import { createSignInMessage, pubkeyToAddress } from "@rougechain/sdk";

export async function signIn() {
  const provider = window.rougechain;
  if (!provider?.isRougeChain) throw new Error("Install the RougeChain wallet or open this page in Qwalla.");
  if (typeof provider.signMessage !== "function") throw new Error("Update your RougeChain wallet to sign in.");

  const { publicKey } = await provider.connect();
  const { nonce } = await (await fetch("/api/auth/nonce", { method: "POST", credentials: "include" })).json();

  const message = createSignInMessage({
    domain: window.location.host,
    address: await pubkeyToAddress(publicKey),
    uri: window.location.origin + "/login",
    statement: "Sign in to see your tickets.",
    nonce,
    issuedAt: new Date().toISOString(),
    expirationTime: new Date(Date.now() + 10 * 60_000).toISOString(),
    chainId: "rougechain-mainnet-1",
  });

  const signed = await provider.signMessage({ message });          // the wallet asks the user

  const res = await fetch("/api/auth/verify", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, signature: signed.signature, publicKey: signed.publicKey }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();                                                // { address, allowed }
}
```

### Server (Node 20+, Express)

```javascript
import express from "express";
import crypto from "node:crypto";
import { parseSignInMessage, verifySignIn } from "@rougechain/sdk";

const DOMAIN = "tickets.example.com";           // your site's host, exactly as in the browser's address bar
const CHAIN_ID = "rougechain-mainnet-1";
const NODE_API = "https://api.rougechain.io/api"; // a node YOU choose to trust; your own node is best
const GATE = { token: "TICKET", minBalance: 1, nftCollection: null };  // set nftCollection to a collection id to gate on an NFT

const app = express();
app.use(express.json({ limit: "32kb" }));       // a signature + public key are about 10.5 KB of hex

// Use a shared store with expiry (Redis, a database table) when you run more than one process.
const nonces = new Map();                       // nonce -> expiry (ms)
const sessions = new Map();                     // session id -> { address, publicKey }
const NONCE_TTL_MS = 10 * 60_000;

// 1. Issue a nonce. 16 random bytes as hex = 32 characters.
app.post("/api/auth/nonce", (req, res) => {
  const nonce = crypto.randomBytes(16).toString("hex");
  nonces.set(nonce, Date.now() + NONCE_TTL_MS);
  res.json({ nonce });
});

// 3. Verify the sign-in.
app.post("/api/auth/verify", async (req, res) => {
  const { message, signature, publicKey } = req.body ?? {};

  // The nonce must be one WE issued, not expired, and it is consumed NOW — before any other
  // check — so that a signed message can be presented exactly once.
  const nonce = parseSignInMessage(message)?.nonce;
  const expiry = nonce ? nonces.get(nonce) : undefined;
  if (nonce) nonces.delete(nonce);
  if (!expiry || expiry < Date.now()) return res.status(401).json({ error: "unknown or expired nonce" });

  const result = await verifySignIn({
    message, signature, publicKey,
    expectedDomain: DOMAIN,
    expectedNonce: nonce,
    expectedChainId: CHAIN_ID,
    maxAgeMs: NONCE_TTL_MS,
  });
  if (!result.valid) return res.status(401).json({ error: result.error });

  const sid = crypto.randomBytes(32).toString("hex");
  sessions.set(sid, { address: result.address, publicKey: result.publicKey });
  res.cookie("sid", sid, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 3_600_000 });
  res.json({ address: result.address, allowed: await holdsGate(result.publicKey) });
});

// 4. Read holdings from the node.
async function getJson(path) {
  const r = await fetch(NODE_API + path, { signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`node returned ${r.status} for ${path}`);
  return r.json();
}

async function holdsGate(publicKey) {
  if (GATE.token) {
    // GET /api/balance/:publicKey/:tokenSymbol -> { success, token_symbol, balance }
    const { balance } = await getJson(`/balance/${publicKey}/${encodeURIComponent(GATE.token)}`);
    if (balance >= GATE.minBalance) return true;
  }
  if (GATE.nftCollection) {
    // GET /api/nft/owner/:pubkey -> { nfts: [{ collection_id, token_id, owner, locked, ... }] }
    const { nfts } = await getJson(`/nft/owner/${publicKey}`);
    if (nfts.some((n) => n.collection_id === GATE.nftCollection)) return true;
  }
  return false;
}

// 5. Check again at the door. A session proves who signed in, not what they hold now.
app.post("/api/tickets/:id/admit", async (req, res) => {
  const sid = /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.cookie ?? "")?.[1];
  const session = sid && sessions.get(sid);
  if (!session) return res.status(401).json({ error: "sign in first" });
  if (!(await holdsGate(session.publicKey))) return res.status(403).json({ error: "this wallet no longer holds the required token" });
  res.json({ admitted: true, address: session.address });
});

app.listen(3000);
```

### The node endpoints used

These are public, unauthenticated `GET` endpoints of every RougeChain node
(see [Wallet API](../api-reference/wallet.md) and [NFTs API](../api-reference/nfts.md)):

| Endpoint | Returns | Use it for |
|----------|---------|-----------|
| `GET /api/balance/:publicKey/:tokenSymbol` | `{ success, token_symbol, balance }` | One token's balance. `balance` is `0` when the wallet holds none. The symbol is case-sensitive (`TICKET`, `qETH`). |
| `GET /api/balance/:publicKey` | `{ success, balance, token_balances, lp_balances }` | XRGE (`balance`) and every token at once (`token_balances` maps symbol to balance). |
| `GET /api/nft/owner/:pubkey` | `{ nfts: [ { collection_id, token_id, owner, name, locked, … } ] }` | Every NFT a wallet owns. |
| `GET /api/nft/token/:collectionId/:tokenId` | the NFT (`owner` is the holder's public key), or `404` | Who owns one specific NFT, for example a numbered ticket. |
| `GET /api/health` | `{ status, chain_id, height }` | Checking you are talking to the network you expect. |

Pass the wallet's **hex public key** (the `publicKey` that `verifySignIn` returned). The NFT
endpoints match the owner exactly as recorded, which is the public key; a `rouge1…` address does
not find NFTs there. Token balances are in the units the node reports for that token.

## What a verifier must check

`verifySignIn` does the cryptography. The rest is yours:

1. **Domain.** Pass your own host as `expectedDomain`, from configuration, never from the request.
   Without this check a signature given to another site could be replayed to yours.
2. **Nonce, single use.** Issue it on your server, keep it for a few minutes, and delete it the
   first time it is presented, whether or not verification succeeds. `verifySignIn` cannot know if
   a nonce was used before.
3. **Expiry.** Put an `Expiration Time` a few minutes ahead in the message, or pass `maxAgeMs`.
   Keep your server's clock synchronised.
4. **Chain ID.** Pass the network you gate on as `expectedChainId`, so a testnet sign-in is not
   accepted for mainnet holdings.
5. **Use the address `verifySignIn` returns.** Do not trust an address or public key sent
   alongside the message.
6. **Holdings come from a node you choose.** The signature proves control of a key; it says
   nothing about balances. Whoever runs the node you query can answer anything, so use your own
   node, or one you trust, and check `chain_id` in `/api/health` if the URL is configurable.
7. **Re-check holdings at entry time, not only at login.** Tokens and NFTs can be transferred a
   second after the login. A gate that only checks at login can be passed by lending the token to
   one wallet after another. Check when the benefit is delivered (the door scan, the download, the
   mint), and for a high-value gate consider admitting each NFT `token_id` only once.

A sign-in is not a transaction approval and gives your site no power over the wallet. It also
does not prove the visitor is a person, or that one person has only one wallet.

## For wallet developers

A wallet that implements `signMessage` must:

- sign exactly the bytes above, and never sign caller-supplied bytes through `signTransaction`
  without checking they are a transaction's JSON (otherwise a site could obtain a message
  signature through the transaction path);
- ask the user on every request and show the origin and the complete message;
- warn when a sign-in message names another domain than the requesting origin.

`@rougechain/sdk` exports what the reference wallets use: `reviewSignMessageRequest(message, origin, walletAddress)`,
`visibleMessageText`, `looksLikeTransactionPayload` and `MAX_SIGN_MESSAGE_BYTES`. A shared test
vector (fixed key, message, signed bytes and one valid signature) is in
`sdk/test/fixtures/sign-message-vector.json`.

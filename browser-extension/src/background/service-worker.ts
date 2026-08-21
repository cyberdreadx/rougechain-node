/**
 * Service worker for RougeChain Wallet Extension
 * Handles auto-lock timer, badge updates, and dApp connection messages.
 * Opens approval popup windows for connect/sign/send requests.
 */

import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { deriveEvmAccount, personalSign, hexToBytes as evmHexToBytes, decodeSignMessage, type EvmAccount } from "../lib/evm-wallet";
import { rpc, fillSignAndSend, getChain, isSupportedChain, BASE_MAINNET_CHAIN_ID } from "../lib/evm-rpc";

interface ConnectedSite {
    origin: string;
    connectedAt: number;
}

function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function sortKeysDeep(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(sortKeysDeep);
    if (obj !== null && typeof obj === "object") {
        const sorted: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) {
            sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
        }
        return sorted;
    }
    return obj;
}

function serializePayload(payload: Record<string, unknown>): string {
    return JSON.stringify(sortKeysDeep(payload));
}

function signPayload(payloadJson: string, privateKeyHex: string): string {
    const messageBytes = new TextEncoder().encode(payloadJson);
    const secretKey = hexToBytes(privateKeyHex);
    const signature = ml_dsa65.sign(messageBytes, secretKey);
    return bytesToHex(signature);
}

// ─── Auto-lock ───────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "auto-lock") {
        // The decrypted wallet lives in chrome.storage.session (memory-only) once unlocked;
        // clear both areas so auto-lock works regardless of which one holds it.
        chrome.storage.local.remove("pqc-unified-wallet");
        try { chrome.storage.session?.remove("pqc-unified-wallet"); } catch { /* no session area */ }
    }
    if (alarm.name === "messenger-poll") {
        pollForNewMessages();
    }
});

// The unlocked (decrypted) wallet is routed to chrome.storage.session by the popup's storage
// wrapper (see src/lib/storage.ts SESSION_KEYS) — memory-only, never on disk. The service worker
// is a trusted context and can read session storage, so read it FIRST, then fall back to
// chrome.storage.local for legacy/dev builds that kept a plaintext copy there. Reading only local
// (the old behavior) made every dApp connect/sign report "Wallet is locked" even while the popup
// showed unlocked.
function readUnifiedWalletRaw(): Promise<string | null> {
    return new Promise((resolve) => {
        const fromLocal = () => chrome.storage.local.get("pqc-unified-wallet", (d) => {
            const raw = d["pqc-unified-wallet"];
            resolve(typeof raw === "string" ? raw : null);
        });
        let session: chrome.storage.StorageArea | null = null;
        try { session = chrome.storage.session ?? null; } catch { session = null; }
        if (!session) { fromLocal(); return; }
        session.get("pqc-unified-wallet", (sd) => {
            const raw = sd["pqc-unified-wallet"];
            if (typeof raw === "string") { resolve(raw); return; }
            fromLocal();
        });
    });
}

// ─── Messenger notification polling ─────────────────────

const NOTIF_SNAPSHOT_KEY = "rougechain-notif-snapshot";

async function getFullWalletData(): Promise<{
    id: string; displayName: string;
    signingPublicKey: string; encryptionPublicKey: string;
} | null> {
    const raw = await readUnifiedWalletRaw();
    if (!raw) return null;
    try {
        const w = JSON.parse(raw);
        return {
            id: w.id,
            displayName: w.displayName,
            signingPublicKey: w.signingPublicKey,
            encryptionPublicKey: w.encryptionPublicKey,
        };
    } catch { return null; }
}

async function loadSnapshot(): Promise<Record<string, string>> {
    return new Promise((resolve) => {
        chrome.storage.local.get(NOTIF_SNAPSHOT_KEY, (data) => {
            try {
                resolve(data[NOTIF_SNAPSHOT_KEY] ? JSON.parse(data[NOTIF_SNAPSHOT_KEY]) : {});
            } catch { resolve({}); }
        });
    });
}

async function saveSnapshot(snapshot: Record<string, string>): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({ [NOTIF_SNAPSHOT_KEY]: JSON.stringify(snapshot) }, resolve);
    });
}

async function pollForNewMessages() {
    const wallet = await getFullWalletData();
    if (!wallet) return;

    const baseUrl = await getApiBaseUrl();
    const messengerBase = baseUrl.replace(/\/api$/, "/api/messenger");

    try {
        const params = new URLSearchParams({ walletId: wallet.id });
        if (wallet.signingPublicKey) params.set("signingPublicKey", wallet.signingPublicKey);
        if (wallet.encryptionPublicKey) params.set("encryptionPublicKey", wallet.encryptionPublicKey);

        const res = await fetch(`${messengerBase}/conversations?${params.toString()}`);
        if (!res.ok) return;
        const data = await res.json();
        const conversations = data.conversations || [];

        const myIds = new Set([wallet.id, wallet.signingPublicKey, wallet.encryptionPublicKey].filter(Boolean));
        const prevSnapshot = await loadSnapshot();
        const newSnapshot: Record<string, string> = {};

        // Fetch all wallets for display name resolution
        let allWallets: Array<{ id: string; display_name?: string; displayName?: string; signing_public_key?: string; signingPublicKey?: string }> = [];
        try {
            const walletsRes = await fetch(`${messengerBase}/wallets`);
            if (walletsRes.ok) {
                const wd = await walletsRes.json();
                allWallets = wd.wallets || wd || [];
            }
        } catch { /* ignore */ }

        for (const conv of conversations) {
            const ts = conv.last_message_at || "";
            const senderId = conv.last_sender_id || "";
            newSnapshot[conv.id] = ts;

            if (!ts || !senderId) continue;
            if (myIds.has(senderId)) continue;

            const prevTs = prevSnapshot[conv.id];
            if (prevTs !== undefined && ts > prevTs) {
                const senderWallet = allWallets.find((w: any) =>
                    w.id === senderId ||
                    (w.signing_public_key || w.signingPublicKey) === senderId ||
                    (w.encryption_public_key || w.encryptionPublicKey) === senderId
                );
                const senderName = (senderWallet as any)?.display_name || (senderWallet as any)?.displayName || "Someone";
                const preview = conv.last_message_preview || "New encrypted message";

                chrome.notifications.create(`msg-${conv.id}-${Date.now()}`, {
                    type: "basic",
                    iconUrl: "icons/icon-128.png",
                    title: senderName,
                    message: preview,
                    priority: 1,
                });
            }
        }

        await saveSnapshot(newSnapshot);
    } catch (err) {
        console.warn("Messenger poll failed:", err);
    }
}

chrome.notifications.onClicked.addListener((notifId) => {
    chrome.notifications.clear(notifId);
    chrome.action.openPopup?.();
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === "popup") {
        chrome.storage.local.get("pqc-unified-wallet-vault-settings", (data) => {
            const settings = data["pqc-unified-wallet-vault-settings"];
            let minutes = 5;
            if (settings) {
                try {
                    const parsed = JSON.parse(settings);
                    minutes = parsed.autoLockMinutes || 5;
                } catch { /* use default */ }
            }
            chrome.alarms.clear("auto-lock");
            chrome.alarms.create("auto-lock", { delayInMinutes: minutes });
        });

        chrome.alarms.get("messenger-poll", (existing) => {
            if (!existing) {
                chrome.alarms.create("messenger-poll", { periodInMinutes: 0.25 });
            }
        });

        port.onDisconnect.addListener(() => {
            // Popup closed — alarm continues running
        });
    }
});

// ─── Install handler ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
    console.log("RougeChain Wallet Extension installed");
    chrome.alarms.create("messenger-poll", { periodInMinutes: 0.25 });
});

// ─── Storage helpers ─────────────────────────────────────

function getConnectedSites(): Promise<ConnectedSite[]> {
    return new Promise((resolve) => {
        chrome.storage.local.get("rougechain-connected-sites", (data) => {
            const raw = data["rougechain-connected-sites"];
            if (raw) {
                try {
                    resolve(JSON.parse(raw));
                    return;
                } catch { /* fall through */ }
            }
            resolve([]);
        });
    });
}

function saveConnectedSites(sites: ConnectedSite[]): Promise<void> {
    return new Promise((resolve) => {
        chrome.storage.local.set({
            "rougechain-connected-sites": JSON.stringify(sites),
        }, resolve);
    });
}

async function getWalletData(): Promise<{ publicKey: string; privateKey: string } | null> {
    const raw = await readUnifiedWalletRaw();
    if (!raw) return null;
    try {
        const wallet = JSON.parse(raw);
        if (!wallet.signingPublicKey || !wallet.signingPrivateKey) return null;
        return { publicKey: wallet.signingPublicKey, privateKey: wallet.signingPrivateKey };
    } catch { return null; }
}

function getApiBaseUrl(): Promise<string> {
    return new Promise((resolve) => {
        chrome.storage.local.get(["rougechain-custom-node-url"], (data) => {
            const custom = data["rougechain-custom-node-url"];
            if (custom) {
                let url = custom.replace(/\/+$/, "");
                if (!url.endsWith("/api")) url += "/api";
                resolve(url);
                return;
            }
            resolve("https://api.rougechain.io/api");
        });
    });
}

// ─── Approval popup logic ────────────────────────────────

let approvalCounter = 0;

/**
 * Opens the approval popup and waits for the user to approve or deny.
 * Returns `true` if approved, `false` if denied or window closed.
 */
function requestApproval(
    type: "connect" | "sign" | "send" | "evm-connect" | "evm-personal-sign" | "evm-send",
    origin: string,
    payload?: Record<string, unknown>
): Promise<boolean> {
    return new Promise((resolve) => {
        const requestId = `${Date.now()}-${++approvalCounter}`;

        // Store payload data in session storage for the popup to read
        chrome.storage.session.set({
            [`approval-${requestId}`]: { payload, origin, type },
        });

        // Build the popup URL
        const params = new URLSearchParams({
            id: requestId,
            type,
            origin,
        });

        // Open approval popup window
        chrome.windows.create(
            {
                url: chrome.runtime.getURL(`approval.html?${params.toString()}`),
                type: "popup",
                width: 380,
                height: 520,
                focused: true,
            },
            (win) => {
                const windowId = win?.id;

                // Listen for the response from the popup
                const storageListener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
                    const responseKey = `approval-response-${requestId}`;
                    if (changes[responseKey]) {
                        cleanup();
                        const response = changes[responseKey].newValue;
                        resolve(response?.approved === true);
                    }
                };

                // Listen for window close (user closed without clicking)
                const windowListener = (closedWindowId: number) => {
                    if (closedWindowId === windowId) {
                        // Give a brief moment for storage write to complete
                        setTimeout(() => {
                            chrome.storage.session.get(`approval-response-${requestId}`, (data) => {
                                const response = data[`approval-response-${requestId}`];
                                cleanup();
                                if (response) {
                                    resolve(response.approved === true);
                                } else {
                                    resolve(false); // Window closed = deny
                                }
                            });
                        }, 300);
                    }
                };

                const cleanup = () => {
                    chrome.storage.session.onChanged.removeListener(storageListener);
                    chrome.windows.onRemoved.removeListener(windowListener);
                    // Clean up stored data
                    chrome.storage.session.remove([
                        `approval-${requestId}`,
                        `approval-response-${requestId}`,
                    ]);
                };

                chrome.storage.session.onChanged.addListener(storageListener);
                chrome.windows.onRemoved.addListener(windowListener);

                // Timeout after 2 minutes
                setTimeout(() => {
                    cleanup();
                    resolve(false);
                }, 120_000);
            }
        );
    });
}

// ─── dApp message handler ────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "rougechain-request") return false;

    const { method, params, origin } = message;

    (async () => {
        try {
            switch (method) {
                case "connect": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked or not set up" });
                        return;
                    }

                    // Check if already connected — skip approval
                    const sites = await getConnectedSites();
                    const alreadyConnected = sites.some(s => s.origin === origin);

                    if (!alreadyConnected) {
                        // Open approval popup
                        const approved = await requestApproval("connect", origin);
                        if (!approved) {
                            sendResponse({ error: "User denied connection" });
                            return;
                        }
                        sites.push({ origin, connectedAt: Date.now() });
                        await saveConnectedSites(sites);
                    }

                    sendResponse({ result: { publicKey: wallet.publicKey } });
                    break;
                }

                case "getBalance": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    if (!sites.some(s => s.origin === origin)) {
                        sendResponse({ error: "Site not connected. Call connect() first." });
                        return;
                    }

                    const baseUrl = await getApiBaseUrl();
                    const res = await fetch(`${baseUrl}/balance/${wallet.publicKey}`);
                    if (!res.ok) {
                        sendResponse({ error: `Node returned ${res.status}` });
                        return;
                    }
                    const data = await res.json() as {
                        success: boolean;
                        balance: number;
                        token_balances?: Record<string, number>;
                    };

                    sendResponse({
                        result: {
                            balance: data.balance || 0,
                            tokens: data.token_balances || {},
                        },
                    });
                    break;
                }

                case "signTransaction": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    if (!sites.some(s => s.origin === origin)) {
                        sendResponse({ error: "Site not connected" });
                        return;
                    }

                    const payload = params?.payload;
                    if (!payload || typeof payload !== "object") {
                        sendResponse({ error: "Invalid payload" });
                        return;
                    }

                    // Open approval popup for signing
                    const signApproved = await requestApproval("sign", origin, payload as Record<string, unknown>);
                    if (!signApproved) {
                        sendResponse({ error: "User denied signature request" });
                        return;
                    }

                    const signedPayload = serializePayload(payload as Record<string, unknown>);
                    const signSig = signPayload(signedPayload, wallet.privateKey);
                    sendResponse({
                        result: {
                            signedPayload,
                            signature: signSig,
                            publicKey: wallet.publicKey,
                        },
                    });
                    break;
                }

                case "sendTransaction": {
                    const wallet = await getWalletData();
                    if (!wallet) {
                        sendResponse({ error: "Wallet is locked" });
                        return;
                    }

                    const sites = await getConnectedSites();
                    if (!sites.some(s => s.origin === origin)) {
                        sendResponse({ error: "Site not connected" });
                        return;
                    }

                    const payload = params?.payload;
                    if (!payload || typeof payload !== "object") {
                        sendResponse({ error: "Invalid payload" });
                        return;
                    }

                    // Open approval popup for transaction
                    const sendApproved = await requestApproval("send", origin, payload as Record<string, unknown>);
                    if (!sendApproved) {
                        sendResponse({ error: "User denied transaction" });
                        return;
                    }

                    const baseUrl = await getApiBaseUrl();
                    const txPayload = {
                        ...payload as Record<string, unknown>,
                        from: wallet.publicKey,
                        timestamp: Date.now(),
                        nonce: crypto.randomUUID(),
                    };

                    const txPayloadJson = serializePayload(txPayload);
                    const txSig = signPayload(txPayloadJson, wallet.privateKey);

                    // v2 signed transfer route (/v2/tx/submit never existed → 404).
                    const res = await fetch(`${baseUrl}/v2/transfer`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            payload: txPayload,
                            signature: txSig,
                            public_key: wallet.publicKey,
                        }),
                    });

                    const data = await res.json();
                    if (data.success) {
                        sendResponse({ result: { txId: data.txId || data.tx_id } });
                    } else {
                        sendResponse({ error: data.error || "Transaction failed" });
                    }
                    break;
                }

                default:
                    sendResponse({ error: `Unknown method: ${method}` });
            }
        } catch (err: any) {
            sendResponse({ error: err.message || "Internal error" });
        }
    })();

    return true; // keep the message channel open for async response
});

// ═══════════════════════════════════════════════════════════════════════════
// EVM (Base) provider — window.ethereum bridge support
// ═══════════════════════════════════════════════════════════════════════════

const EVM_CHAIN_KEY = "rougechain-evm-chain";
const EVM_ORIGINS_KEY = "rougechain-evm-origins";

/** Derive the Base account from the unlocked wallet's mnemonic (null if locked/raw-key). */
async function getEvmAccount(): Promise<EvmAccount | null> {
    const raw = await readUnifiedWalletRaw();
    if (!raw) return null;
    try {
        const w = JSON.parse(raw);
        return deriveEvmAccount(w.mnemonic);
    } catch { return null; }
}

function getEvmChainId(): Promise<number> {
    return new Promise((resolve) => {
        chrome.storage.local.get(EVM_CHAIN_KEY, (data) => {
            const c = Number(data[EVM_CHAIN_KEY]);
            resolve(isSupportedChain(c) ? c : BASE_MAINNET_CHAIN_ID);
        });
    });
}
function setEvmChainId(chainId: number): Promise<void> {
    return new Promise((resolve) => chrome.storage.local.set({ [EVM_CHAIN_KEY]: chainId }, () => resolve()));
}

function getEvmOrigins(): Promise<string[]> {
    return new Promise((resolve) => {
        chrome.storage.local.get(EVM_ORIGINS_KEY, (data) => {
            try { resolve(data[EVM_ORIGINS_KEY] ? JSON.parse(data[EVM_ORIGINS_KEY]) : []); }
            catch { resolve([]); }
        });
    });
}
async function addEvmOrigin(origin: string): Promise<void> {
    const list = await getEvmOrigins();
    if (!list.includes(origin)) {
        list.push(origin);
        await new Promise<void>((r) => chrome.storage.local.set({ [EVM_ORIGINS_KEY]: JSON.stringify(list) }, () => r()));
    }
}

function emitEvm(tabId: number | undefined, event: string, data: unknown) {
    if (tabId === undefined) return;
    chrome.tabs.sendMessage(tabId, { type: "evm-event", event, data }).catch(() => { /* tab gone */ });
}

function weiToEth(hexWei: string | undefined): string {
    if (!hexWei) return "0";
    try {
        const wei = BigInt(hexWei);
        const whole = wei / 10n ** 18n;
        const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
        return frac ? `${whole}.${frac}` : `${whole}`;
    } catch { return "0"; }
}

interface EvmResult { result?: unknown; error?: { code: number; message: string } }
const evmErr = (code: number, message: string): EvmResult => ({ error: { code, message } });

// Methods safe to proxy straight to the Base RPC (read-only).
const READ_PROXY = new Set([
    "eth_call", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
    "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
    "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash",
    "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount",
    "eth_getLogs", "eth_getProof", "eth_chainId", "net_version",
]);

async function handleEvmRequest(
    method: string,
    rawParams: unknown,
    origin: string,
    tabId: number | undefined,
): Promise<EvmResult> {
    const params = Array.isArray(rawParams) ? rawParams : [];
    const chainId = await getEvmChainId();
    const chain = getChain(chainId);

    switch (method) {
        case "eth_chainId":
            return { result: chain.chainIdHex };
        case "net_version":
            return { result: String(chainId) };

        case "eth_accounts": {
            const origins = await getEvmOrigins();
            if (!origins.includes(origin)) return { result: [] };
            const acct = await getEvmAccount();
            return { result: acct ? [acct.address] : [] };
        }

        case "eth_requestAccounts": {
            const acct = await getEvmAccount();
            if (!acct) return evmErr(4100, "No Base account — unlock a wallet created from a recovery phrase");
            const origins = await getEvmOrigins();
            if (!origins.includes(origin)) {
                const approved = await requestApproval("evm-connect", origin, { address: acct.address, chain: chain.name });
                if (!approved) return evmErr(4001, "User rejected the connection request");
                await addEvmOrigin(origin);
            }
            emitEvm(tabId, "connect", { chainId: chain.chainIdHex });
            emitEvm(tabId, "accountsChanged", [acct.address]);
            return { result: [acct.address] };
        }

        case "wallet_switchEthereumChain": {
            const target = parseInt((params[0] as { chainId?: string })?.chainId ?? "", 16);
            if (!isSupportedChain(target)) {
                return evmErr(4902, `Unrecognized chain. RougeChain wallet supports Base (${getChain(BASE_MAINNET_CHAIN_ID).chainIdHex}) and Base Sepolia only.`);
            }
            await setEvmChainId(target);
            emitEvm(tabId, "chainChanged", getChain(target).chainIdHex);
            return { result: null };
        }

        case "wallet_addEthereumChain": {
            const target = parseInt((params[0] as { chainId?: string })?.chainId ?? "", 16);
            if (!isSupportedChain(target)) {
                return evmErr(4902, "RougeChain wallet only supports the Base networks.");
            }
            await setEvmChainId(target);
            emitEvm(tabId, "chainChanged", getChain(target).chainIdHex);
            return { result: null };
        }

        case "personal_sign": {
            const acct = await getEvmAccount();
            if (!acct) return evmErr(4100, "No Base account available");
            const origins = await getEvmOrigins();
            if (!origins.includes(origin)) return evmErr(4100, "Connect the site first (eth_requestAccounts)");
            // params order is [message, address] per EIP-1191; tolerate the reverse.
            const addrLc = acct.address.toLowerCase();
            const msgParam = String(params[0]).toLowerCase() === addrLc ? String(params[1]) : String(params[0]);
            const approved = await requestApproval("evm-personal-sign", origin, {
                address: acct.address, chain: chain.name,
                message: decodeSignMessage(msgParam), raw: msgParam,
            });
            if (!approved) return evmErr(4001, "User rejected the signature request");
            const bytes = msgParam.startsWith("0x") ? evmHexToBytes(msgParam) : msgParam;
            return { result: personalSign(acct.privateKey, bytes) };
        }

        case "eth_sendTransaction": {
            const acct = await getEvmAccount();
            if (!acct) return evmErr(4100, "No Base account available");
            const origins = await getEvmOrigins();
            if (!origins.includes(origin)) return evmErr(4100, "Connect the site first (eth_requestAccounts)");
            const tx = (params[0] ?? {}) as { from?: string; to?: string; value?: string; data?: string; gas?: string };
            if (!tx.to) return evmErr(-32602, "Transaction is missing 'to'");
            const approved = await requestApproval("evm-send", origin, {
                address: acct.address, chain: chain.name, chainId,
                to: tx.to, valueEth: weiToEth(tx.value), hasData: !!(tx.data && tx.data !== "0x"),
            });
            if (!approved) return evmErr(4001, "User rejected the transaction");
            try {
                const hash = await fillSignAndSend(chainId, acct, { from: acct.address, to: tx.to, value: tx.value, data: tx.data, gas: tx.gas });
                return { result: hash };
            } catch (e: any) {
                return evmErr(-32000, e?.message || "Transaction failed on Base");
            }
        }

        case "eth_sign":
        case "eth_signTypedData":
        case "eth_signTypedData_v3":
        case "eth_signTypedData_v4":
            return evmErr(4200, `${method} is not supported by RougeChain wallet (blind-signing protection)`);

        default: {
            if (READ_PROXY.has(method)) {
                try { return { result: await rpc(chainId, method, params) }; }
                catch (e: any) { return evmErr(-32603, e?.message || `RPC error (${method})`); }
            }
            return evmErr(4200, `Unsupported method: ${method}`);
        }
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "evm-request") return false;
    (async () => {
        try {
            const res = await handleEvmRequest(message.method, message.params, message.origin, sender.tab?.id);
            sendResponse(res);
        } catch (err: any) {
            sendResponse({ error: { code: -32603, message: err?.message || "Internal error" } });
        }
    })();
    return true;
});

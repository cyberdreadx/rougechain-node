/**
 * Content script — bridges messages between the injected provider
 * (window.rougechain) and the extension service worker.
 *
 * 1. Injects provider.js into the page's main world
 * 2. Relays postMessage requests to chrome.runtime
 * 3. Relays chrome.runtime responses back to the page
 */

const PROVIDER_ID = "rougechain-provider";
const EVM_PROVIDER_ID = "rougechain-evm-provider";
const EVM_CONTENT_ID = "rougechain-evm-content";

// Inject the RougeChain (PQC) provider script into the page's main world
const script = document.createElement("script");
script.src = chrome.runtime.getURL("provider.js");
script.type = "module";
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove();

// Inject the EVM (Base) provider script — window.ethereum for the bridge
const evmScript = document.createElement("script");
evmScript.src = chrome.runtime.getURL("evm-provider.js");
evmScript.type = "module";
(document.head || document.documentElement).appendChild(evmScript);
evmScript.onload = () => evmScript.remove();

// Listen for requests from the injected provider
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PROVIDER_ID || msg.type !== "rougechain-request") return;

    chrome.runtime.sendMessage(
        {
            type: "rougechain-request",
            id: msg.id,
            method: msg.method,
            params: msg.params,
            origin: window.location.origin,
        },
        (response) => {
            if (chrome.runtime.lastError) {
                window.postMessage({
                    source: "rougechain-content-script",
                    type: "rougechain-response",
                    id: msg.id,
                    error: chrome.runtime.lastError.message || "Extension communication error",
                }, "*");
                return;
            }

            window.postMessage({
                source: "rougechain-content-script",
                type: "rougechain-response",
                id: msg.id,
                result: response?.result,
                error: response?.error,
            }, "*");
        }
    );
});

// ── EVM (Base) provider bus ───────────────────────────────────────────────
window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== EVM_PROVIDER_ID || msg.type !== "evm-request") return;

    chrome.runtime.sendMessage(
        { type: "evm-request", id: msg.id, method: msg.method, params: msg.params, origin: window.location.origin },
        (response) => {
            if (chrome.runtime.lastError) {
                window.postMessage({
                    source: EVM_CONTENT_ID, type: "evm-response", id: msg.id,
                    error: { code: 4001, message: chrome.runtime.lastError.message || "Extension communication error" },
                }, "*");
                return;
            }
            window.postMessage({
                source: EVM_CONTENT_ID, type: "evm-response", id: msg.id,
                result: response?.result, error: response?.error,
            }, "*");
        }
    );
});

// Listen for events pushed from the service worker (both buses)
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "rougechain-event") {
        window.postMessage({
            source: "rougechain-content-script",
            type: "rougechain-event",
            event: message.event,
            data: message.data,
        }, "*");
    }
    if (message.type === "evm-event") {
        window.postMessage({
            source: EVM_CONTENT_ID,
            type: "evm-event",
            event: message.event,
            data: message.data,
        }, "*");
    }
});

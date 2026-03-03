/**
 * Content script — bridges messages between the injected provider
 * (window.rougechain) and the extension service worker.
 *
 * 1. Injects provider.js into the page's main world
 * 2. Relays postMessage requests to chrome.runtime
 * 3. Relays chrome.runtime responses back to the page
 */

const PROVIDER_ID = "rougechain-provider";

// Inject the provider script into the page's main world
const script = document.createElement("script");
script.src = chrome.runtime.getURL("provider.js");
script.type = "module";
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove();

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

// Listen for events pushed from the service worker
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "rougechain-event") {
        window.postMessage({
            source: "rougechain-content-script",
            type: "rougechain-event",
            event: message.event,
            data: message.data,
        }, "*");
    }
});

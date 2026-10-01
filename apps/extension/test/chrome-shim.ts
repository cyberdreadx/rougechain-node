/** Minimal in-memory chrome.storage.{local,session} so src/lib/storage.ts runs under Node. */
type Area = Record<string, unknown>;

function makeArea(data: Area) {
    return {
        get: async (_keys: null) => ({ ...data }),
        set: async (items: Area) => { Object.assign(data, items); },
        remove: async (key: string) => { delete data[key]; },
    };
}

export const localData: Area = {};
export const sessionData: Area = {};

export function installChromeShim(): void {
    (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: { local: makeArea(localData), session: makeArea(sessionData) },
    };
}

export function resetChromeData(): void {
    for (const k of Object.keys(localData)) delete localData[k];
    for (const k of Object.keys(sessionData)) delete sessionData[k];
}

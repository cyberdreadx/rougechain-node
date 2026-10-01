const SETTINGS_KEY = "pqc_notification_settings";

export interface NotificationSettings {
  enabled: boolean;
  sound: boolean;
  desktopEnabled: boolean;
}

const DEFAULT_SETTINGS: NotificationSettings = {
  enabled: true,
  sound: true,
  desktopEnabled: true,
};

export function loadNotificationSettings(): NotificationSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveNotificationSettings(settings: NotificationSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

export function playNotificationSound(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume();

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = "sine";
    const t = ctx.currentTime;

    // Two-tone chime: C6 → E6
    osc.frequency.setValueAtTime(1047, t);
    osc.frequency.setValueAtTime(1319, t + 0.12);

    gain.gain.setValueAtTime(0.15, t);
    gain.gain.linearRampToValueAtTime(0.15, t + 0.1);
    gain.gain.linearRampToValueAtTime(0, t + 0.3);

    osc.start(t);
    osc.stop(t + 0.3);
  } catch { /* audio not available */ }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function hasNotificationPermission(): boolean {
  if (!("Notification" in window)) return false;
  return Notification.permission === "granted";
}

export function showDesktopNotification(
  title: string,
  body: string,
  onClick?: () => void
): void {
  if (!hasNotificationPermission()) return;

  try {
    const notification = new Notification(title, {
      body,
      icon: "/icons/icon-192x192.png",
      badge: "/icons/icon-32x32.png",
      tag: `rougechain-${Date.now()}`,
      silent: true,
    });

    if (onClick) {
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
    }

    setTimeout(() => notification.close(), 8000);
  } catch { /* service worker context or not supported */ }
}

const SEEN_KEY = "pqc_seen_messages";
const MAX_SEEN = 500;

function loadSeenMessageIds(): Set<string> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* ignore */ }
  return new Set();
}

function saveSeenMessageIds(ids: Set<string>): void {
  const arr = Array.from(ids);
  const trimmed = arr.length > MAX_SEEN ? arr.slice(arr.length - MAX_SEEN) : arr;
  localStorage.setItem(SEEN_KEY, JSON.stringify(trimmed));
}

export function markMessageSeen(messageId: string): void {
  const seen = loadSeenMessageIds();
  seen.add(messageId);
  saveSeenMessageIds(seen);
}

export function isMessageSeen(messageId: string): boolean {
  return loadSeenMessageIds().has(messageId);
}

export interface ConversationActivity {
  conversationId: string;
  lastMessageAt?: string;
  lastSenderId?: string;
  lastMessagePreview?: string;
  unreadCount?: number;
}

/**
 * Compare conversation activity snapshots and fire notifications for new messages.
 * Returns the new snapshot to store for the next comparison.
 */
export function detectNewActivity(
  conversations: ConversationActivity[],
  previousSnapshot: Map<string, string>,
  myIds: Set<string>,
  resolveDisplayName: (senderId: string) => string,
  onNotify?: (conversationId: string) => void
): Map<string, string> {
  const settings = loadNotificationSettings();
  const newSnapshot = new Map<string, string>();

  for (const conv of conversations) {
    const ts = conv.lastMessageAt || "";
    newSnapshot.set(conv.conversationId, ts);

    if (!settings.enabled || !ts) continue;

    const prevTs = previousSnapshot.get(conv.conversationId);

    const isNew = prevTs !== undefined && ts > prevTs;
    const isFromOther = conv.lastSenderId ? !myIds.has(conv.lastSenderId) : false;

    if (isNew && isFromOther) {
      const senderName = conv.lastSenderId
        ? resolveDisplayName(conv.lastSenderId)
        : "Someone";
      const preview = conv.lastMessagePreview || "New encrypted message";

      if (settings.sound) playNotificationSound();

      if (settings.desktopEnabled && document.hidden) {
        showDesktopNotification(
          senderName,
          preview,
          () => onNotify?.(conv.conversationId)
        );
      }
    }
  }

  return newSnapshot;
}

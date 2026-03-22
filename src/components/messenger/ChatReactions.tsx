import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Message } from "@/lib/pqc-messenger";

// ─── Types ─────────────────────────────────────────────────────

export interface ReactionData {
  type: "reaction";
  messageId: string;
  emoji: string;
}

const REACTION_EMOJIS = ["👍", "❤️", "😂", "🔥", "👏", "😮"];

// ─── Helpers ───────────────────────────────────────────────────

export function parseReactionMessage(text: string): ReactionData | null {
  if (!text.startsWith("REACTION:")) return null;
  try {
    return JSON.parse(text.slice(9));
  } catch {
    return null;
  }
}

export function encodeReactionMessage(data: ReactionData): string {
  return `REACTION:${JSON.stringify(data)}`;
}

/** Returns true if a message is a system message (reaction, etc.) that shouldn't be shown as a normal bubble */
export function isSystemMessage(text: string | undefined): boolean {
  if (!text) return false;
  return text.startsWith("REACTION:");
}

/** Aggregate reactions from messages into a map of messageId → { emoji: count } */
export function aggregateReactions(
  messages: Message[],
  myIds: Set<string>
): Map<string, { emoji: string; count: number; myReaction: boolean }[]> {
  const reactionMap = new Map<string, Map<string, { count: number; senders: Set<string> }>>();

  for (const msg of messages) {
    const reaction = msg.plaintext ? parseReactionMessage(msg.plaintext) : null;
    if (!reaction) continue;

    if (!reactionMap.has(reaction.messageId)) {
      reactionMap.set(reaction.messageId, new Map());
    }
    const emojiMap = reactionMap.get(reaction.messageId)!;
    if (!emojiMap.has(reaction.emoji)) {
      emojiMap.set(reaction.emoji, { count: 0, senders: new Set() });
    }
    const entry = emojiMap.get(reaction.emoji)!;
    // Only count once per sender per emoji per message
    if (!entry.senders.has(msg.senderWalletId)) {
      entry.count++;
      entry.senders.add(msg.senderWalletId);
    }
  }

  const result = new Map<string, { emoji: string; count: number; myReaction: boolean }[]>();
  for (const [messageId, emojiMap] of reactionMap) {
    const reactions = Array.from(emojiMap.entries()).map(([emoji, { count, senders }]) => ({
      emoji,
      count,
      myReaction: Array.from(senders).some((id) => myIds.has(id)),
    }));
    result.set(messageId, reactions);
  }
  return result;
}

// ─── Reaction Picker ───────────────────────────────────────────

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position: "above" | "below";
}

export const ReactionPicker = ({ onSelect, onClose, position }: ReactionPickerProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8, y: position === "above" ? 10 : -10 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.8 }}
      className={`absolute ${position === "above" ? "bottom-full mb-2" : "top-full mt-2"} z-30 flex gap-1 bg-card border border-border rounded-full px-2 py-1.5 shadow-xl`}
    >
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(emoji);
          }}
          className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-muted/80 transition-colors text-lg hover:scale-125 active:scale-90 transition-transform"
        >
          {emoji}
        </button>
      ))}
    </motion.div>
  );
};

// ─── Reaction Badges ───────────────────────────────────────────

interface ReactionBadgesProps {
  reactions: { emoji: string; count: number; myReaction: boolean }[];
  onReact?: (emoji: string) => void;
}

export const ReactionBadges = ({ reactions, onReact }: ReactionBadgesProps) => {
  if (!reactions || reactions.length === 0) return null;

  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      {reactions.map(({ emoji, count, myReaction }) => (
        <button
          key={emoji}
          onClick={(e) => {
            e.stopPropagation();
            onReact?.(emoji);
          }}
          className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-xs border transition-colors ${
            myReaction
              ? "bg-primary/20 border-primary/40 text-primary"
              : "bg-muted/50 border-border hover:bg-muted"
          }`}
        >
          <span className="text-sm">{emoji}</span>
          {count > 1 && <span className="text-[10px] font-medium">{count}</span>}
        </button>
      ))}
    </div>
  );
};

export default ReactionPicker;

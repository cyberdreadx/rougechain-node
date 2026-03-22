import { motion } from "framer-motion";
import { X, Reply } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────

export interface ReplyData {
  type: "reply";
  replyTo: string;       // message ID being replied to
  replyPreview: string;  // truncated preview of original message
  text: string;          // the actual reply text
}

// ─── Helpers ───────────────────────────────────────────────────

export function parseReplyMessage(text: string): ReplyData | null {
  if (!text.startsWith("REPLY:")) return null;
  try {
    return JSON.parse(text.slice(6));
  } catch {
    return null;
  }
}

export function encodeReplyMessage(data: ReplyData): string {
  return `REPLY:${JSON.stringify(data)}`;
}

// ─── Quoted Message Block (rendered inside message bubble) ────

interface QuotedMessageProps {
  preview: string;
  isOwn: boolean;
}

export const QuotedMessage = ({ preview, isOwn }: QuotedMessageProps) => (
  <div
    className={`mb-1.5 pl-2 border-l-2 rounded-r text-xs py-1 pr-2 ${
      isOwn
        ? "border-primary-foreground/40 bg-primary-foreground/10 text-primary-foreground/70"
        : "border-primary/40 bg-primary/10 text-muted-foreground"
    }`}
  >
    <p className="truncate max-w-[200px]">{preview}</p>
  </div>
);

// ─── Reply Composer (shown above input when replying) ─────────

interface ReplyComposerProps {
  replyingToText: string;
  replyingToSender: string;
  onCancel: () => void;
}

export const ReplyComposer = ({ replyingToText, replyingToSender, onCancel }: ReplyComposerProps) => (
  <motion.div
    initial={{ height: 0, opacity: 0 }}
    animate={{ height: "auto", opacity: 1 }}
    exit={{ height: 0, opacity: 0 }}
    className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border overflow-hidden"
  >
    <Reply className="w-3.5 h-3.5 text-primary flex-shrink-0" />
    <div className="flex-1 min-w-0">
      <p className="text-[10px] text-primary font-medium">{replyingToSender}</p>
      <p className="text-xs text-muted-foreground truncate">{replyingToText}</p>
    </div>
    <button
      onClick={onCancel}
      className="p-1 rounded-full hover:bg-muted transition-colors flex-shrink-0"
    >
      <X className="w-3 h-3" />
    </button>
  </motion.div>
);

export default QuotedMessage;

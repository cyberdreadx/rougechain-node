import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, User, MessageSquare, Loader2, Bot, Sparkles, UserPlus, CheckCircle2, AlertCircle, QrCode, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Wallet, WalletWithPrivateKeys, Conversation } from "@/lib/pqc-messenger";
import { createConversation, getOrCreateDemoBot, getWallets } from "@/lib/pqc-messenger";
import PqcQrScanner from "@/components/wallet/PqcQrScanner";

interface ContactPickerProps {
  contacts: Wallet[];
  wallet: WalletWithPrivateKeys;
  onClose: () => void;
  onConversationCreated: (conversation: Conversation) => void;
}

// Parse xrge: prefixed address or raw public key
const parseAddress = (input: string): { valid: boolean; publicKey: string; error?: string } => {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, publicKey: "", error: "Enter a public key or xrge: address" };
  }

  // Remove xrge: prefix if present
  const prefixMatch = trimmed.match(/^xrge:/i);
  const rawKey = prefixMatch ? trimmed.slice(5) : trimmed;

  // ML-DSA-65 public keys are 1952 bytes = 3904 hex chars or ~2600 base64 chars
  if (rawKey.length < 100) {
    return { valid: false, publicKey: rawKey, error: "Public key too short" };
  }

  return { valid: true, publicKey: rawKey };
};

const ContactPicker = ({ contacts, wallet, onClose, onConversationCreated }: ContactPickerProps) => {
  const [isCreating, setIsCreating] = useState<string | null>(null);
  const [isCreatingBot, setIsCreatingBot] = useState(false);
  const [isCreatingNoteToSelf, setIsCreatingNoteToSelf] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualAddress, setManualAddress] = useState("");
  const [manualName, setManualName] = useState("");
  const [isAddingManual, setIsAddingManual] = useState(false);
  const [manualError, setManualError] = useState("");
  const [detectedWallet, setDetectedWallet] = useState<Wallet | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [showScanner, setShowScanner] = useState(false);

  const addressValidation = manualAddress ? parseAddress(manualAddress) : null;

  // Live lookup when address changes
  const handleAddressChange = async (value: string) => {
    setManualAddress(value);
    setDetectedWallet(null);
    setManualError("");

    const parsed = parseAddress(value);
    if (!parsed.valid || parsed.publicKey.length < 100) return;

    // Check if it's own wallet
    if (parsed.publicKey === wallet.signingPublicKey || parsed.publicKey === wallet.encryptionPublicKey) {
      setManualError("Cannot chat with yourself");
      return;
    }

    setIsLookingUp(true);
    try {
      const allWallets = await getWallets();
      const match = allWallets.find(
        w => w.signingPublicKey === parsed.publicKey || 
             w.encryptionPublicKey === parsed.publicKey ||
             w.id === parsed.publicKey
      );
      if (match) {
        setDetectedWallet(match);
      }
    } catch {
      // Ignore lookup errors
    } finally {
      setIsLookingUp(false);
    }
  };

  const handleSelectContact = async (contact: Wallet) => {
    setIsCreating(contact.id);
    try {
      const conversation = await createConversation(wallet.id, contact.id);
      // Add participant info
      conversation.participants = [
        {
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        },
        contact,
      ];
      onConversationCreated(conversation);
    } catch (error) {
      console.error("Failed to create conversation:", error);
    } finally {
      setIsCreating(null);
    }
  };

  const handleStartDemoMode = async () => {
    setIsCreatingBot(true);
    try {
      // Get or create the demo bot
      const botWallet = await getOrCreateDemoBot();
      
      // Create conversation with the bot
      const conversation = await createConversation(wallet.id, botWallet.id);
      conversation.participants = [
        {
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        },
        {
          id: botWallet.id,
          displayName: botWallet.displayName,
          signingPublicKey: botWallet.signingPublicKey,
          encryptionPublicKey: botWallet.encryptionPublicKey,
        },
      ];
      onConversationCreated(conversation);
    } catch (error) {
      console.error("Failed to create demo mode:", error);
    } finally {
      setIsCreatingBot(false);
    }
  };

  const handleNoteToSelf = async () => {
    setIsCreatingNoteToSelf(true);
    try {
      const conversation = await createConversation(wallet.id, wallet.id);
      conversation.participants = [
        {
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        },
      ];
      conversation.name = "Note to Self";
      onConversationCreated(conversation);
    } catch (error) {
      console.error("Failed to create note to self:", error);
    } finally {
      setIsCreatingNoteToSelf(false);
    }
  };

  const handleAddManualContact = async () => {
    if (!detectedWallet) {
      setManualError("Wallet not found on network");
      return;
    }

    setIsAddingManual(true);
    try {
      // Create conversation with the detected wallet
      const conversation = await createConversation(wallet.id, detectedWallet.id);
      conversation.participants = [
        {
          id: wallet.id,
          displayName: wallet.displayName,
          signingPublicKey: wallet.signingPublicKey,
          encryptionPublicKey: wallet.encryptionPublicKey,
        },
        detectedWallet,
      ];
      onConversationCreated(conversation);
    } catch (error) {
      console.error("Failed to create conversation:", error);
      setManualError(error instanceof Error ? error.message : "Failed to create conversation");
    } finally {
      setIsAddingManual(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card rounded-xl border border-border shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold">Start New Chat</h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {/* Demo Mode Button */}
        <div className="p-4 border-b border-border">
          <button
            onClick={handleStartDemoMode}
            disabled={isCreatingBot || isCreating !== null}
            className="w-full p-4 rounded-xl bg-gradient-to-r from-primary/20 to-accent/20 border border-primary/30 hover:border-primary/50 transition-all flex items-center gap-4 disabled:opacity-50"
          >
            <div className="w-12 h-12 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center">
              {isCreatingBot ? (
                <Loader2 className="w-6 h-6 text-primary-foreground animate-spin" />
              ) : (
                <Bot className="w-6 h-6 text-primary-foreground" />
              )}
            </div>
            <div className="flex-1 text-left">
              <div className="flex items-center gap-2">
                <p className="font-semibold text-foreground">🤖 Quantum Bot</p>
                <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  Local AI
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                Test encryption with a local AI bot
              </p>
            </div>
          </button>
        </div>

        {/* Note to Self */}
        <div className="px-4 pb-4">
          <button
            onClick={handleNoteToSelf}
            disabled={isCreatingNoteToSelf || isCreatingBot || isCreating !== null}
            className="w-full p-3 rounded-xl bg-muted/50 border border-border hover:border-primary/50 hover:bg-muted transition-all flex items-center gap-3 disabled:opacity-50"
          >
            <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
              {isCreatingNoteToSelf ? (
                <Loader2 className="w-5 h-5 text-amber-500 animate-spin" />
              ) : (
                <StickyNote className="w-5 h-5 text-amber-500" />
              )}
            </div>
            <div className="flex-1 text-left">
              <p className="font-medium text-foreground">Note to Self</p>
              <p className="text-xs text-muted-foreground">
                Save private notes and reminders
              </p>
            </div>
          </button>
        </div>

        {/* Add by Address */}
        <div className="p-4 border-b border-border">
          {!showManualAdd ? (
            <button
              onClick={() => setShowManualAdd(true)}
              className="w-full p-3 rounded-lg border border-dashed border-border hover:border-primary/50 hover:bg-muted/30 transition-all flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground"
            >
              <UserPlus className="w-4 h-4" />
              <span className="text-sm">Add by public key or xrge: address</span>
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Add Contact Manually</Label>
                <Button variant="ghost" size="sm" onClick={() => setShowManualAdd(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
              
              <div>
                <Label htmlFor="manual-name" className="text-xs text-muted-foreground">Display Name (optional)</Label>
                <Input
                  id="manual-name"
                  value={manualName}
                  onChange={(e) => setManualName(e.target.value)}
                  placeholder="Contact name"
                  className="mt-1"
                />
              </div>

              <div>
                <div className="flex items-center justify-between">
                  <Label htmlFor="manual-address" className="text-xs text-muted-foreground">Public Key or xrge: Address</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowScanner(true)}
                    className="h-6 px-2 text-[10px] gap-1"
                  >
                    <QrCode className="w-3 h-3" />
                    Scan
                  </Button>
                </div>
                <div className="relative mt-1">
                  <Input
                    id="manual-address"
                    value={manualAddress}
                    onChange={(e) => handleAddressChange(e.target.value)}
                    placeholder="xrge:... or paste public key"
                    className={`font-mono text-xs pr-8 ${
                      manualAddress && !addressValidation?.valid ? "border-destructive" : ""
                    } ${manualAddress && addressValidation?.valid ? "border-success" : ""}`}
                  />
                  {manualAddress && (
                    <div className="absolute right-2 top-1/2 -translate-y-1/2">
                      {isLookingUp ? (
                        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                      ) : addressValidation?.valid ? (
                        <CheckCircle2 className="w-4 h-4 text-success" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-destructive" />
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Show detected wallet info */}
              {detectedWallet && (
                <div className="p-2 rounded-lg bg-success/10 border border-success/30 flex items-center gap-2">
                  <User className="w-4 h-4 text-success flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {detectedWallet.displayName || "Unknown"}
                    </p>
                    <p className="text-xs text-muted-foreground">Wallet found on network</p>
                  </div>
                </div>
              )}

              {manualError && (
                <p className="text-xs text-destructive">{manualError}</p>
              )}
              
              {addressValidation?.valid && !detectedWallet && !isLookingUp && !manualError && (
                <p className="text-xs text-amber-500">
                  Wallet not registered yet. They need to open Messenger first.
                </p>
              )}

              <Button
                onClick={handleAddManualContact}
                disabled={isAddingManual || !manualAddress || !addressValidation?.valid || !detectedWallet}
                className="w-full"
                size="sm"
              >
                {isAddingManual ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating chat...
                  </>
                ) : (
                  <>
                    <MessageSquare className="w-4 h-4 mr-2" />
                    Start Chat
                  </>
                )}
              </Button>
            </div>
          )}
        </div>

        {/* Contact list */}
        <div className="max-h-64 overflow-y-auto">
          {/* Filter out current user's wallet from contacts */}
          {(() => {
            const filteredContacts = contacts.filter(contact => 
              contact.id !== wallet.id &&
              contact.signingPublicKey !== wallet.signingPublicKey &&
              contact.encryptionPublicKey !== wallet.encryptionPublicKey
            );
            
            if (filteredContacts.length === 0) {
              return (
                <div className="p-6 text-center text-muted-foreground">
                  <User className="w-10 h-10 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No other users registered yet</p>
                  <p className="text-xs mt-1">Add a contact manually above</p>
                </div>
              );
            }
            
            return (
              <div className="divide-y divide-border">
                {filteredContacts.map((contact) => (
                <button
                  key={contact.id}
                  onClick={() => handleSelectContact(contact)}
                  disabled={isCreating !== null || isCreatingBot}
                  className="w-full p-4 flex items-center gap-3 hover:bg-muted/50 transition-colors disabled:opacity-50"
                >
                  <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                    <User className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 text-left min-w-0">
                    <p className="font-medium text-foreground">
                      {contact.displayName || "Unknown"}
                      {/* Show unique identifier if name is generic */}
                      {(contact.displayName === "My Wallet" || !contact.displayName) && (
                        <span className="text-xs text-muted-foreground ml-2">
                          ({(contact.signingPublicKey || contact.id || "").slice(0, 8)})
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {(contact.signingPublicKey || contact.encryptionPublicKey || contact.id || "").slice(0, 24)}...
                    </p>
                  </div>
                  {isCreating === contact.id ? (
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  ) : (
                    <MessageSquare className="w-5 h-5 text-muted-foreground" />
                  )}
                </button>
              ))}
              </div>
            );
          })()}
        </div>
      </motion.div>

      {/* QR Scanner */}
      <AnimatePresence>
        {showScanner && (
          <PqcQrScanner
            onScan={(publicKey) => {
              handleAddressChange(publicKey);
              setShowScanner(false);
            }}
            onClose={() => setShowScanner(false)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default ContactPicker;

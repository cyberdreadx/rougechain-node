import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { X, ShieldOff, Loader2, AlertCircle, CheckCircle2, Trash2, Download, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { secureUnshield } from "@/lib/secure-api";
import { getActiveNotes, markSpent, importNote, deleteNote, type StoredNote } from "@/lib/note-store";
import { proveUnshield } from "@/lib/stark-prover";

interface UnshieldDialogProps {
  wallet: {
    signingPublicKey: string;
    signingPrivateKey: string;
  };
  onClose: () => void;
  onSuccess: () => void;
}

const UnshieldDialog = ({ wallet, onClose, onSuccess }: UnshieldDialogProps) => {
  const [notes, setNotes] = useState<StoredNote[]>([]);
  const [unshielding, setUnshielding] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState("");
  const [expandedNote, setExpandedNote] = useState<string | null>(null);

  useEffect(() => {
    refreshNotes();
  }, [wallet.signingPublicKey]);

  const refreshNotes = () => {
    setNotes(getActiveNotes(wallet.signingPublicKey));
  };

  const handleUnshield = async (note: StoredNote) => {
    setError("");
    setUnshielding(note.nullifier);

    try {
      const proof = await proveUnshield(note.value);

      const result = await secureUnshield(
        wallet.signingPublicKey,
        wallet.signingPrivateKey,
        [note.nullifier],
        note.value,
        proof
      );

      if (!result.success) {
        throw new Error(result.error || "Unshield failed");
      }

      // Mark note as spent locally
      markSpent(note.nullifier);
      refreshNotes();

      toast.success(`Unshielded ${note.value} XRGE!`, {
        description: "XRGE returned to your public balance"
      });

      // If no more notes, close and refresh
      const remaining = getActiveNotes(wallet.signingPublicKey);
      if (remaining.length === 0) {
        onSuccess();
      }
    } catch (err) {
      console.error("Unshield error:", err);
      setError(err instanceof Error ? err.message : "Unshield failed");
    } finally {
      setUnshielding(null);
    }
  };

  const handleImport = () => {
    setError("");
    try {
      const note = importNote(importJson);
      if (note.ownerPubKey !== wallet.signingPublicKey) {
        deleteNote(note.nullifier);
        setError("This note belongs to a different wallet");
        return;
      }
      setImportJson("");
      setShowImport(false);
      refreshNotes();
      toast.success("Note imported successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid note data");
    }
  };

  const handleDelete = (nullifier: string) => {
    deleteNote(nullifier);
    refreshNotes();
    toast.info("Note removed");
  };

  const truncateHash = (hash: string) =>
    hash.length > 16 ? `${hash.slice(0, 8)}…${hash.slice(-8)}` : hash;

  const totalShielded = notes.reduce((sum, n) => sum + n.value, 0);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={unshielding ? undefined : onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-card rounded-2xl border border-border p-6 shadow-xl max-h-[80vh] flex flex-col"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center">
              <ShieldOff className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-foreground">Unshield XRGE</h2>
              <p className="text-xs text-muted-foreground">
                {totalShielded > 0 ? `${totalShielded} XRGE in ${notes.length} note${notes.length !== 1 ? 's' : ''}` : 'No active notes'}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} disabled={!!unshielding}>
            <X className="w-5 h-5" />
          </Button>
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm mb-3">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Notes list */}
        <div className="flex-1 overflow-y-auto space-y-2 mb-3">
          {notes.length === 0 ? (
            <div className="text-center py-8">
              <ShieldOff className="w-12 h-12 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground mb-1">No shielded notes found</p>
              <p className="text-xs text-muted-foreground">Shield XRGE first, or import a note below</p>
            </div>
          ) : (
            notes.map((note) => (
              <div
                key={note.nullifier}
                className="p-3 rounded-lg bg-muted/50 border border-border"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-lg font-bold text-primary">{note.value} XRGE</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setExpandedNote(expandedNote === note.nullifier ? null : note.nullifier)}
                    >
                      {expandedNote === note.nullifier ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(note.nullifier)}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                <p className="text-[10px] text-muted-foreground">
                  Commitment: {truncateHash(note.commitment)}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  Created: {new Date(note.createdAt).toLocaleString()}
                </p>

                {expandedNote === note.nullifier && (
                  <div className="mt-2 p-2 rounded bg-background/50 text-[9px] font-mono break-all space-y-1">
                    <div><span className="text-muted-foreground">nullifier:</span> {note.nullifier}</div>
                    <div><span className="text-muted-foreground">randomness:</span> {note.randomness}</div>
                    <div><span className="text-muted-foreground">commitment:</span> {note.commitment}</div>
                  </div>
                )}

                <Button
                  size="sm"
                  className="w-full mt-2"
                  onClick={() => handleUnshield(note)}
                  disabled={!!unshielding}
                >
                  {unshielding === note.nullifier ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      Unshielding...
                    </>
                  ) : (
                    <>
                      <ShieldOff className="w-3.5 h-3.5 mr-1.5" />
                      Unshield {note.value} XRGE
                    </>
                  )}
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Import section */}
        <div className="border-t border-border pt-3">
          {showImport ? (
            <div className="space-y-2">
              <Label className="text-xs">Paste note JSON</Label>
              <textarea
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                placeholder='{"commitment":"...","nullifier":"...","value":100,"randomness":"...","ownerPubKey":"..."}'
                className="w-full h-20 px-3 py-2 rounded-lg bg-input border border-border text-xs font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
              />
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setShowImport(false)} className="flex-1">
                  Cancel
                </Button>
                <Button size="sm" onClick={handleImport} disabled={!importJson.trim()} className="flex-1">
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Import
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowImport(true)}
              className="w-full text-xs"
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Import Note from JSON
            </Button>
          )}
        </div>

        <p className="text-xs text-center text-muted-foreground mt-3">
          Unshielding returns XRGE to your public balance
        </p>
      </motion.div>
    </motion.div>
  );
};

export default UnshieldDialog;

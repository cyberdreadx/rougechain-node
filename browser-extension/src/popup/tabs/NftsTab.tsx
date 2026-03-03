import { useState, useEffect, useCallback } from "react";
import { Image, Plus, RefreshCw, Send, Loader2, ArrowLeft, Flame, Lock, Unlock } from "lucide-react";
import type { UnifiedWallet } from "../../lib/unified-wallet";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "../../lib/network";
import {
    getNftOwned,
    getNftCollections,
    invalidateNfts,
    type NftCollection,
    type NftToken,
} from "../../lib/pqc-wallet";

interface Props {
    wallet: UnifiedWallet;
}

type View = "gallery" | "create-collection" | "mint" | "transfer";

export default function NftsTab({ wallet }: Props) {
    const [myNfts, setMyNfts] = useState<NftToken[]>([]);
    const [collections, setCollections] = useState<NftCollection[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [view, setView] = useState<View>("gallery");
    const [result, setResult] = useState<string | null>(null);

    // Create collection state
    const [colSymbol, setColSymbol] = useState("");
    const [colName, setColName] = useState("");
    const [colMaxSupply, setColMaxSupply] = useState("");
    const [colRoyalty, setColRoyalty] = useState("");
    const [colImage, setColImage] = useState("");
    const [colDescription, setColDescription] = useState("");

    // Mint state
    const [mintColId, setMintColId] = useState("");
    const [mintName, setMintName] = useState("");
    const [mintUri, setMintUri] = useState("");

    // Transfer state
    const [transferNft, setTransferNft] = useState<NftToken | null>(null);
    const [transferTo, setTransferTo] = useState("");
    const [transferPrice, setTransferPrice] = useState("");

    const [isSubmitting, setIsSubmitting] = useState(false);

    const baseUrl = getCoreApiBaseUrl();

    const refresh = useCallback(async (showSpinner = true) => {
        if (showSpinner) setIsLoading(true);
        try {
            const [nfts, cols] = await Promise.all([
                getNftOwned(wallet.signingPublicKey),
                getNftCollections(),
            ]);
            setMyNfts(nfts);
            setCollections(cols);
        } catch (err) {
            console.error("NftsTab refresh:", err);
        }
        setIsLoading(false);
    }, [wallet.signingPublicKey]);

    useEffect(() => {
        refresh();
        const interval = setInterval(() => refresh(false), 15_000);
        return () => clearInterval(interval);
    }, [refresh]);

    const showResult = (msg: string, isError = false) => {
        setResult((isError ? "Error: " : "") + msg);
        setTimeout(() => setResult(null), 3000);
    };

    const apiPost = async (endpoint: string, body: Record<string, unknown>) => {
        if (!baseUrl) throw new Error("No node configured");
        const res = await fetch(`${baseUrl}${endpoint}`, {
            method: "POST",
            headers: { ...getCoreApiHeaders(), "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || "Failed");
        invalidateNfts();
        return data;
    };

    const handleCreateCollection = async () => {
        if (!colSymbol || !colName || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await apiPost("/v2/nft/collection/create", {
                payload: {
                    type: "nft_create_collection",
                    from: wallet.signingPublicKey,
                    symbol: colSymbol.toUpperCase(),
                    name: colName,
                    maxSupply: colMaxSupply ? parseInt(colMaxSupply) : undefined,
                    royaltyBps: colRoyalty ? parseInt(colRoyalty) : undefined,
                    image: colImage || undefined,
                    description: colDescription || undefined,
                    fee: 50,
                    timestamp: Date.now(),
                    nonce: crypto.randomUUID(),
                },
                signature: "",
                public_key: wallet.signingPublicKey,
            });
            showResult(`Collection ${colSymbol.toUpperCase()} created`);
            setView("gallery");
            setColSymbol(""); setColName(""); setColMaxSupply(""); setColRoyalty(""); setColImage(""); setColDescription("");
            refresh();
        } catch (err: any) {
            showResult(err.message, true);
        }
        setIsSubmitting(false);
    };

    const handleMint = async () => {
        if (!mintColId || !mintName || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await apiPost("/v2/nft/mint", {
                payload: {
                    type: "nft_mint",
                    from: wallet.signingPublicKey,
                    collectionId: mintColId,
                    name: mintName,
                    metadataUri: mintUri || undefined,
                    fee: 5,
                    timestamp: Date.now(),
                    nonce: crypto.randomUUID(),
                },
                signature: "",
                public_key: wallet.signingPublicKey,
            });
            showResult(`Minted "${mintName}"`);
            setView("gallery");
            setMintName(""); setMintUri("");
            refresh();
        } catch (err: any) {
            showResult(err.message, true);
        }
        setIsSubmitting(false);
    };

    const handleTransfer = async () => {
        if (!transferNft || !transferTo || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await apiPost("/v2/nft/transfer", {
                payload: {
                    type: "nft_transfer",
                    from: wallet.signingPublicKey,
                    collectionId: transferNft.collection_id,
                    tokenId: transferNft.token_id,
                    to: transferTo,
                    salePrice: transferPrice ? parseFloat(transferPrice) : undefined,
                    fee: 1,
                    timestamp: Date.now(),
                    nonce: crypto.randomUUID(),
                },
                signature: "",
                public_key: wallet.signingPublicKey,
            });
            showResult(`Transferred "${transferNft.name}"`);
            setView("gallery");
            setTransferNft(null); setTransferTo(""); setTransferPrice("");
            refresh();
        } catch (err: any) {
            showResult(err.message, true);
        }
        setIsSubmitting(false);
    };

    const handleBurn = async (nft: NftToken) => {
        if (isSubmitting) return;
        if (!confirm(`Burn "${nft.name}" permanently?`)) return;
        setIsSubmitting(true);
        try {
            await apiPost("/v2/nft/burn", {
                payload: {
                    type: "nft_burn",
                    from: wallet.signingPublicKey,
                    collectionId: nft.collection_id,
                    tokenId: nft.token_id,
                    fee: 0.1,
                    timestamp: Date.now(),
                    nonce: crypto.randomUUID(),
                },
                signature: "",
                public_key: wallet.signingPublicKey,
            });
            showResult(`Burned "${nft.name}"`);
            refresh();
        } catch (err: any) {
            showResult(err.message, true);
        }
        setIsSubmitting(false);
    };

    const handleToggleLock = async (nft: NftToken) => {
        if (isSubmitting) return;
        setIsSubmitting(true);
        try {
            await apiPost("/v2/nft/lock", {
                payload: {
                    type: "nft_lock",
                    from: wallet.signingPublicKey,
                    collectionId: nft.collection_id,
                    tokenId: nft.token_id,
                    locked: !nft.locked,
                    fee: 0.1,
                    timestamp: Date.now(),
                    nonce: crypto.randomUUID(),
                },
                signature: "",
                public_key: wallet.signingPublicKey,
            });
            showResult(nft.locked ? "Unlocked" : "Locked");
            refresh();
        } catch (err: any) {
            showResult(err.message, true);
        }
        setIsSubmitting(false);
    };

    if (view === "create-collection") {
        return (
            <div className="flex flex-col h-full overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                    <button onClick={() => setView("gallery")} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
                    <span className="text-sm font-semibold text-foreground">Create Collection</span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <input placeholder="Symbol (e.g. ART)" value={colSymbol} onChange={e => setColSymbol(e.target.value.toUpperCase())} maxLength={10}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <input placeholder="Collection name" value={colName} onChange={e => setColName(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <input placeholder="Description (optional)" value={colDescription} onChange={e => setColDescription(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <input placeholder="Image URL (optional)" value={colImage} onChange={e => setColImage(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <div className="flex gap-2">
                        <input type="number" placeholder="Max supply" value={colMaxSupply} onChange={e => setColMaxSupply(e.target.value)}
                            className="flex-1 px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                        <input type="number" placeholder="Royalty bps (250=2.5%)" value={colRoyalty} onChange={e => setColRoyalty(e.target.value)}
                            className="flex-1 px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    </div>
                    <p className="text-[10px] text-muted-foreground">Fee: 50 XRGE</p>
                    <button onClick={handleCreateCollection} disabled={!colSymbol || !colName || isSubmitting}
                        className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                        {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Create Collection"}
                    </button>
                </div>
            </div>
        );
    }

    if (view === "mint") {
        const myCollections = collections.filter(c => c.creator === wallet.signingPublicKey && !c.frozen);
        return (
            <div className="flex flex-col h-full overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                    <button onClick={() => setView("gallery")} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
                    <span className="text-sm font-semibold text-foreground">Mint NFT</span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <select value={mintColId} onChange={e => setMintColId(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary">
                        <option value="">Select collection...</option>
                        {myCollections.map(c => (
                            <option key={c.collection_id} value={c.collection_id}>{c.symbol} - {c.name} ({c.minted} minted)</option>
                        ))}
                    </select>
                    {myCollections.length === 0 && (
                        <p className="text-[10px] text-muted-foreground">No collections found. Create one first.</p>
                    )}
                    <input placeholder="NFT name (e.g. Piece #1)" value={mintName} onChange={e => setMintName(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <input placeholder="Metadata URI (optional)" value={mintUri} onChange={e => setMintUri(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <p className="text-[10px] text-muted-foreground">Fee: 5 XRGE per mint</p>
                    <button onClick={handleMint} disabled={!mintColId || !mintName || isSubmitting}
                        className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                        {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Mint NFT"}
                    </button>
                </div>
            </div>
        );
    }

    if (view === "transfer" && transferNft) {
        return (
            <div className="flex flex-col h-full overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                    <button onClick={() => { setView("gallery"); setTransferNft(null); }} className="text-muted-foreground hover:text-foreground"><ArrowLeft className="w-4 h-4" /></button>
                    <span className="text-sm font-semibold text-foreground">Transfer NFT</span>
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2">
                    <div className="p-3 rounded-lg bg-secondary/30 border border-border">
                        <p className="text-xs font-medium text-foreground">{transferNft.name}</p>
                        <p className="text-[10px] text-muted-foreground">Collection: {transferNft.collection_id.slice(0, 20)}...</p>
                        <p className="text-[10px] text-muted-foreground">Token ID: {transferNft.token_id}</p>
                    </div>
                    <input placeholder="Recipient public key" value={transferTo} onChange={e => setTransferTo(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <input type="number" placeholder="Sale price in XRGE (optional, triggers royalty)" value={transferPrice} onChange={e => setTransferPrice(e.target.value)}
                        className="w-full px-3 py-2 rounded-lg bg-input border border-border text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                    <p className="text-[10px] text-muted-foreground">Fee: 1 XRGE</p>
                    <button onClick={handleTransfer} disabled={!transferTo || isSubmitting}
                        className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                        {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin mx-auto" /> : "Transfer"}
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <span className="text-sm font-semibold text-foreground">NFTs</span>
                <div className="flex items-center gap-2">
                    <button onClick={() => setView("create-collection")} className="text-primary hover:text-primary/80 text-[10px] font-medium">+ Collection</button>
                    <button onClick={() => setView("mint")} className="text-primary hover:text-primary/80 text-[10px] font-medium">+ Mint</button>
                    <button onClick={() => refresh()} className="text-muted-foreground hover:text-primary">
                        <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                    </button>
                </div>
            </div>

            {result && (
                <div className={`px-4 py-2 text-xs ${result.startsWith("Error") ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success"}`}>
                    {result}
                </div>
            )}

            <div className="flex-1 overflow-y-auto">
                {myNfts.length === 0 ? (
                    <div className="text-center py-10 text-muted-foreground">
                        <Image className="w-10 h-10 mx-auto mb-2 opacity-30" />
                        <p className="text-xs">No NFTs yet</p>
                        <p className="text-[10px] mt-1">Create a collection and mint your first NFT</p>
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-2 p-3">
                        {myNfts.map(nft => (
                            <div key={`${nft.collection_id}-${nft.token_id}`}
                                className="rounded-xl border border-border bg-card/60 overflow-hidden hover:border-primary/30 transition-colors">
                                <div className="aspect-square bg-gradient-to-br from-primary/10 to-secondary/20 flex items-center justify-center">
                                    {nft.metadata_uri ? (
                                        <img src={nft.metadata_uri} alt={nft.name} className="w-full h-full object-cover"
                                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                                    ) : (
                                        <Image className="w-8 h-8 text-muted-foreground/30" />
                                    )}
                                </div>
                                <div className="p-2">
                                    <p className="text-[11px] font-medium text-foreground truncate">{nft.name}</p>
                                    <p className="text-[9px] text-muted-foreground truncate">#{nft.token_id}</p>
                                    <div className="flex gap-1 mt-1.5">
                                        <button onClick={() => { setTransferNft(nft); setView("transfer"); }}
                                            disabled={nft.locked}
                                            className="flex-1 py-1 rounded bg-primary/10 text-primary text-[9px] font-medium hover:bg-primary/20 disabled:opacity-30"
                                            title={nft.locked ? "NFT is locked" : "Transfer"}>
                                            <Send className="w-2.5 h-2.5 mx-auto" />
                                        </button>
                                        <button onClick={() => handleToggleLock(nft)}
                                            className="flex-1 py-1 rounded bg-secondary/50 text-foreground text-[9px] font-medium hover:bg-secondary"
                                            title={nft.locked ? "Unlock" : "Lock"}>
                                            {nft.locked ? <Unlock className="w-2.5 h-2.5 mx-auto" /> : <Lock className="w-2.5 h-2.5 mx-auto" />}
                                        </button>
                                        <button onClick={() => handleBurn(nft)}
                                            className="flex-1 py-1 rounded bg-destructive/10 text-destructive text-[9px] font-medium hover:bg-destructive/20"
                                            title="Burn">
                                            <Flame className="w-2.5 h-2.5 mx-auto" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

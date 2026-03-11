import { useState, useEffect, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Image as ImageIcon,
  Loader2,
  Snowflake,
  Lock,
  ChevronLeft,
  ChevronRight,
  Users,
  Layers,
  Percent,
  Hash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";

interface NFTCollection {
  collection_id: string;
  symbol: string;
  name: string;
  creator: string;
  description: string;
  image: string;
  max_supply: number;
  minted: number;
  royalty_bps: number;
  frozen: boolean;
  created_at: number;
}

interface NFTToken {
  token_id: string;
  name: string;
  owner: string;
  locked?: boolean;
}

const TOKENS_PER_PAGE = 50;

const truncateAddress = (addr: string, left = 10, right = 6) => {
  if (!addr) return "";
  if (addr.length <= left + right + 3) return addr;
  return `${addr.slice(0, left)}...${addr.slice(-right)}`;
};

const NFTExplorer = () => {
  const { collectionId } = useParams<{ collectionId?: string }>();

  if (collectionId) {
    return <CollectionDetail collectionId={collectionId} />;
  }
  return <CollectionsList />;
};

const CollectionsList = () => {
  const [collections, setCollections] = useState<NFTCollection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchCollections = async () => {
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) return;

        const res = await fetch(`${apiBase}/nft/collections`, {
          headers: getCoreApiHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setCollections(data.collections || []);
        }
      } catch (e) {
        console.error("Failed to fetch NFT collections:", e);
        toast.error("Failed to load NFT collections");
      } finally {
        setLoading(false);
      }
    };

    fetchCollections();
  }, []);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-full max-w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6"
        >
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-foreground">NFT Explorer</h1>
            <Badge variant="outline">{getNetworkLabel()}</Badge>
            {!loading && (
              <Badge variant="secondary">{collections.length} collection{collections.length !== 1 ? "s" : ""}</Badge>
            )}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : collections.length === 0 ? (
            <Card className="bg-muted/30">
              <CardContent className="py-12 text-center">
                <ImageIcon className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">No Collections Yet</h3>
                <p className="text-muted-foreground">
                  No NFT collections have been created on the network.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {collections.map((collection) => (
                <Link
                  key={collection.collection_id}
                  to={`/nfts/${collection.collection_id}`}
                  className="block group"
                >
                  <Card className="bg-card/50 backdrop-blur border-border hover:border-primary/50 transition-all duration-200 h-full">
                    <div className="aspect-square relative overflow-hidden rounded-t-lg bg-secondary/30">
                      {collection.image ? (
                        <img
                          src={collection.image}
                          alt={collection.name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon className="w-16 h-16 text-muted-foreground/30" />
                        </div>
                      )}
                      {collection.frozen && (
                        <Badge className="absolute top-2 right-2 bg-blue-500/80 text-white">
                          <Snowflake className="w-3 h-3 mr-1" />
                          Frozen
                        </Badge>
                      )}
                    </div>
                    <CardContent className="p-4 space-y-3">
                      <div>
                        <h3 className="font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                          {collection.name}
                        </h3>
                        <p className="text-sm text-muted-foreground">{collection.symbol}</p>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        <span>Creator: </span>
                        <span className="font-mono text-foreground">
                          {truncateAddress(collection.creator, 8, 4)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between text-sm">
                        <div>
                          <span className="text-muted-foreground">Minted: </span>
                          <span className="font-mono text-primary">
                            {collection.minted}
                          </span>
                          <span className="text-muted-foreground"> / {collection.max_supply}</span>
                        </div>
                        <div className="text-muted-foreground">
                          {(collection.royalty_bps / 100).toFixed(1)}% royalty
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          )}
        </motion.div>
      </main>
    </div>
  );
};

const CollectionDetail = ({ collectionId }: { collectionId: string }) => {
  const [collection, setCollection] = useState<NFTCollection | null>(null);
  const [tokens, setTokens] = useState<NFTToken[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tokensLoading, setTokensLoading] = useState(false);

  const fetchTokens = useCallback(async (currentOffset: number) => {
    setTokensLoading(true);
    try {
      const apiBase = getCoreApiBaseUrl();
      if (!apiBase) return;

      const res = await fetch(
        `${apiBase}/nft/collection/${collectionId}/tokens?limit=${TOKENS_PER_PAGE}&offset=${currentOffset}`,
        { headers: getCoreApiHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        setTokens(data.tokens || []);
        setTotalTokens(data.total || 0);
      }
    } catch (e) {
      console.error("Failed to fetch NFT tokens:", e);
      toast.error("Failed to load NFT tokens");
    } finally {
      setTokensLoading(false);
    }
  }, [collectionId]);

  useEffect(() => {
    const fetchCollection = async () => {
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) return;

        const res = await fetch(`${apiBase}/nft/collection/${collectionId}`, {
          headers: getCoreApiHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setCollection(data);
        }
      } catch (e) {
        console.error("Failed to fetch collection:", e);
        toast.error("Failed to load collection");
      } finally {
        setLoading(false);
      }
    };

    fetchCollection();
    fetchTokens(0);
  }, [collectionId, fetchTokens]);

  const handlePageChange = (newOffset: number) => {
    setOffset(newOffset);
    fetchTokens(newOffset);
  };

  const totalPages = Math.ceil(totalTokens / TOKENS_PER_PAGE);
  const currentPage = Math.floor(offset / TOKENS_PER_PAGE) + 1;

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!collection) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <ImageIcon className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-muted-foreground">Collection not found</p>
          <Button asChild variant="outline" className="mt-4">
            <Link to="/nfts">Back to Collections</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] md:min-h-screen bg-background relative overflow-x-hidden">
      <div className="fixed inset-0 circuit-bg opacity-20 pointer-events-none" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-[800px] h-[800px] bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-0 right-0 w-full max-w-[600px] h-[600px] bg-accent/5 rounded-full blur-3xl pointer-events-none" />

      <main className="relative z-10 max-w-6xl mx-auto px-4 py-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-6"
        >
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon">
              <Link to="/nfts">
                <ArrowLeft className="w-5 h-5" />
              </Link>
            </Button>
            <h1 className="text-2xl font-bold text-foreground">{collection.name}</h1>
            <Badge variant="outline">{collection.symbol}</Badge>
          </div>

          <Card className="bg-card/50 backdrop-blur border-border overflow-hidden">
            <div className="flex flex-col sm:flex-row gap-6 p-6">
              <div className="w-full sm:w-48 h-48 rounded-lg bg-secondary/30 overflow-hidden flex-shrink-0">
                {collection.image ? (
                  <img
                    src={collection.image}
                    alt={collection.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ImageIcon className="w-16 h-16 text-muted-foreground/30" />
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <h2 className="text-xl font-bold">{collection.name}</h2>
                  <p className="text-sm text-muted-foreground">{collection.symbol}</p>
                </div>
                {collection.description && (
                  <p className="text-sm text-muted-foreground">{collection.description}</p>
                )}
                {collection.frozen && (
                  <Badge className="bg-blue-500/20 text-blue-400">
                    <Snowflake className="w-3 h-3 mr-1" />
                    Frozen
                  </Badge>
                )}
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-5 gap-4">
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Layers className="w-4 h-4" />
                  <span className="text-xs">Minted</span>
                </div>
                <p className="text-lg font-mono font-semibold text-primary">{collection.minted}</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Hash className="w-4 h-4" />
                  <span className="text-xs">Max Supply</span>
                </div>
                <p className="text-lg font-mono font-semibold">{collection.max_supply}</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Percent className="w-4 h-4" />
                  <span className="text-xs">Royalty</span>
                </div>
                <p className="text-lg font-mono font-semibold">{(collection.royalty_bps / 100).toFixed(1)}%</p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Users className="w-4 h-4" />
                  <span className="text-xs">Creator</span>
                </div>
                <Link
                  to={`/address/${collection.creator}`}
                  className="text-sm font-mono text-primary hover:underline truncate block"
                >
                  {truncateAddress(collection.creator, 8, 4)}
                </Link>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Snowflake className="w-4 h-4" />
                  <span className="text-xs">Status</span>
                </div>
                <p className="text-lg font-semibold">
                  {collection.frozen ? (
                    <span className="text-blue-400">Frozen</span>
                  ) : (
                    <span className="text-green-400">Active</span>
                  )}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Layers className="w-4 h-4" />
                  NFTs
                  {totalTokens > 0 && (
                    <Badge variant="secondary">{totalTokens}</Badge>
                  )}
                </div>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tokensLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-primary" />
                </div>
              ) : tokens.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <ImageIcon className="w-10 h-10 mx-auto mb-3 opacity-50" />
                  <p>No NFTs minted in this collection yet.</p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {tokens.map((token) => (
                      <div
                        key={token.token_id}
                        className="rounded-lg border border-border bg-background/60 p-3 space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-primary font-mono">
                            #{token.token_id}
                          </span>
                          {token.locked && (
                            <Badge variant="secondary" className="text-xs">
                              <Lock className="w-3 h-3 mr-1" />
                              Locked
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm font-medium truncate">{token.name}</p>
                        <div className="text-xs text-muted-foreground">
                          <span>Owner: </span>
                          <Link
                            to={`/address/${token.owner}`}
                            className="font-mono text-primary hover:underline"
                          >
                            {truncateAddress(token.owner, 8, 4)}
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-between pt-6 border-t border-border mt-6">
                      <div className="text-sm text-muted-foreground">
                        Showing {offset + 1}-{Math.min(offset + TOKENS_PER_PAGE, totalTokens)} of {totalTokens}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePageChange(Math.max(0, offset - TOKENS_PER_PAGE))}
                          disabled={offset === 0}
                        >
                          <ChevronLeft className="w-4 h-4" />
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          Page {currentPage} of {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handlePageChange(offset + TOKENS_PER_PAGE)}
                          disabled={currentPage >= totalPages}
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  );
};

export default NFTExplorer;

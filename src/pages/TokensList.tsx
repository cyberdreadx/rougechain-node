import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Coins,
  Loader2,
  Search,
  Globe,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { getCoreApiBaseUrl, getCoreApiHeaders, getNetworkLabel } from "@/lib/network";
import { RougeAddressLink } from "@/components/RougeAddressLink";

const DiscordLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

interface TokenInfo {
  symbol: string;
  name: string;
  creator: string;
  image?: string;
  description?: string;
  website?: string;
  twitter?: string;
  discord?: string;
  created_at: number;
}



const truncateText = (text: string, maxLen: number) => {
  if (!text || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
};

const TokensList = () => {
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const fetchTokens = async () => {
      try {
        const apiBase = getCoreApiBaseUrl();
        if (!apiBase) return;

        const res = await fetch(`${apiBase}/tokens`, {
          headers: getCoreApiHeaders(),
        });
        if (res.ok) {
          const data = await res.json();
          setTokens(data.tokens || []);
        }
      } catch (e) {
        console.error("Failed to fetch tokens:", e);
        toast.error("Failed to load tokens");
      } finally {
        setLoading(false);
      }
    };

    fetchTokens();
  }, []);

  const filteredTokens = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.creator.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
    );
  }, [query, tokens]);

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
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">All Tokens</h1>
              <Badge variant="outline">{getNetworkLabel()}</Badge>
              {!loading && (
                <Badge variant="secondary">{tokens.length} token{tokens.length !== 1 ? "s" : ""}</Badge>
              )}
            </div>
            <div className="relative md:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, symbol..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : filteredTokens.length === 0 ? (
            <Card className="bg-muted/30">
              <CardContent className="py-12 text-center">
                <Coins className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium mb-2">
                  {query ? "No Matches" : "No Tokens Yet"}
                </h3>
                <p className="text-muted-foreground">
                  {query
                    ? "No tokens match your search criteria."
                    : "No tokens have been created on the network."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Desktop table */}
              <Card className="hidden md:block">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Coins className="w-4 h-4" />
                    Tokens
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-xs text-muted-foreground border-b border-border">
                        <tr>
                          <th className="text-left py-2 px-2 font-medium">Token</th>
                          <th className="text-left py-2 px-2 font-medium">Creator</th>
                          <th className="text-left py-2 px-2 font-medium">Description</th>
                          <th className="text-left py-2 px-2 font-medium">Created</th>
                          <th className="text-center py-2 px-2 font-medium">Links</th>
                          <th className="text-right py-2 px-2 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {filteredTokens.map((token) => (
                          <tr
                            key={token.symbol}
                            className="hover:bg-secondary/40 transition-colors"
                          >
                            <td className="py-3 px-2">
                              <div className="flex items-center gap-3">
                                {token.image ? (
                                  <img
                                    src={token.image}
                                    alt={token.symbol}
                                    className="w-8 h-8 rounded-full object-cover bg-secondary flex-shrink-0"
                                  />
                                ) : (
                                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                                    <Coins className="w-4 h-4 text-muted-foreground" />
                                  </div>
                                )}
                                <div className="min-w-0">
                                  <Link
                                    to={`/token/${token.symbol}`}
                                    className="font-medium text-foreground hover:text-primary transition-colors"
                                  >
                                    {token.name}
                                  </Link>
                                  <p className="text-xs text-muted-foreground">{token.symbol}</p>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-2">
                              <RougeAddressLink pubkey={token.creator} className="text-xs" />
                            </td>
                            <td className="py-3 px-2 text-muted-foreground text-xs max-w-[200px]">
                              {truncateText(token.description || "", 60)}
                            </td>
                            <td className="py-3 px-2 text-muted-foreground text-xs whitespace-nowrap">
                              {new Date(token.created_at).toLocaleDateString()}
                            </td>
                            <td className="py-3 px-2">
                              <div className="flex items-center justify-center gap-2">
                                {token.website && (
                                  <a
                                    href={token.website}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-muted-foreground hover:text-primary transition-colors"
                                  >
                                    <Globe className="w-4 h-4" />
                                  </a>
                                )}
                                {token.twitter && (
                                  <a
                                    href={`https://x.com/${token.twitter.replace("@", "")}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-muted-foreground hover:text-primary transition-colors"
                                  >
                                    <XLogo className="w-4 h-4" />
                                  </a>
                                )}
                                {token.discord && (
                                  <a
                                    href={
                                      token.discord.startsWith("http")
                                        ? token.discord
                                        : `https://discord.gg/${token.discord}`
                                    }
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-muted-foreground hover:text-primary transition-colors"
                                  >
                                    <DiscordLogo className="w-4 h-4" />
                                  </a>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-2 text-right">
                              <Button asChild variant="outline" size="sm">
                                <Link to={`/token/${token.symbol}`}>
                                  <ExternalLink className="w-3 h-3 mr-1" />
                                  View
                                </Link>
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Mobile cards */}
              <div className="md:hidden space-y-4">
                {filteredTokens.map((token) => (
                  <Card
                    key={token.symbol}
                    className="bg-card/50 backdrop-blur border-border"
                  >
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center gap-3">
                        {token.image ? (
                          <img
                            src={token.image}
                            alt={token.symbol}
                            className="w-10 h-10 rounded-full object-cover bg-secondary flex-shrink-0"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center flex-shrink-0">
                            <Coins className="w-5 h-5 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <Link
                            to={`/token/${token.symbol}`}
                            className="font-medium text-foreground hover:text-primary transition-colors"
                          >
                            {token.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">{token.symbol}</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {token.website && (
                            <a
                              href={token.website}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              <Globe className="w-4 h-4" />
                            </a>
                          )}
                          {token.twitter && (
                            <a
                              href={`https://x.com/${token.twitter.replace("@", "")}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              <XLogo className="w-4 h-4" />
                            </a>
                          )}
                          {token.discord && (
                            <a
                              href={
                                token.discord.startsWith("http")
                                  ? token.discord
                                  : `https://discord.gg/${token.discord}`
                              }
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-muted-foreground hover:text-primary transition-colors"
                            >
                              <DiscordLogo className="w-4 h-4" />
                            </a>
                          )}
                        </div>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        <span>Creator: </span>
                        <RougeAddressLink pubkey={token.creator} />
                      </div>

                      {token.description && (
                        <p className="text-xs text-muted-foreground">
                          {truncateText(token.description, 100)}
                        </p>
                      )}

                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">
                          {new Date(token.created_at).toLocaleDateString()}
                        </span>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/token/${token.symbol}`}>
                            <ExternalLink className="w-3 h-3 mr-1" />
                            View
                          </Link>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          )}
        </motion.div>
      </main>
    </div>
  );
};

export default TokensList;

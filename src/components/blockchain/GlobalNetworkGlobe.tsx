import { useRef, useMemo, useState, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html, useTexture } from "@react-three/drei";
import * as THREE from "three";
import { motion } from "framer-motion";
import { Globe, Activity, Users, Loader2, Wifi, Shield } from "lucide-react";
import { getCoreApiBaseUrl, getCoreApiHeaders } from "@/lib/network";

// Generate random points on a sphere based on validator count
const generateNodePositions = (count: number, radius: number) => {
  const positions: [number, number, number][] = [];
  for (let i = 0; i < count; i++) {
    const phi = Math.acos(-1 + (2 * i) / count);
    const theta = Math.sqrt(count * Math.PI) * phi;
    positions.push([
      radius * Math.cos(theta) * Math.sin(phi),
      radius * Math.sin(theta) * Math.sin(phi),
      radius * Math.cos(phi),
    ]);
  }
  return positions;
};

// Generate connections between nodes (stable + ensures minimum links)
const generateConnections = (
  nodes: [number, number, number][],
  connectionProbability: number = 0.12
) => {
  const connections: [[number, number, number], [number, number, number]][] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    connections.push([nodes[a], nodes[b]]);
  };
  const total = nodes.length;
  if (total < 2) return connections;
  for (let i = 0; i < total; i++) {
    add(i, (i + 1) % total);
    if (total > 3) {
      add(i, (i + 2) % total);
    }
  }
  let seed = total * 9301 + 49297;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < total; i++) {
    for (let j = i + 1; j < total; j++) {
      if (rand() < connectionProbability) {
        add(i, j);
      }
    }
  }
  return connections;
};

interface NodeProps {
  position: [number, number, number];
  isValidator?: boolean;
  name?: string;
}

const Node = ({ position, isValidator = false, name }: NodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const phase = useMemo(() => position[0] * 3.7 + position[1] * 2.3, [position]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const pulse = 1 + Math.sin(t * 3 + phase) * 0.15;
    if (meshRef.current) {
      meshRef.current.scale.setScalar(pulse);
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(pulse * 1.4);
      (glowRef.current.material as THREE.MeshBasicMaterial).opacity =
        0.35 + Math.sin(t * 4 + phase) * 0.1;
    }
  });

  const coreColor = isValidator ? "#ff2244" : "#cc44ff";
  const glowColor = isValidator ? "#ff4466" : "#dd66ff";
  const label = name || (isValidator ? "L1 Validator" : "Network Peer");
  // Small, tight sizes — validators slightly larger
  const size = isValidator ? 0.04 : 0.025;

  return (
    <group position={position}>
      {/* Tight glow — just slightly larger than core */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[size * 1.8, 12, 12]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.35} />
      </mesh>

      {/* Bright core — small, high emissive */}
      <mesh
        ref={meshRef}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <sphereGeometry args={[size, 16, 16]} />
        <meshBasicMaterial color={hovered ? "#ffffff" : coreColor} />
      </mesh>

      {hovered && (
        <Html distanceFactor={10}>
          <div className="bg-black/95 backdrop-blur-md border border-red-500/60 rounded-lg px-3 py-1.5 text-xs whitespace-nowrap shadow-xl shadow-red-500/30">
            <span className="text-red-300 font-bold">{label}</span>
            {name && (
              <span className="text-red-400/50 ml-2 text-[10px] uppercase tracking-wider">
                {isValidator ? "validator" : "peer"}
              </span>
            )}
          </div>
        </Html>
      )}
    </group>
  );
};

interface ConnectionLineProps {
  start: [number, number, number];
  end: [number, number, number];
  index: number;
}

// Lightweight single-dot particle for connections
const LightParticle = ({ curve, speed, offset, color }: {
  curve: THREE.QuadraticBezierCurve3;
  speed: number;
  offset: number;
  color: string;
}) => {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (!ref.current) return;
    const t = ((state.clock.elapsedTime * speed + offset) % 1);
    const pos = curve.getPoint(t);
    ref.current.position.copy(pos);
    const fade = Math.sin(t * Math.PI);
    ref.current.scale.setScalar(fade);
    (ref.current.material as THREE.MeshBasicMaterial).opacity = fade * 0.9;
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.018, 6, 6]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} />
    </mesh>
  );
};

// Connection line with single traveling dot
const ConnectionLine = ({ start, end, index }: ConnectionLineProps) => {
  const { curve, points } = useMemo(() => {
    const startVec = new THREE.Vector3(...start);
    const endVec = new THREE.Vector3(...end);
    const mid = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
    const distance = startVec.distanceTo(endVec);
    mid.normalize().multiplyScalar(2 + 0.3 + distance * 0.15);
    const curve = new THREE.QuadraticBezierCurve3(startVec, mid, endVec);
    const points = curve.getPoints(20);
    return { curve, points };
  }, [start, end]);

  const geometry = useMemo(() => new THREE.BufferGeometry().setFromPoints(points), [points]);
  const speed = 0.2 + (index % 5) * 0.04;
  const offset = (index * 0.17) % 1;

  return (
    <group>
      {/* @ts-ignore - R3F line element */}
      <line geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial color="#ff3355" transparent opacity={0.4} />
      </line>
      <LightParticle curve={curve} speed={speed} offset={offset} color="#ff1744" />
    </group>
  );
};

const GlobeWireframe = () => {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (meshRef.current) meshRef.current.rotation.y += 0.0008;
  });

  return (
    <group>
      <mesh ref={meshRef}>
        <sphereGeometry args={[1.96, 32, 32]} />
        <meshBasicMaterial color="#ff2244" wireframe transparent opacity={0.08} />
      </mesh>
      <mesh>
        <sphereGeometry args={[2.05, 24, 24]} />
        <meshBasicMaterial color="#ff1744" transparent opacity={0.04} side={THREE.BackSide} />
      </mesh>
    </group>
  );
};

const EARTH_TEXTURE_URL =
  "https://threejs.org/examples/textures/land_ocean_ice_cloud_2048.jpg";

const EarthSurface = () => {
  const texture = useTexture(EARTH_TEXTURE_URL);
  useEffect(() => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
  }, [texture]);
  return (
    <mesh>
      <sphereGeometry args={[1.9, 48, 48]} />
      <meshStandardMaterial map={texture} roughness={0.9} metalness={0.05} />
    </mesh>
  );
};

const RotatingGroup = ({ children }: { children: React.ReactNode }) => {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (groupRef.current) {
      groupRef.current.rotation.y += 0.002;
    }
  });

  return <group ref={groupRef}>{children}</group>;
};

interface NetworkSceneProps {
  nodeCount: number;
  peerCount: number;
  nodeNames?: string[];
}

const NetworkScene = ({ nodeCount, peerCount, nodeNames = [] }: NetworkSceneProps) => {
  const rawTotal = Math.max(nodeCount + peerCount, 3);
  // Lock in the max node count so positions never reset on poll fluctuations
  const stableCountRef = useRef(rawTotal);
  if (rawTotal > stableCountRef.current) {
    stableCountRef.current = rawTotal;
  }
  const totalNodes = stableCountRef.current;
  const nodes = useMemo(() => generateNodePositions(totalNodes, 2), [totalNodes]);
  const connections = useMemo(() => generateConnections(nodes, 0.12), [nodes]);

  return (
    <>
      {/* Dark cyberpunk lighting */}
      <ambientLight intensity={0.15} />
      <pointLight position={[10, 10, 10]} intensity={0.4} color="#ffffff" />
      <pointLight position={[-10, -10, -10]} intensity={0.5} color="#ff1744" />
      <pointLight position={[0, 10, -10]} intensity={0.3} color="#d500f9" />

      <EarthSurface />
      <GlobeWireframe />

      <RotatingGroup>
        {nodes.map((pos, i) => (
          <Node
            key={i}
            position={pos}
            isValidator={i < nodeCount}
            name={nodeNames[i]}
          />
        ))}

        {connections.map((conn, i) => (
          <ConnectionLine
            key={i}
            index={i}
            start={conn[0]}
            end={conn[1]}
          />
        ))}
      </RotatingGroup>

      <OrbitControls
        enableZoom={true}
        enablePan={false}
        minDistance={3}
        maxDistance={8}
        autoRotate={false}
      />
    </>
  );
};

interface GlobalNetworkGlobeProps {
  className?: string;
}

interface NodeStats {
  connected_peers: number;
  network_height: number;
  is_mining: boolean;
  node_id: string;
  node_name?: string;
}

interface PeerDetail {
  url: string;
  node_name?: string;
}

const normalizeStats = (data: Record<string, unknown>): NodeStats => ({
  connected_peers: Number(data.connected_peers ?? data.connectedPeers ?? 0),
  network_height: Number(data.network_height ?? data.networkHeight ?? 0),
  is_mining: Boolean(data.is_mining ?? data.isMining ?? false),
  node_id: String(data.node_id ?? data.nodeId ?? ""),
  node_name: (data.node_name ?? data.nodeName) as string | undefined,
});

const GlobalNetworkGlobe = ({ className = "" }: GlobalNetworkGlobeProps) => {
  const [nodeStats, setNodeStats] = useState<NodeStats[]>([]);
  const [peerDetails, setPeerDetails] = useState<PeerDetail[]>([]);
  const [validatorCount, setValidatorCount] = useState(0);
  const [validatorKeys, setValidatorKeys] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLive, setIsLive] = useState(false);
  const [isWebglLost, setIsWebglLost] = useState(false);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchNodes = async () => {
      try {
        setIsLoading(true);
        const stats: NodeStats[] = [];
        const configuredBase = getCoreApiBaseUrl();
        const configuredUrl = configuredBase ? configuredBase.replace(/\/api$/, "") : "";
        const apiBases = [
          configuredUrl,
        ].filter(Boolean);

        const targets = apiBases.map((base) => `${base}/api/stats`);

        for (const url of targets) {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(5000),
              headers: getCoreApiHeaders(),
            });
            if (res.ok) {
              const data = await res.json() as Record<string, unknown>;
              stats.push(normalizeStats(data));
            }
          } catch {
            // Ignore unreachable targets
          }
        }
        if (!cancelled) {
          setNodeStats(stats);
          setIsLive(stats.length > 0);
        }

        // Also fetch peer details for names + check their mining status
        let discoveredPeerUrls: string[] = [];
        try {
          const peersUrl = configuredUrl ? `${configuredUrl}/api/peers` : "";
          if (peersUrl) {
            const peersRes = await fetch(peersUrl, {
              signal: AbortSignal.timeout(5000),
              headers: getCoreApiHeaders(),
            });
            if (peersRes.ok) {
              const peersData = await peersRes.json() as { peers?: string[]; peer_details?: PeerDetail[]; peerDetails?: PeerDetail[] };
              const details = peersData.peer_details ?? peersData.peerDetails ?? [];
              if (!cancelled) setPeerDetails(details);
              // Collect peer URLs for stats check
              if (peersData.peers) {
                discoveredPeerUrls = peersData.peers
                  .map(u => u.replace(/\/+$/, "").replace(/\/api$/, ""))
                  .filter(u => !u.includes("127.0.0.1") && !u.includes("localhost"));
              }
            }
          }
        } catch { /* ignore */ }

        // Query each peer's stats to get accurate mining count + discover names
        const updatedDetails = [...(peerDetails ?? [])];
        for (const peerBase of discoveredPeerUrls) {
          try {
            const peerStatsRes = await fetch(`${peerBase}/api/stats`, {
              signal: AbortSignal.timeout(3000),
              headers: getCoreApiHeaders(),
            });
            if (peerStatsRes.ok) {
              const peerData = await peerStatsRes.json() as Record<string, unknown>;
              const peerStat = normalizeStats(peerData);
              // Avoid duplicates by node_id
              if (!stats.some(s => s.node_id && s.node_id === peerStat.node_id)) {
                stats.push(peerStat);
              }
              // Back-fill peer name from stats into peer_details
              const peerName = (peerData.node_name ?? peerData.nodeName) as string | undefined;
              if (peerName) {
                const peerApiUrl = `${peerBase}/api`;
                const match = updatedDetails.find(d => d.url === peerApiUrl || d.url === peerBase);
                if (match && !match.node_name) {
                  match.node_name = peerName;
                } else if (!match) {
                  updatedDetails.push({ url: peerApiUrl, node_name: peerName });
                }
              }
            }
          } catch { /* peer unreachable */ }
        }
        if (!cancelled) {
          setNodeStats([...stats]);
          setPeerDetails(updatedDetails);
        }

        // Fetch validator count from /api/validators
        try {
          const valUrl = configuredUrl ? `${configuredUrl}/api/validators` : "";
          if (valUrl) {
            const valRes = await fetch(valUrl, {
              signal: AbortSignal.timeout(5000),
              headers: getCoreApiHeaders(),
            });
            if (valRes.ok) {
              const valData = await valRes.json() as { validators?: { publicKey?: string; public_key?: string; name?: string }[] };
              if (!cancelled && valData.validators) {
                setValidatorCount(valData.validators.length);
                setValidatorKeys(valData.validators.map(v => {
                  // Use name if available, otherwise truncated key
                  if (v.name) return v.name;
                  const key = v.publicKey || v.public_key || "";
                  return key ? `${key.slice(0, 6)}...${key.slice(-4)}` : "";
                }));
              }
            }
          }
        } catch { /* ignore */ }
      } catch (error) {
        console.error("Failed to fetch nodes:", error);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    fetchNodes();
    const interval = setInterval(fetchNodes, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!canvasEl) return;
    const handleLost = (event: Event) => {
      event.preventDefault();
      setIsWebglLost(true);
    };
    const handleRestored = () => {
      setIsWebglLost(false);
    };
    canvasEl.addEventListener("webglcontextlost", handleLost);
    canvasEl.addEventListener("webglcontextrestored", handleRestored);
    return () => {
      canvasEl.removeEventListener("webglcontextlost", handleLost);
      canvasEl.removeEventListener("webglcontextrestored", handleRestored);
    };
  }, [canvasEl]);

  // Use unique peer count from peer_details to avoid double-counting
  const totalPeers = peerDetails.length > 0
    ? peerDetails.length
    : (nodeStats.length > 0 ? nodeStats[0].connected_peers : 0);
  const activeNodes = nodeStats.length;
  // Use validator count from API if available, otherwise fall back to connected stats
  const displayNodes = validatorCount > 0 ? validatorCount : (activeNodes > 0 ? activeNodes : 1);
  const displayPeers = totalPeers;

  // Build names list: validator names first, then peer names
  const nodeNames = useMemo(() => {
    const names: string[] = [];

    // Build a name lookup from all available sources
    const nameMap = new Map<string, string>();
    // From nodeStats (our connected nodes' /api/stats responses)
    for (const s of nodeStats) {
      if (s.node_name && s.node_id) nameMap.set(s.node_id, s.node_name);
    }
    // From peer_details (daemon peer names)
    for (const pd of peerDetails) {
      if (pd.node_name && pd.url) nameMap.set(pd.url, pd.node_name);
    }



    // Use validator keys (from /api/validators) as names for validator dots
    // Each validatorKeys entry is either a real name (e.g. "rouge-prime") or
    // a truncated pubkey (e.g. "9c88d3...3e22") from the API response
    const usedStatsNames = new Set<string>();
    if (validatorKeys.length > 0) {
      for (const key of validatorKeys) {
        // A truncated pubkey contains "..." and is hex-like around it
        const isTruncatedPubkey = key.includes("...");
        if (key && !isTruncatedPubkey) {
          // It's a real name from the API (e.g. "rouge-prime") — use it
          names.push(key);
        } else if (key && isTruncatedPubkey) {
          // It's a truncated pubkey — try to find a better name from stats/peers
          let resolvedName = "";
          for (const s of nodeStats) {
            if (s.node_name && !usedStatsNames.has(s.node_name)) {
              resolvedName = s.node_name;
              usedStatsNames.add(resolvedName);
              break;
            }
          }
          names.push(resolvedName || `Validator ${key}`);
        } else {
          names.push("");
        }
      }
    } else {
      // Fallback: use node stats names
      for (const s of nodeStats) {
        names.push(s.node_name || "");
      }
    }
    // Ensure at least displayNodes entries for validators
    while (names.length < displayNodes) names.push("");

    // Peer names: prefer peer_details, fill gaps from nodeStats
    const usedNames = new Set(names.filter(Boolean));
    for (const pd of peerDetails) {
      const n = pd.node_name || "";
      names.push(n);
      if (n) usedNames.add(n);
    }

    // If we have more peers than peerDetails entries, fill from nodeStats names
    const peerCount = totalPeers;
    while (names.length < displayNodes + peerCount) {
      // Try to find an unused name from nodeStats
      let found = "";
      for (const s of nodeStats) {
        if (s.node_name && !usedNames.has(s.node_name)) {
          found = s.node_name;
          usedNames.add(found);
          break;
        }
      }
      names.push(found);
    }

    return names;
  }, [nodeStats, peerDetails, displayNodes, validatorKeys, totalPeers]);

  return (
    <div className={`relative ${className}`}>
      {/* 3D Canvas - behind everything */}
      <div className="absolute inset-0 bg-gradient-to-b from-black via-zinc-950 to-black rounded-xl border border-red-500/20 overflow-hidden shadow-2xl shadow-red-500/5">
        {isWebglLost ? (
          <div className="w-full h-full flex items-center justify-center text-center px-6">
            <div>
              <Shield className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">3D view paused to save resources.</p>
              <p className="text-xs text-muted-foreground/70">Refresh the page to restore.</p>
            </div>
          </div>
        ) : (
          <Canvas
            camera={{ position: [0, 0, 5], fov: 50 }}
            dpr={[1, 1.25]}
            gl={{ antialias: false, powerPreference: "low-power" }}
            onCreated={(state) => {
              setCanvasEl(state.gl.domElement);
            }}
          >
            <NetworkScene nodeCount={displayNodes} peerCount={displayPeers} nodeNames={nodeNames} />
          </Canvas>
        )}
      </div>

      {/* Header - top left */}
      <div className="absolute top-4 left-4 z-20 pointer-events-none">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="w-5 h-5 text-red-500" />
          <h3 className="text-sm font-bold text-white tracking-wide">GLOBAL NETWORK</h3>
          {isLive && (
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-red-500/20 border border-red-500/40">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[10px] text-red-400 font-mono font-bold tracking-wider">LIVE</span>
            </div>
          )}
        </div>
        <p className="text-xs text-red-400/60 max-w-[200px] font-mono">
          RougeChain P2P Network
        </p>
      </div>

      {/* Node & Peer List - bottom left */}
      <div className="absolute bottom-4 left-4 z-20 pointer-events-auto max-w-[220px]">
        <div className="bg-black/80 backdrop-blur-md border border-red-500/20 rounded-lg px-3 py-2.5 shadow-lg">
          <p className="text-[10px] text-red-400/60 uppercase tracking-wider font-mono mb-2">Active Nodes</p>
          <div className="max-h-[120px] overflow-y-auto space-y-1.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-red-500/20">
            {/* Validators */}
            {Array.from({ length: displayNodes }).map((_, i) => {
              const name = nodeNames[i] || `Validator ${i + 1}`;
              const isMining = nodeStats[i]?.is_mining;
              return (
                <div key={`v-${i}`} className="flex items-center gap-2 text-[11px]">
                  <div className="w-2 h-2 rounded-full bg-[#ff1744] shrink-0 shadow-sm shadow-red-500/50" />
                  <span className="text-red-300/80 truncate font-mono">{name}</span>
                  {isMining && (
                    <span className="text-[9px] text-amber-400/70 ml-auto shrink-0">⛏</span>
                  )}
                </div>
              );
            })}
            {/* Peers */}
            {Array.from({ length: displayPeers }).map((_, i) => {
              const peerIdx = displayNodes + i;
              const name = nodeNames[peerIdx] || peerDetails[i]?.node_name || `Peer ${i + 1}`;
              return (
                <div key={`p-${i}`} className="flex items-center gap-2 text-[11px]">
                  <div className="w-2 h-2 rounded-full bg-[#d500f9] shrink-0 shadow-sm shadow-fuchsia-500/50" />
                  <span className="text-fuchsia-300/80 truncate font-mono">{name}</span>
                </div>
              );
            })}
          </div>
          {/* Color legend */}
          <div className="flex items-center gap-4 mt-2 pt-2 border-t border-red-500/10">
            <div className="flex items-center gap-1.5 text-[10px]">
              <div className="w-2 h-2 rounded-full bg-[#ff1744]" />
              <span className="text-red-400/60">Validator</span>
            </div>
            <div className="flex items-center gap-1.5 text-[10px]">
              <div className="w-2 h-2 rounded-full bg-[#d500f9]" />
              <span className="text-fuchsia-400/60">Peer</span>
            </div>
          </div>
        </div>
      </div>

      {/* Stats - top right */}
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        className="absolute top-4 right-4 z-20 pointer-events-none flex flex-col gap-2"
      >
        <div className="bg-black/80 backdrop-blur-md border border-red-500/30 rounded-lg px-3 py-2 flex items-center gap-3 shadow-lg shadow-red-500/10">
          <Users className="w-4 h-4 text-red-400 shrink-0" />
          <div className="text-right">
            <p className="text-[10px] text-red-400/60 uppercase tracking-wider font-mono">Nodes</p>
            <p className="text-lg font-bold text-red-400 leading-none font-mono">
              {isLoading ? "..." : displayNodes}
            </p>
          </div>
        </div>
        <div className="bg-black/80 backdrop-blur-md border border-fuchsia-500/30 rounded-lg px-3 py-2 flex items-center gap-3 shadow-lg shadow-fuchsia-500/10">
          <Activity className="w-4 h-4 text-fuchsia-400 shrink-0" />
          <div className="text-right">
            <p className="text-[10px] text-fuchsia-400/60 uppercase tracking-wider font-mono">Peers</p>
            <p className="text-lg font-bold text-fuchsia-400 leading-none font-mono">
              {isLoading ? "..." : displayPeers}
            </p>
          </div>
        </div>
        {nodeStats.length > 0 && (
          <div className="bg-black/80 backdrop-blur-md border border-amber-500/30 rounded-lg px-3 py-2 shadow-lg shadow-amber-500/10">
            <p className="text-[10px] text-amber-400/60 uppercase tracking-wider font-mono">Mining</p>
            <p className="text-lg font-bold text-amber-400 leading-none font-mono">
              {nodeStats.filter(s => s.is_mining).length} / {displayNodes}
            </p>
          </div>
        )}
      </motion.div>

      {/* Bottom right hint */}
      <div className="absolute bottom-4 right-4 z-20 pointer-events-none">
        <p className="text-[10px] text-red-400/40 bg-black/60 backdrop-blur-sm px-2 py-1 rounded border border-red-500/10 font-mono">
          drag • zoom • explore
        </p>
      </div>

      {/* Spacer for min-height */}
      <div className="min-h-[400px]" />
    </div>
  );
};

export default GlobalNetworkGlobe;

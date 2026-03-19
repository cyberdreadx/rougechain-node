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
}

const Node = ({ position, isValidator = false }: NodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useFrame((state) => {
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 2.5) * 0.15;
    if (meshRef.current) {
      meshRef.current.scale.setScalar(pulse);
    }
    if (glowRef.current) {
      glowRef.current.scale.setScalar(pulse * 1.8);
      (glowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.15 + Math.sin(state.clock.elapsedTime * 3) * 0.1;
    }
  });

  // Cyberpunk rouge colors - deep red for validators, magenta for peers
  const coreColor = isValidator ? "#ff1744" : "#d500f9";
  const glowColor = isValidator ? "#ff5252" : "#e040fb";

  return (
    <group position={position}>
      {/* Outer glow */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[isValidator ? 0.12 : 0.06, 12, 12]} />
        <meshBasicMaterial color={glowColor} transparent opacity={0.2} />
      </mesh>
      
      {/* Core node */}
      <mesh
        ref={meshRef}
        onPointerOver={() => setHovered(true)}
        onPointerOut={() => setHovered(false)}
      >
        <dodecahedronGeometry args={[isValidator ? 0.06 : 0.035, 0]} />
        <meshStandardMaterial
          color={hovered ? "#ffffff" : coreColor}
          emissive={coreColor}
          emissiveIntensity={hovered ? 1.2 : 0.7}
          metalness={0.8}
          roughness={0.2}
        />
      </mesh>
      
      {hovered && (
        <Html distanceFactor={10}>
          <div className="bg-black/90 backdrop-blur-sm border border-red-500/50 rounded px-2 py-1 text-xs whitespace-nowrap shadow-lg shadow-red-500/20">
            <span className="text-red-400">
              {isValidator ? "L1 Node" : "Network Peer"}
            </span>
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

// Energy particle for traveling along connections
const EnergyParticle = ({ 
  curve, 
  speed, 
  offset, 
  color, 
  size 
}: { 
  curve: THREE.QuadraticBezierCurve3; 
  speed: number; 
  offset: number; 
  color: string;
  size: number;
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const coreRef = useRef<THREE.Mesh>(null);
  const glowRef = useRef<THREE.Mesh>(null);
  const trailRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const time = state.clock.elapsedTime;
    const t = ((time * speed + offset) % 1);
    
    if (groupRef.current) {
      const pos = curve.getPoint(t);
      groupRef.current.position.copy(pos);
      
      // Look in direction of travel
      const tangent = curve.getTangent(t);
      groupRef.current.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        tangent
      );
    }
    
    // Pulsing glow effect
    const pulse = 0.8 + Math.sin(time * 8 + offset * 10) * 0.2;
    const fade = Math.sin(t * Math.PI); // Fade at endpoints
    
    if (coreRef.current) {
      coreRef.current.scale.setScalar(size * pulse * fade);
      (coreRef.current.material as THREE.MeshBasicMaterial).opacity = fade;
    }
    
    if (glowRef.current) {
      glowRef.current.scale.setScalar(size * 2.5 * pulse * fade);
      (glowRef.current.material as THREE.MeshBasicMaterial).opacity = fade * 0.4;
    }
    
    if (trailRef.current) {
      trailRef.current.scale.set(size * 0.5, size * 0.5, size * 4 * fade);
      (trailRef.current.material as THREE.MeshBasicMaterial).opacity = fade * 0.3;
    }
  });

  return (
    <group ref={groupRef}>
      {/* Bright core */}
      <mesh ref={coreRef}>
        <octahedronGeometry args={[0.02, 0]} />
        <meshBasicMaterial color={color} transparent opacity={1} />
      </mesh>
      
      {/* Outer glow */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[0.02, 8, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.4} />
      </mesh>
      
      {/* Trailing energy */}
      <mesh ref={trailRef} position={[0, 0, -0.03]}>
        <coneGeometry args={[0.015, 0.08, 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} />
      </mesh>
    </group>
  );
};

// Animated curved connection with traveling energy pulses
const ConnectionLine = ({ start, end, index }: ConnectionLineProps) => {
  // Create curved path that arcs above the globe surface
  const { curve, points } = useMemo(() => {
    const startVec = new THREE.Vector3(...start);
    const endVec = new THREE.Vector3(...end);
    
    // Calculate midpoint and push it outward for the arc
    const mid = new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5);
    const distance = startVec.distanceTo(endVec);
    const arcHeight = 0.3 + distance * 0.15;
    mid.normalize().multiplyScalar(2 + arcHeight);
    
    const curve = new THREE.QuadraticBezierCurve3(startVec, mid, endVec);
    const points = curve.getPoints(40);
    return { curve, points };
  }, [start, end]);

  const geometry = useMemo(() => {
    return new THREE.BufferGeometry().setFromPoints(points);
  }, [points]);

  // Vary the visual properties based on index
  const baseOffset = (index * 0.17) % 1;
  const speed1 = 0.25 + (index % 5) * 0.04;
  const speed2 = 0.2 + ((index + 2) % 5) * 0.04;

  return (
    <group>
      {/* The curved line - deep red/magenta glow */}
      {/* @ts-ignore - R3F line element */}
      <line geometry={geometry} frustumCulled={false}>
        <lineBasicMaterial color="#ff1744" transparent opacity={0.15} />
      </line>
      
      {/* Primary energy particle - hot red */}
      <EnergyParticle 
        curve={curve} 
        speed={speed1} 
        offset={baseOffset} 
        color="#ff1744"
        size={1}
      />
      
      {/* Secondary energy particle - neon magenta */}
      <EnergyParticle 
        curve={curve} 
        speed={speed2} 
        offset={baseOffset + 0.5} 
        color="#ff4081"
        size={0.7}
      />
      
      {/* Occasional third particle - electric purple */}
      {index % 4 === 0 && (
        <EnergyParticle 
          curve={curve} 
          speed={0.35} 
          offset={baseOffset + 0.33} 
          color="#e040fb"
          size={0.5}
        />
      )}
    </group>
  );
};

const GlobeWireframe = () => {
  const meshRef = useRef<THREE.Mesh>(null);
  const innerGlowRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.0008;
    }
    if (innerGlowRef.current) {
      const pulse = 0.03 + Math.sin(state.clock.elapsedTime * 0.5) * 0.01;
      (innerGlowRef.current.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
  });

  return (
    <group>
      {/* Dark wireframe grid */}
      <mesh ref={meshRef}>
        <sphereGeometry args={[1.96, 48, 48]} />
        <meshBasicMaterial
          color="#ff1744"
          wireframe
          transparent
          opacity={0.06}
        />
      </mesh>
      
      {/* Inner atmospheric glow */}
      <mesh ref={innerGlowRef}>
        <sphereGeometry args={[2.1, 32, 32]} />
        <meshBasicMaterial
          color="#ff1744"
          transparent
          opacity={0.03}
          side={THREE.BackSide}
        />
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
      <sphereGeometry args={[1.9, 64, 64]} />
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
}

const NetworkScene = ({ nodeCount, peerCount }: NetworkSceneProps) => {
  const totalNodes = Math.max(nodeCount + peerCount, 3); // At least 3 for visualization
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
}

const normalizeStats = (data: Record<string, unknown>): NodeStats => ({
  connected_peers: Number(data.connected_peers ?? data.connectedPeers ?? 0),
  network_height: Number(data.network_height ?? data.networkHeight ?? 0),
  is_mining: Boolean(data.is_mining ?? data.isMining ?? false),
  node_id: String(data.node_id ?? data.nodeId ?? ""),
});

const GlobalNetworkGlobe = ({ className = "" }: GlobalNetworkGlobeProps) => {
  const [nodeStats, setNodeStats] = useState<NodeStats[]>([]);
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
              signal: AbortSignal.timeout(800),
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

  const totalPeers = nodeStats.reduce((sum, s) => sum + s.connected_peers, 0);
  const activeNodes = nodeStats.length;
  const displayNodes = activeNodes > 0 ? activeNodes : 1;
  const displayPeers = totalPeers;

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
            <NetworkScene nodeCount={displayNodes} peerCount={displayPeers} />
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

      {/* Legend - bottom left */}
      <div className="absolute bottom-4 left-4 z-20 pointer-events-none flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-sm bg-[#ff1744] shrink-0 shadow-sm shadow-red-500/50" />
          <span className="text-red-400/80">L1 Validators</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-sm bg-[#d500f9] shrink-0 shadow-sm shadow-fuchsia-500/50" />
          <span className="text-fuchsia-400/80">Network Peers</span>
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

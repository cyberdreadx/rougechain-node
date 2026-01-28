import { useRef, useMemo, useState, useEffect } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";
import { motion } from "framer-motion";
import { Globe, Activity, Users, Loader2, Wifi, Shield } from "lucide-react";
import { getNodeApiBaseUrl } from "@/lib/network";

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

// Generate connections between nodes
const generateConnections = (
  nodes: [number, number, number][],
  connectionProbability: number = 0.15
) => {
  const connections: [[number, number, number], [number, number, number]][] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (Math.random() < connectionProbability) {
        connections.push([nodes[i], nodes[j]]);
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
  const [hovered, setHovered] = useState(false);

  useFrame((state) => {
    if (meshRef.current && isValidator) {
      meshRef.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 3) * 0.1);
    }
  });

  const color = isValidator ? "#22c55e" : "#6366f1"; // Green for nodes, blue for peers

  return (
    <mesh
      ref={meshRef}
      position={position}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <sphereGeometry args={[isValidator ? 0.08 : 0.04, 16, 16]} />
      <meshStandardMaterial
        color={hovered ? "#ffffff" : color}
        emissive={color}
        emissiveIntensity={hovered ? 0.8 : 0.4}
      />
      {hovered && (
        <Html distanceFactor={10}>
          <div className="bg-card/90 backdrop-blur-sm border border-border rounded-lg px-2 py-1 text-xs whitespace-nowrap">
            <span className="text-muted-foreground">
              {isValidator ? "L1 Node" : "Network Peer"}
            </span>
          </div>
        </Html>
      )}
    </mesh>
  );
};

interface ConnectionLineProps {
  start: [number, number, number];
  end: [number, number, number];
}

const ConnectionLine = ({ start, end }: ConnectionLineProps) => {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([...start, ...end]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, [start, end]);

  const material = useMemo(() => {
    return new THREE.LineBasicMaterial({ 
      color: "#6366f1", 
      transparent: true, 
      opacity: 0.3 
    });
  }, []);

  return <primitive object={new THREE.Line(geometry, material)} />
};

const GlobeWireframe = () => {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.rotation.y += 0.001;
    }
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1.95, 32, 32]} />
      <meshBasicMaterial
        color="#6366f1"
        wireframe
        transparent
        opacity={0.08}
      />
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
      <ambientLight intensity={0.3} />
      <pointLight position={[10, 10, 10]} intensity={0.5} />
      <pointLight position={[-10, -10, -10]} intensity={0.3} color="#a855f7" />

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
  connectedPeers: number;
  networkHeight: number;
  isMining: boolean;
  nodeId: string;
}

const GlobalNetworkGlobe = ({ className = "" }: GlobalNetworkGlobeProps) => {
  const [nodeStats, setNodeStats] = useState<NodeStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    const fetchNodes = async () => {
      try {
        const stats: NodeStats[] = [];
        const envList = (import.meta.env.VITE_PUBLIC_NODE_APIS as string | undefined)
          ?.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean) ?? [];

        const apiBases = envList.length > 0
          ? envList
          : [getNodeApiBaseUrl()].filter(Boolean);

        const targets = apiBases.length > 0
          ? apiBases.map((base) => `${base}/stats`)
          // Dev-only fallback when no API is configured.
          : [5100, 5101, 5102, 5103, 5104].map((apiPort) => `http://127.0.0.1:${apiPort}/api/stats`);

        for (const url of targets) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const data = await res.json() as NodeStats;
              stats.push(data);
            }
          } catch {
            // Ignore unreachable targets
          }
        }
        setNodeStats(stats);
        setIsLive(stats.length > 0);
      } catch (error) {
        console.error("Failed to fetch nodes:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchNodes();
    const interval = setInterval(fetchNodes, 3000);
    return () => clearInterval(interval);
  }, []);

  const totalPeers = nodeStats.reduce((sum, s) => sum + s.connectedPeers, 0);
  const activeNodes = nodeStats.length;

  return (
    <div className={`relative ${className}`}>
      {/* Header */}
      <div className="absolute top-4 left-4 z-10">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Global Network</h3>
          {isLive && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/20 border border-success/30">
              <Wifi className="w-3 h-3 text-success" />
              <span className="text-[10px] text-success font-medium">LIVE</span>
            </div>
          )}
        </div>
        <p className="text-xs text-muted-foreground max-w-[200px]">
          Real-time RougeChain L1 node network
        </p>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-full bg-success" />
          <span className="text-muted-foreground">L1 Nodes</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-full bg-primary" />
          <span className="text-muted-foreground">Network Peers</span>
        </div>
      </div>

      {/* Stats */}
      <motion.div
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        className="absolute top-4 right-4 z-10 flex flex-col gap-2"
      >
        <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg px-3 py-2 flex items-center gap-2">
          <Users className="w-4 h-4 text-primary" />
          <div>
            <p className="text-xs text-muted-foreground">Nodes</p>
            <p className="text-sm font-semibold text-foreground">
              {isLoading ? "..." : activeNodes}
            </p>
          </div>
        </div>
        <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg px-3 py-2 flex items-center gap-2">
          <Activity className="w-4 h-4 text-success" />
          <div>
            <p className="text-xs text-muted-foreground">Peers</p>
            <p className="text-sm font-semibold text-foreground">
              {isLoading ? "..." : totalPeers}
            </p>
          </div>
        </div>
        {nodeStats.length > 0 && (
          <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg px-3 py-2">
            <p className="text-xs text-muted-foreground">Mining</p>
            <p className="text-sm font-semibold text-foreground">
              {nodeStats.filter(s => s.isMining).length} / {activeNodes}
            </p>
          </div>
        )}
      </motion.div>

      {/* 3D Canvas */}
      <div className="w-full h-full min-h-[400px] bg-gradient-to-b from-background to-card rounded-xl border border-border overflow-hidden">
        {isLoading ? (
          <div className="w-full h-full flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : (
          <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>
            <NetworkScene nodeCount={activeNodes} peerCount={totalPeers} />
          </Canvas>
        )}
      </div>

      {/* Bottom right actions */}
      <div className="absolute bottom-4 right-4 z-10 flex flex-col items-end gap-2">
        <p className="text-xs text-muted-foreground bg-card/60 backdrop-blur-sm px-2 py-1 rounded">
          Drag to rotate • Scroll to zoom
        </p>
      </div>
    </div>
  );
};

export default GlobalNetworkGlobe;

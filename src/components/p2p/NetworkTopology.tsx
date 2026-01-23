import { useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Text, Line } from "@react-three/drei";
import * as THREE from "three";
import type { PeerInfo, NodeIdentity } from "@/lib/p2p";

interface NetworkTopologyProps {
  identity: NodeIdentity | null;
  peers: PeerInfo[];
  isRunning: boolean;
}

interface NodeData {
  id: string;
  position: [number, number, number];
  role: string;
  isLocal: boolean;
  chainHeight: number;
  publicKey: string;
}

// Animated connection line between nodes
function ConnectionLine({ 
  start, 
  end, 
  isActive 
}: { 
  start: [number, number, number]; 
  end: [number, number, number]; 
  isActive: boolean;
}) {
  const [dashOffset, setDashOffset] = useState(0);

  useFrame((_, delta) => {
    if (isActive) {
      setDashOffset((prev) => (prev + delta * 2) % 1);
    }
  });

  const points = useMemo(() => [
    new THREE.Vector3(...start),
    new THREE.Vector3(...end)
  ], [start, end]);

  return (
    <Line
      points={points}
      color={isActive ? "#22c55e" : "#4b5563"}
      lineWidth={isActive ? 2 : 1}
      dashed={isActive}
      dashScale={10}
      dashSize={0.5}
      dashOffset={dashOffset}
      opacity={isActive ? 1 : 0.5}
      transparent
    />
  );
}

// Animated data packet traveling along connection
function DataPacket({ 
  start, 
  end, 
  speed = 1 
}: { 
  start: [number, number, number]; 
  end: [number, number, number]; 
  speed?: number;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const [progress, setProgress] = useState(Math.random());

  useFrame((_, delta) => {
    setProgress((prev) => {
      const next = prev + delta * speed * 0.5;
      return next > 1 ? 0 : next;
    });

    if (ref.current) {
      ref.current.position.set(
        start[0] + (end[0] - start[0]) * progress,
        start[1] + (end[1] - start[1]) * progress,
        start[2] + (end[2] - start[2]) * progress
      );
    }
  });

  return (
    <mesh ref={ref}>
      <sphereGeometry args={[0.08, 8, 8]} />
      <meshStandardMaterial 
        color="#22c55e" 
        emissive="#22c55e" 
        emissiveIntensity={0.5} 
      />
    </mesh>
  );
}

// Network node (peer or local node)
function NetworkNode({ 
  node, 
  onHover, 
  onLeave 
}: { 
  node: NodeData; 
  onHover: (node: NodeData) => void;
  onLeave: () => void;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useFrame((state) => {
    if (ref.current) {
      // Gentle floating animation
      ref.current.position.y = node.position[1] + Math.sin(state.clock.elapsedTime + node.position[0]) * 0.1;
      
      // Pulse when hovered
      if (hovered) {
        const scale = 1 + Math.sin(state.clock.elapsedTime * 4) * 0.1;
        ref.current.scale.setScalar(scale);
      } else {
        ref.current.scale.setScalar(1);
      }
    }
  });

  const color = node.isLocal 
    ? "#8b5cf6" // Purple for local
    : node.role === "validator" 
      ? "#22c55e" // Green for validators
      : "#3b82f6"; // Blue for other nodes

  const size = node.isLocal ? 0.4 : node.role === "validator" ? 0.3 : 0.25;

  return (
    <group position={node.position}>
      <mesh
        ref={ref}
        onPointerOver={() => { setHovered(true); onHover(node); }}
        onPointerOut={() => { setHovered(false); onLeave(); }}
      >
        {node.role === "validator" ? (
          <octahedronGeometry args={[size, 0]} />
        ) : node.isLocal ? (
          <dodecahedronGeometry args={[size, 0]} />
        ) : (
          <sphereGeometry args={[size, 16, 16]} />
        )}
        <meshStandardMaterial 
          color={color} 
          emissive={color} 
          emissiveIntensity={hovered ? 0.8 : 0.3}
          metalness={0.5}
          roughness={0.3}
        />
      </mesh>
      
      {/* Glow ring for local node */}
      {node.isLocal && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.5, 0.6, 32]} />
          <meshBasicMaterial color="#8b5cf6" transparent opacity={0.5} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Node label */}
      <Text
        position={[0, size + 0.3, 0]}
        fontSize={0.15}
        color="white"
        anchorX="center"
        anchorY="bottom"
      >
        {node.isLocal ? "YOU" : node.id.slice(0, 8)}
      </Text>

      {/* Role badge */}
      <Text
        position={[0, size + 0.15, 0]}
        fontSize={0.1}
        color={color}
        anchorX="center"
        anchorY="bottom"
      >
        {node.role.toUpperCase()}
      </Text>
    </group>
  );
}

// Main 3D scene
function NetworkScene({ 
  nodes, 
  onNodeHover, 
  onNodeLeave 
}: { 
  nodes: NodeData[];
  onNodeHover: (node: NodeData) => void;
  onNodeLeave: () => void;
}) {
  const localNode = nodes.find(n => n.isLocal);
  
  return (
    <>
      {/* Ambient lighting */}
      <ambientLight intensity={0.4} />
      <pointLight position={[10, 10, 10]} intensity={1} />
      <pointLight position={[-10, -10, -10]} intensity={0.5} color="#8b5cf6" />

      {/* Grid floor */}
      <gridHelper args={[20, 20, "#1f2937", "#1f2937"]} position={[0, -2, 0]} />

      {/* Connection lines */}
      {localNode && nodes.filter(n => !n.isLocal).map((peer, i) => (
        <group key={`connection-${i}`}>
          <ConnectionLine 
            start={localNode.position} 
            end={peer.position} 
            isActive={true}
          />
          {/* Data packets */}
          <DataPacket 
            start={localNode.position} 
            end={peer.position} 
            speed={0.5 + Math.random() * 0.5}
          />
          <DataPacket 
            start={peer.position} 
            end={localNode.position} 
            speed={0.5 + Math.random() * 0.5}
          />
        </group>
      ))}

      {/* Peer-to-peer connections (mesh network) */}
      {nodes.filter(n => !n.isLocal).map((peer1, i) => 
        nodes.filter(n => !n.isLocal).slice(i + 1).map((peer2, j) => (
          <ConnectionLine 
            key={`p2p-${i}-${j}`}
            start={peer1.position} 
            end={peer2.position} 
            isActive={false}
          />
        ))
      )}

      {/* Nodes */}
      {nodes.map((node) => (
        <NetworkNode 
          key={node.id} 
          node={node} 
          onHover={onNodeHover}
          onLeave={onNodeLeave}
        />
      ))}

      {/* Camera controls */}
      <OrbitControls 
        enablePan={false}
        minDistance={3}
        maxDistance={15}
        autoRotate
        autoRotateSpeed={0.5}
      />
    </>
  );
}

// Empty state visualization
function EmptyNetworkScene() {
  const ref = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    if (ref.current) {
      ref.current.rotation.y = state.clock.elapsedTime * 0.3;
    }
  });

  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[10, 10, 10]} intensity={1} />
      
      <mesh ref={ref}>
        <dodecahedronGeometry args={[1, 0]} />
        <meshStandardMaterial 
          color="#4b5563" 
          wireframe 
          transparent 
          opacity={0.5}
        />
      </mesh>

      <Text
        position={[0, -1.5, 0]}
        fontSize={0.2}
        color="#6b7280"
        anchorX="center"
      >
        No peers connected
      </Text>

      <OrbitControls enablePan={false} autoRotate autoRotateSpeed={1} />
    </>
  );
}

export function NetworkTopology({ identity, peers, isRunning }: NetworkTopologyProps) {
  const [hoveredNode, setHoveredNode] = useState<NodeData | null>(null);

  // Generate node positions in a sphere around the local node
  const nodes = useMemo(() => {
    const result: NodeData[] = [];

    // Local node at center
    if (identity) {
      result.push({
        id: identity.peerId,
        position: [0, 0, 0],
        role: identity.nodeRole,
        isLocal: true,
        chainHeight: 0,
        publicKey: identity.publicKey,
      });
    }

    // Peer nodes in a circle around center
    peers.forEach((peer, i) => {
      const angle = (i / Math.max(peers.length, 1)) * Math.PI * 2;
      const radius = 3 + Math.random() * 1;
      const height = (Math.random() - 0.5) * 2;
      
      result.push({
        id: peer.peerId,
        position: [
          Math.cos(angle) * radius,
          height,
          Math.sin(angle) * radius,
        ],
        role: peer.nodeRole,
        isLocal: false,
        chainHeight: peer.chainHeight,
        publicKey: peer.publicKey,
      });
    });

    return result;
  }, [identity, peers]);

  return (
    <div className="relative w-full h-[400px] rounded-lg overflow-hidden bg-background/50 border">
      <Canvas camera={{ position: [0, 4, 8], fov: 50 }}>
        <color attach="background" args={["#0a0a0f"]} />
        <fog attach="fog" args={["#0a0a0f", 10, 25]} />
        
        {!isRunning || nodes.length <= 1 ? (
          <EmptyNetworkScene />
        ) : (
          <NetworkScene 
            nodes={nodes} 
            onNodeHover={setHoveredNode}
            onNodeLeave={() => setHoveredNode(null)}
          />
        )}
      </Canvas>

      {/* Overlay info */}
      <div className="absolute top-4 left-4 text-xs space-y-1">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-purple-500" />
          <span className="text-muted-foreground">Your Node</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-green-500" />
          <span className="text-muted-foreground">Validator</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500" />
          <span className="text-muted-foreground">Full Node</span>
        </div>
      </div>

      {/* Hovered node info */}
      {hoveredNode && (
        <div className="absolute bottom-4 left-4 right-4 bg-card/90 backdrop-blur-sm rounded-lg p-3 border animate-fade-in">
          <div className="flex justify-between items-start">
            <div>
              <p className="font-semibold text-sm">
                {hoveredNode.isLocal ? "Your Node" : `Peer: ${hoveredNode.id.slice(0, 16)}...`}
              </p>
              <p className="text-xs text-muted-foreground capitalize">
                Role: {hoveredNode.role}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Chain Height</p>
              <p className="font-mono text-sm">{hoveredNode.chainHeight}</p>
            </div>
          </div>
          <p className="text-xs font-mono text-muted-foreground mt-2 truncate">
            PubKey: {hoveredNode.publicKey.slice(0, 40)}...
          </p>
        </div>
      )}

      {/* Network status */}
      <div className="absolute top-4 right-4">
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${
          isRunning 
            ? "bg-green-500/20 text-green-400 border border-green-500/30" 
            : "bg-muted text-muted-foreground"
        }`}>
          <span className={`w-2 h-2 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : "bg-muted-foreground"}`} />
          {isRunning ? `${peers.length} peers` : "Offline"}
        </div>
      </div>
    </div>
  );
}

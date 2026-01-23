import { useRef, useMemo, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, Html } from "@react-three/drei";
import * as THREE from "three";
import { motion } from "framer-motion";
import { Globe, Activity, Users } from "lucide-react";

// Generate random points on a sphere
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
  isActive?: boolean;
  isValidator?: boolean;
  onClick?: () => void;
}

const Node = ({ position, isActive = false, isValidator = false, onClick }: NodeProps) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  useFrame((state) => {
    if (meshRef.current && isActive) {
      meshRef.current.scale.setScalar(1 + Math.sin(state.clock.elapsedTime * 3) * 0.1);
    }
  });

  const color = isValidator ? "#22c55e" : isActive ? "#a855f7" : "#6366f1";

  return (
    <mesh
      ref={meshRef}
      position={position}
      onClick={onClick}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
    >
      <sphereGeometry args={[isValidator ? 0.08 : 0.05, 16, 16]} />
      <meshStandardMaterial
        color={hovered ? "#ffffff" : color}
        emissive={color}
        emissiveIntensity={hovered ? 0.8 : 0.4}
      />
      {hovered && (
        <Html distanceFactor={10}>
          <div className="bg-card/90 backdrop-blur-sm border border-border rounded-lg px-2 py-1 text-xs whitespace-nowrap">
            <span className="text-foreground">
              {isValidator ? "Validator Node" : "Network Node"}
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
  const lineRef = useRef<THREE.Line>(null);
  
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

  return <primitive ref={lineRef} object={new THREE.Line(geometry, material)} />
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
  validatorCount: number;
}

const NetworkScene = ({ nodeCount, validatorCount }: NetworkSceneProps) => {
  const nodes = useMemo(() => generateNodePositions(nodeCount, 2), [nodeCount]);
  const connections = useMemo(() => generateConnections(nodes, 0.12), [nodes]);
  const validatorIndices = useMemo(() => {
    const indices: number[] = [];
    while (indices.length < validatorCount && indices.length < nodeCount) {
      const idx = Math.floor(Math.random() * nodeCount);
      if (!indices.includes(idx)) indices.push(idx);
    }
    return indices;
  }, [nodeCount, validatorCount]);

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
            isValidator={validatorIndices.includes(i)}
            isActive={Math.random() > 0.7}
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
  nodeCount?: number;
  validatorCount?: number;
  className?: string;
}

const GlobalNetworkGlobe = ({
  nodeCount = 50,
  validatorCount = 8,
  className = "",
}: GlobalNetworkGlobeProps) => {
  return (
    <div className={`relative ${className}`}>
      {/* Header */}
      <div className="absolute top-4 left-4 z-10">
        <div className="flex items-center gap-2 mb-2">
          <Globe className="w-5 h-5 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Global Network</h3>
        </div>
        <p className="text-xs text-muted-foreground max-w-[200px]">
          Interactive view of RougeChain nodes worldwide
        </p>
      </div>

      {/* Legend */}
      <div className="absolute bottom-4 left-4 z-10 flex flex-col gap-2">
        <div className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-full bg-success" />
          <span className="text-muted-foreground">Validator Nodes</span>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="w-3 h-3 rounded-full bg-primary" />
          <span className="text-muted-foreground">Network Nodes</span>
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
            <p className="text-xs text-muted-foreground">Total Nodes</p>
            <p className="text-sm font-semibold text-foreground">{nodeCount}</p>
          </div>
        </div>
        <div className="bg-card/80 backdrop-blur-sm border border-border rounded-lg px-3 py-2 flex items-center gap-2">
          <Activity className="w-4 h-4 text-success" />
          <div>
            <p className="text-xs text-muted-foreground">Validators</p>
            <p className="text-sm font-semibold text-foreground">{validatorCount}</p>
          </div>
        </div>
      </motion.div>

      {/* 3D Canvas */}
      <div className="w-full h-full min-h-[400px] bg-gradient-to-b from-background to-card rounded-xl border border-border overflow-hidden">
        <Canvas camera={{ position: [0, 0, 5], fov: 50 }}>
          <NetworkScene nodeCount={nodeCount} validatorCount={validatorCount} />
        </Canvas>
      </div>

      {/* Interaction hint */}
      <div className="absolute bottom-4 right-4 z-10">
        <p className="text-xs text-muted-foreground bg-card/60 backdrop-blur-sm px-2 py-1 rounded">
          Drag to rotate • Scroll to zoom
        </p>
      </div>
    </div>
  );
};

export default GlobalNetworkGlobe;

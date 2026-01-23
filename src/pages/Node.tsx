import { NodeDashboard } from "@/components/p2p/NodeDashboard";
import { MainNav } from "@/components/MainNav";

const Node = () => {
  return (
    <div className="min-h-screen bg-background">
      <MainNav />
      <div className="max-w-6xl mx-auto p-6">
        <NodeDashboard />
      </div>
    </div>
  );
};

export default Node;

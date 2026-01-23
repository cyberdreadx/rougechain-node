import { NodeDashboard } from "@/components/p2p/NodeDashboard";
import { NavLink } from "@/components/NavLink";

const Node = () => {
  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-6xl mx-auto">
        <nav className="flex gap-4 mb-8 flex-wrap">
          <NavLink to="/">Home</NavLink>
          <NavLink to="/blockchain">Blockchain</NavLink>
          <NavLink to="/wallet">Wallet</NavLink>
          <NavLink to="/messenger">Messenger</NavLink>
          <NavLink to="/validators">Validators</NavLink>
          <NavLink to="/node">P2P Node</NavLink>
        </nav>
        
        <NodeDashboard />
      </div>
    </div>
  );
};

export default Node;

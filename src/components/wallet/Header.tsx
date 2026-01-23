import { motion } from "framer-motion";
import { Menu, Bell, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";

const Header = () => {
  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between px-4 py-4 border-b border-border bg-card/50 backdrop-blur-xl sticky top-0 z-50"
    >
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu className="w-5 h-5" />
        </Button>
        
        <div className="flex items-center gap-2">
          <motion.div
            animate={{ rotate: [0, 360] }}
            transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
            className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center"
          >
            <span className="text-primary-foreground font-bold text-sm">Q</span>
          </motion.div>
          <div>
            <h1 className="text-lg font-bold text-foreground">QuantumVault</h1>
            <p className="text-xs text-muted-foreground">BASE Chain</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="w-5 h-5 text-muted-foreground" />
          <span className="absolute top-1 right-1 w-2 h-2 bg-primary rounded-full" />
        </Button>
        <Button variant="ghost" size="icon">
          <Settings className="w-5 h-5 text-muted-foreground" />
        </Button>
        
        <div className="hidden sm:flex items-center gap-2 ml-2 px-3 py-1.5 rounded-full bg-secondary border border-border">
          <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
          <span className="text-xs text-muted-foreground">Connected</span>
        </div>
      </div>
    </motion.header>
  );
};

export default Header;

import { motion } from "framer-motion";
import { ArrowUpRight, ArrowDownLeft, RefreshCw, History } from "lucide-react";
import { Button } from "@/components/ui/button";

const actions = [
  { icon: ArrowUpRight, label: "Send", color: "primary" },
  { icon: ArrowDownLeft, label: "Receive", color: "success" },
  { icon: RefreshCw, label: "Swap", color: "accent" },
  { icon: History, label: "History", color: "muted" },
];

const ActionButtons = () => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className="grid grid-cols-4 gap-3"
    >
      {actions.map((action, index) => (
        <motion.div
          key={action.label}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 + index * 0.05 }}
        >
          <Button
            variant="outline"
            className="w-full h-auto flex-col gap-2 py-4 bg-card hover:bg-secondary border-border hover:border-primary/50 transition-all duration-300 group"
          >
            <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <action.icon className="w-5 h-5 text-primary" />
            </div>
            <span className="text-xs text-foreground">{action.label}</span>
          </Button>
        </motion.div>
      ))}
    </motion.div>
  );
};

export default ActionButtons;

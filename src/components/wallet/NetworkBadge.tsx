import { motion } from "framer-motion";

interface NetworkBadgeProps {
  isConnected?: boolean;
  blockNumber?: number;
}

const NetworkBadge = ({ isConnected = false, blockNumber }: NetworkBadgeProps) => {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.5 }}
      className="fixed bottom-4 left-4 flex items-center gap-2 px-3 py-2 rounded-full bg-card border border-border shadow-lg"
    >
      <div className="relative">
        <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-primary' : 'bg-muted-foreground'}`} />
        {isConnected && (
          <motion.div
            animate={{ scale: [1, 1.5, 1], opacity: [1, 0, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="absolute inset-0 w-3 h-3 rounded-full bg-primary"
          />
        )}
      </div>
      <span className="text-xs font-medium text-foreground">
        {isConnected ? 'BASE Mainnet' : 'Disconnected'}
      </span>
      {isConnected && blockNumber && (
        <span className="text-xs text-muted-foreground">Block: {blockNumber.toLocaleString()}</span>
      )}
    </motion.div>
  );
};

export default NetworkBadge;

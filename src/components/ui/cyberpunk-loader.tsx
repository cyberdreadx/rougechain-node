import { motion } from "framer-motion";

interface CyberpunkLoaderProps {
  message?: string;
  tokenIn?: string;
  tokenOut?: string;
}

export const CyberpunkLoader = ({ 
  message = "Processing Transaction", 
  tokenIn, 
  tokenOut 
}: CyberpunkLoaderProps) => {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md">
      {/* Scan lines overlay */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-10"
        style={{
          backgroundImage: `repeating-linear-gradient(
            0deg,
            transparent,
            transparent 2px,
            rgba(0, 255, 136, 0.03) 2px,
            rgba(0, 255, 136, 0.03) 4px
          )`,
        }}
      />

      {/* Glowing grid background */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-20"
        style={{
          backgroundImage: `
            linear-gradient(rgba(0, 255, 136, 0.1) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0, 255, 136, 0.1) 1px, transparent 1px)
          `,
          backgroundSize: '50px 50px',
        }}
      />

      <div className="relative flex flex-col items-center gap-8">
        {/* Main hexagonal loader */}
        <div className="relative w-48 h-48">
          {/* Outer rotating hexagon */}
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: 360 }}
            transition={{ duration: 8, repeat: Infinity, ease: "linear" }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full">
              <polygon
                points="50,2 93,25 93,75 50,98 7,75 7,25"
                fill="none"
                stroke="url(#gradient1)"
                strokeWidth="0.5"
                opacity="0.5"
              />
              <defs>
                <linearGradient id="gradient1" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#00ff88" />
                  <stop offset="50%" stopColor="#00d4ff" />
                  <stop offset="100%" stopColor="#ff00ff" />
                </linearGradient>
              </defs>
            </svg>
          </motion.div>

          {/* Middle counter-rotating hexagon */}
          <motion.div
            className="absolute inset-4"
            animate={{ rotate: -360 }}
            transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full">
              <polygon
                points="50,5 90,27 90,73 50,95 10,73 10,27"
                fill="none"
                stroke="#00ff88"
                strokeWidth="1"
                strokeDasharray="10 5"
                className="drop-shadow-[0_0_10px_#00ff88]"
              />
            </svg>
          </motion.div>

          {/* Inner pulsing hexagon */}
          <motion.div
            className="absolute inset-8"
            animate={{ scale: [1, 1.1, 1], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          >
            <svg viewBox="0 0 100 100" className="w-full h-full">
              <polygon
                points="50,10 85,30 85,70 50,90 15,70 15,30"
                fill="rgba(0, 255, 136, 0.1)"
                stroke="#00ff88"
                strokeWidth="2"
                className="drop-shadow-[0_0_20px_#00ff88]"
              />
            </svg>
          </motion.div>

          {/* Center core */}
          <div className="absolute inset-0 flex items-center justify-center">
            <motion.div
              className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500/20 to-cyan-500/20 border border-emerald-400/50 flex items-center justify-center"
              animate={{ 
                boxShadow: [
                  "0 0 20px rgba(0, 255, 136, 0.3), inset 0 0 20px rgba(0, 255, 136, 0.1)",
                  "0 0 40px rgba(0, 255, 136, 0.6), inset 0 0 30px rgba(0, 255, 136, 0.2)",
                  "0 0 20px rgba(0, 255, 136, 0.3), inset 0 0 20px rgba(0, 255, 136, 0.1)",
                ]
              }}
              transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
            >
              {/* Swap arrows */}
              <motion.svg 
                viewBox="0 0 24 24" 
                className="w-8 h-8 text-emerald-400"
                animate={{ rotate: [0, 180, 360] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              >
                <path
                  fill="currentColor"
                  d="M7.5 21L3 16.5L7.5 12L8.91 13.41L6.83 15.5H16V17.5H6.83L8.91 19.59L7.5 21ZM16.5 12L15.09 10.59L17.17 8.5H8V6.5H17.17L15.09 4.41L16.5 3L21 7.5L16.5 12Z"
                />
              </motion.svg>
            </motion.div>
          </div>

          {/* Orbiting particles */}
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <motion.div
              key={i}
              className="absolute w-2 h-2 rounded-full bg-emerald-400"
              style={{
                top: '50%',
                left: '50%',
                boxShadow: '0 0 10px #00ff88, 0 0 20px #00ff88',
              }}
              animate={{
                x: [
                  Math.cos((i * Math.PI) / 3) * 80,
                  Math.cos((i * Math.PI) / 3 + Math.PI) * 80,
                  Math.cos((i * Math.PI) / 3) * 80,
                ],
                y: [
                  Math.sin((i * Math.PI) / 3) * 80,
                  Math.sin((i * Math.PI) / 3 + Math.PI) * 80,
                  Math.sin((i * Math.PI) / 3) * 80,
                ],
                scale: [1, 1.5, 1],
                opacity: [0.5, 1, 0.5],
              }}
              transition={{
                duration: 3,
                repeat: Infinity,
                delay: i * 0.5,
                ease: "easeInOut",
              }}
            />
          ))}

          {/* Energy beams */}
          {[0, 60, 120, 180, 240, 300].map((angle, i) => (
            <motion.div
              key={`beam-${i}`}
              className="absolute top-1/2 left-1/2 w-20 h-0.5 origin-left"
              style={{
                transform: `rotate(${angle}deg)`,
                background: 'linear-gradient(90deg, #00ff88, transparent)',
              }}
              animate={{
                opacity: [0, 1, 0],
                scaleX: [0, 1, 0],
              }}
              transition={{
                duration: 1.5,
                repeat: Infinity,
                delay: i * 0.25,
                ease: "easeOut",
              }}
            />
          ))}
        </div>

        {/* Token swap display */}
        {tokenIn && tokenOut && (
          <motion.div
            className="flex items-center gap-4 text-lg font-mono"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <span className="text-emerald-400 drop-shadow-[0_0_10px_#00ff88]">{tokenIn}</span>
            <motion.span
              animate={{ x: [0, 5, 0] }}
              transition={{ duration: 0.5, repeat: Infinity }}
              className="text-cyan-400"
            >
              →
            </motion.span>
            <span className="text-cyan-400 drop-shadow-[0_0_10px_#00d4ff]">{tokenOut}</span>
          </motion.div>
        )}

        {/* Message with glitch effect */}
        <motion.div
          className="relative"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          <motion.p
            className="text-emerald-400 font-mono text-sm tracking-widest uppercase"
            animate={{ opacity: [1, 0.7, 1] }}
            transition={{ duration: 0.1, repeat: Infinity, repeatDelay: 2 }}
          >
            {message}
          </motion.p>
          
          {/* Glitch layers */}
          <motion.p
            className="absolute inset-0 text-cyan-400 font-mono text-sm tracking-widest uppercase"
            animate={{ 
              x: [-2, 2, -2],
              opacity: [0, 0.5, 0],
            }}
            transition={{ duration: 0.1, repeat: Infinity, repeatDelay: 3 }}
          >
            {message}
          </motion.p>
          <motion.p
            className="absolute inset-0 text-pink-500 font-mono text-sm tracking-widest uppercase"
            animate={{ 
              x: [2, -2, 2],
              opacity: [0, 0.5, 0],
            }}
            transition={{ duration: 0.1, repeat: Infinity, repeatDelay: 3.5 }}
          >
            {message}
          </motion.p>
        </motion.div>

        {/* Progress dots */}
        <div className="flex gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <motion.div
              key={i}
              className="w-2 h-2 rounded-full bg-emerald-400"
              animate={{
                scale: [1, 1.5, 1],
                opacity: [0.3, 1, 0.3],
              }}
              transition={{
                duration: 1,
                repeat: Infinity,
                delay: i * 0.2,
              }}
              style={{
                boxShadow: '0 0 5px #00ff88',
              }}
            />
          ))}
        </div>

        {/* Bottom status bar */}
        <div className="w-64 h-1 bg-gray-800 rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-gradient-to-r from-emerald-500 via-cyan-500 to-emerald-500"
            animate={{
              x: ["-100%", "100%"],
            }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              ease: "linear",
            }}
            style={{
              width: "50%",
              boxShadow: '0 0 10px #00ff88',
            }}
          />
        </div>

        {/* Security badge */}
        <motion.div
          className="flex items-center gap-2 text-xs text-emerald-400/70 font-mono"
          animate={{ opacity: [0.5, 1, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
          </svg>
          <span>QUANTUM-SAFE TRANSACTION</span>
        </motion.div>
      </div>
    </div>
  );
};

export default CyberpunkLoader;

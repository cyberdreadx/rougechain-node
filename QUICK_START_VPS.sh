#!/bin/bash
# Quick setup script for RougeChain node on Hostinger VPS
# Run this on your VPS after SSH connection

set -e

echo "🚀 RougeChain L1 Node Setup for Hostinger VPS"
echo "=============================================="

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo "⚠️  Running as root. Consider using a non-root user."
fi

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js if not installed
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
else
    echo "✅ Node.js already installed: $(node --version)"
fi

# Install PM2 if not installed
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2..."
    sudo npm install -g pm2
else
    echo "✅ PM2 already installed"
fi

# Install Nginx if not installed
if ! command -v nginx &> /dev/null; then
    echo "📦 Installing Nginx..."
    sudo apt install -y nginx
else
    echo "✅ Nginx already installed"
fi

# Setup firewall
echo "🔥 Configuring firewall..."
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw allow 4100/tcp  # P2P
sudo ufw allow 5100/tcp  # API
sudo ufw --force enable

# Get project directory
read -p "Enter project directory (default: /var/www/quantum-vault): " PROJECT_DIR
PROJECT_DIR=${PROJECT_DIR:-/var/www/quantum-vault}

if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ Project directory not found: $PROJECT_DIR"
    echo "Please clone/upload your project first, then run this script again."
    exit 1
fi

cd "$PROJECT_DIR"

# Install dependencies
echo "📦 Installing dependencies..."
npm install
npm install --save @noble/post-quantum
npm install --save-dev tsx

# Get configuration
read -p "Enter node name (default: public-node): " NODE_NAME
NODE_NAME=${NODE_NAME:-public-node}

read -p "Enter P2P port (default: 4100): " P2P_PORT
P2P_PORT=${P2P_PORT:-4100}

read -p "Enter API port (default: 5100): " API_PORT
API_PORT=${API_PORT:-5100}

read -p "Enable mining? (y/n, default: y): " ENABLE_MINE
ENABLE_MINE=${ENABLE_MINE:-y}

MINE_FLAG=""
if [ "$ENABLE_MINE" = "y" ]; then
    MINE_FLAG="--mine"
fi

# Stop existing PM2 process if running
pm2 delete rougechain-node 2>/dev/null || true

# Start node with PM2
echo "🚀 Starting RougeChain node..."
pm2 start npm --name "rougechain-node" -- run l1:node:dev -- \
  --name "$NODE_NAME" \
  --host 0.0.0.0 \
  --port "$P2P_PORT" \
  --apiPort "$API_PORT" \
  $MINE_FLAG \
  --blockTimeMs 1000

# Save PM2 config
pm2 save

# Setup auto-start
echo "⚙️  Setting up auto-start..."
STARTUP_CMD=$(pm2 startup | grep -o 'sudo.*')
if [ ! -z "$STARTUP_CMD" ]; then
    echo "Run this command to enable auto-start:"
    echo "$STARTUP_CMD"
fi

# Test API
echo "🧪 Testing API..."
sleep 2
curl -s http://localhost:$API_PORT/api/stats | head -20

echo ""
echo "✅ Setup complete!"
echo ""
echo "Node is running with PM2"
echo "View logs: pm2 logs rougechain-node"
echo "View status: pm2 status"
echo ""
echo "API accessible at: http://$(hostname -I | awk '{print $1}'):$API_PORT/api/stats"
echo ""
echo "Next steps:"
echo "1. Configure Nginx reverse proxy (optional)"
echo "2. Setup SSL with Let's Encrypt (optional)"
echo "3. Deploy frontend to Netlify"
echo "4. Update VITE_NODE_API_URL in Netlify env vars"

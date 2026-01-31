#!/bin/bash
# Quick setup script for Quantum Vault core node on Hostinger VPS
# Run this on your VPS after SSH connection

set -e

echo "🚀 Quantum Vault Core Node Setup for Hostinger VPS"
echo "=================================================="

# Check if running as root
if [ "$EUID" -eq 0 ]; then
   echo "⚠️  Running as root. Consider using a non-root user."
fi

# Update system
echo "📦 Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install build dependencies
echo "📦 Installing build dependencies..."
sudo apt install -y build-essential pkg-config libssl-dev curl

# Install Rust if not installed
if ! command -v cargo &> /dev/null; then
    echo "📦 Installing Rust..."
    curl https://sh.rustup.rs -sSf | sh -s -- -y
    source "$HOME/.cargo/env"
else
    echo "✅ Rust already installed: $(cargo --version)"
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

# Build the core daemon
echo "📦 Building core node..."
cd "$PROJECT_DIR/core"
cargo build --release

# Optional API key auth
read -p "Enter API key for node auth (leave blank to disable): " API_KEY
API_ENV_LINE=""
if [ -n "$API_KEY" ]; then
  API_ENV_LINE="Environment=QV_API_KEYS=$API_KEY"
fi

# Configure systemd service
USER_NAME=$(whoami)
SERVICE_PATH="/etc/systemd/system/quantum-vault-daemon.service"

echo "⚙️  Creating systemd service..."
sudo tee "$SERVICE_PATH" > /dev/null <<EOF
[Unit]
Description=Quantum Vault Core Node
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$PROJECT_DIR/core
ExecStart=$PROJECT_DIR/core/target/release/quantum-vault-daemon --host 0.0.0.0 --port 4100 --api-port 5100 --mine
$API_ENV_LINE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable quantum-vault-daemon
sudo systemctl restart quantum-vault-daemon

# Test API
echo "🧪 Testing API..."
sleep 2
curl -s http://localhost:5100/api/stats | head -20

echo ""
echo "✅ Setup complete!"
echo ""
echo "Node is running with systemd"
echo "View logs: sudo journalctl -u quantum-vault-daemon -f"
echo "View status: sudo systemctl status quantum-vault-daemon --no-pager"
echo ""
echo "API accessible at: http://$(hostname -I | awk '{print $1}'):5100/api/stats"
echo ""
echo "Next steps:"
echo "1. Configure Nginx reverse proxy (optional)"
echo "2. Setup SSL with Let's Encrypt (optional)"
echo "3. Deploy frontend to Netlify"
echo "4. Update VITE_NODE_API_URL_TESTNET / VITE_NODE_API_URL_MAINNET in Netlify env vars"

# Quick Deployment Summary

## ✅ Yes, you can deploy on both!

- **Core Node**: Hostinger VPS ✅
- **Frontend**: Netlify ✅ (or same VPS)

## Architecture

```
┌─────────────────┐         ┌──────────────────┐
│   Netlify       │         │  Hostinger VPS   │
│   (Frontend)    │────────▶│  (Core Node)     │
│   - React UI    │  API    │  - Blockchain    │
│   - Free SSL    │  Calls  │  - Mining        │
│   - CDN         │         │  - P2P Network   │
└─────────────────┘         └──────────────────┘
```

## Quick Steps

### 1. Deploy Core Node on Hostinger VPS (5 minutes)

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Run the quick setup script
wget https://raw.githubusercontent.com/your-repo/quantum-vault/main/QUICK_START_VPS.sh
chmod +x QUICK_START_VPS.sh
./QUICK_START_VPS.sh

# Or manually:
cd /var/www/quantum-vault/core
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"
cargo build --release

# Run the daemon
./target/release/quantum-vault-daemon --host 0.0.0.0 --port 4100 --api-port 5100 --mine
```

### 2. Deploy Frontend on Netlify (3 minutes)

1. Push code to GitHub
2. Go to [netlify.com](https://netlify.com)
3. Import from GitHub
4. Build settings:
   - Build command: `npm run build`
   - Publish: `dist`
5. Add env vars:
   - `VITE_NODE_API_URL_TESTNET` = `http://your-vps-ip:5100/api`
   - `VITE_NODE_API_URL_MAINNET` = `https://your-mainnet-domain.com/api`
6. Deploy!

## Configuration

### Hostinger VPS
- Open ports: 4100 (P2P), 5100 (API)
- Core node runs 24/7 via systemd (recommended)
- Auto-restarts on reboot
- Optional API keys via `QV_API_KEYS` (comma-separated)

### Netlify
- Environment variables: `VITE_NODE_API_URL_TESTNET`, `VITE_NODE_API_URL_MAINNET`
- Auto-deploys on git push
- Free SSL included
- If API keys are enabled, set `VITE_CORE_API_KEY` for frontend calls

## Test Your Setup

```bash
# Test core node API
curl http://your-vps-ip:5100/api/stats

# Should return JSON with node stats
```

## Cost

- **Hostinger VPS**: ~$5-10/month (depends on plan)
- **Netlify**: FREE (for frontend hosting)
- **Total**: ~$5-10/month

## Benefits

✅ **Core node on VPS**: Always running, full control  
✅ **Frontend on Netlify**: Free, fast CDN, auto-deploy  
✅ **Separation**: Frontend can update without touching node  
✅ **Scalability**: Easy to add more nodes later

## Full Guides

- **Hostinger VPS**: See `DEPLOYMENT_HOSTINGER.md`
- **Netlify**: See `DEPLOYMENT_NETLIFY.md`
- **Quick Script**: See `QUICK_START_VPS.sh`

## Need Help?

Common issues:
- **Can't access API**: Check firewall, use `--host 0.0.0.0`
- **Build fails**: Check Rust toolchain installation
- **CORS errors**: Core node allows any origin by default

Your blockchain will be live in ~10 minutes! 🚀

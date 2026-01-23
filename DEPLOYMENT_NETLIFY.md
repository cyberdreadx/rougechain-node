# Deploying Frontend on Netlify

## Quick Setup

### Method 1: GitHub Integration (Recommended)

1. **Push your code to GitHub**
   ```bash
   git add .
   git commit -m "Ready for Netlify"
   git push origin main
   ```

2. **Connect to Netlify**
   - Go to [app.netlify.com](https://app.netlify.com)
   - Sign up/login
   - Click "Add new site" → "Import an existing project"
   - Choose "GitHub"
   - Authorize Netlify
   - Select your `quantum-vault` repository

3. **Configure Build Settings**
   ```
   Base directory: (leave empty)
   Build command: npm run build
   Publish directory: dist
   ```

4. **Add Environment Variables**
   - Go to Site settings → Environment variables
   - Click "Add variable"
   - Add:
     ```
     Key: VITE_NODE_API_URL_TESTNET
     Value: https://your-testnet-domain.com/api
     ```
     ```
     Key: VITE_NODE_API_URL_MAINNET
     Value: https://your-mainnet-domain.com/api
     ```
   - Or if using IP: `http://your-vps-ip:5100/api`

5. **Deploy**
   - Click "Deploy site"
   - Netlify will automatically build and deploy
   - Your site will be live at `https://your-site-name.netlify.app`

### Method 2: Netlify CLI

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login
netlify login

# Initialize (if first time)
netlify init

# Build
npm run build

# Deploy
netlify deploy --prod
```

### Method 3: Drag & Drop

1. Build locally:
   ```bash
   npm run build
   ```

2. Go to Netlify dashboard
3. Drag the `dist` folder to the deploy area
4. Add environment variable in site settings

## Environment Variables

**Required:**
- `VITE_NODE_API_URL_TESTNET` - Your testnet node API endpoint
- `VITE_NODE_API_URL_MAINNET` - Your mainnet node API endpoint

**Example values:**
```
# With domain
VITE_NODE_API_URL_TESTNET=https://testnet.rougechain.example.com/api
VITE_NODE_API_URL_MAINNET=https://mainnet.rougechain.example.com/api

# With IP (less secure, but works)
VITE_NODE_API_URL_TESTNET=http://123.456.789.0:5100/api
VITE_NODE_API_URL_MAINNET=http://123.456.789.1:5100/api
```

## Custom Domain (Optional)

1. Go to Site settings → Domain management
2. Click "Add custom domain"
3. Enter your domain
4. Follow DNS instructions
5. Netlify will provide SSL automatically

## Continuous Deployment

Netlify automatically deploys when you push to GitHub:
- Push to `main` branch → Production deploy
- Push to other branches → Preview deploy

## Build Optimization

Netlify will automatically:
- Install dependencies (`npm install`)
- Run build (`npm run build`)
- Deploy `dist` folder

## Troubleshooting

### Build Fails

Check build logs in Netlify dashboard:
- Common issue: Missing dependencies
- Solution: Ensure `package.json` has all deps

### API Not Working

- Check `VITE_NODE_API_URL_TESTNET` / `VITE_NODE_API_URL_MAINNET` are set correctly
- Verify your node is accessible from internet
- Check CORS settings on your node

### CORS Errors

If you see CORS errors, your node already has:
```typescript
res.setHeader("Access-Control-Allow-Origin", "*");
```

This should work, but if issues persist, update node to allow your Netlify domain specifically.

## Alternative: Vercel

Vercel works similarly:

```bash
npm install -g vercel
vercel
```

Follow prompts. Add `VITE_NODE_API_URL_TESTNET` / `VITE_NODE_API_URL_MAINNET` in Vercel dashboard.

## Alternative: Same VPS

You can also host frontend on the same VPS:

1. Build: `npm run build`
2. Serve with Nginx (see Hostinger guide)
3. Point domain to VPS

## Recommended Setup

**Best Practice:**
- **Node**: Hostinger VPS (always running)
- **Frontend**: Netlify (free, fast, auto-deploys)
- **Domain**: Point to Netlify (or VPS for frontend)

This gives you:
- ✅ Reliable node (VPS)
- ✅ Fast frontend (Netlify CDN)
- ✅ Auto-deployments (GitHub → Netlify)
- ✅ Free SSL (Netlify)
- ✅ Easy updates (just push to GitHub)

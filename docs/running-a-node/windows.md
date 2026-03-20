# Running a Node on Windows

A step-by-step guide for building and running a RougeChain node on Windows.

## Prerequisites

### 1. Install Rust

Download and run the installer from [rustup.rs](https://rustup.rs). Use the default options.

After installation, open a **new** PowerShell window and verify:

```powershell
cargo --version
rustc --version
```

### 2. Install Visual Studio Build Tools

Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and install the **"Desktop development with C++"** workload.

This provides the MSVC compiler and Windows SDK needed to build native Rust projects.

### 3. Install Git (if needed)

Download from [git-scm.com](https://git-scm.com/download/win) or install via winget:

```powershell
winget install Git.Git
```

---

## Build the Node

Open PowerShell and run:

```powershell
git clone https://github.com/cyberdreadx/rougechain-node.git
cd rougechain-node\core
cargo build --release -p quantum-vault-daemon
```

The first build takes 5-10 minutes. The binary will be at:

```
target\release\quantum-vault-daemon.exe
```

---

## Run the Node

### Connect to Testnet

```powershell
.\target\release\quantum-vault-daemon.exe --api-port 5100 --peers "https://testnet.rougechain.io/api"
```

### Run a Mining Node

```powershell
.\target\release\quantum-vault-daemon.exe --mine --api-port 5100 --peers "https://testnet.rougechain.io/api"
```

### Name Your Node

```powershell
.\target\release\quantum-vault-daemon.exe --api-port 5100 --node-name "MyWindowsNode" --peers "https://testnet.rougechain.io/api"
```

---

## Verify It's Working

In a separate PowerShell window:

```powershell
Invoke-RestMethod http://127.0.0.1:5100/api/health
```

Expected output:

```json
{
  "status": "ok",
  "chain_id": "rougechain-devnet-1",
  "height": 123
}
```

Visit `http://localhost:5100` in your browser to see the built-in node dashboard.

---

## Run as a Background Service

### Option A: Task Scheduler

1. Open **Task Scheduler** → Create Task
2. **General:** Name it "RougeChain Node", check "Run whether user is logged on or not"
3. **Trigger:** At startup
4. **Action:** Start a program
   - Program: `C:\path\to\quantum-vault-daemon.exe`
   - Arguments: `--mine --api-port 5100 --peers "https://testnet.rougechain.io/api"`
   - Start in: `C:\path\to\rougechain-node\core`
5. **Settings:** Check "Restart if task fails", set to every 1 minute

### Option B: NSSM (Non-Sucking Service Manager)

```powershell
# Install NSSM
winget install NSSM.NSSM

# Create the service
nssm install rougechain "C:\path\to\quantum-vault-daemon.exe"
nssm set rougechain AppParameters "--mine --api-port 5100 --peers ""https://testnet.rougechain.io/api"""
nssm set rougechain AppDirectory "C:\path\to\rougechain-node\core"

# Start
nssm start rougechain
```

---

## Windows Firewall

If you want your node to be publicly accessible:

```powershell
# Allow inbound connections to port 5100
New-NetFirewallRule -DisplayName "RougeChain Node" -Direction Inbound -Protocol TCP -LocalPort 5100 -Action Allow
```

---

## Docker Alternative

If you prefer Docker, install [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/) and run:

```powershell
docker run -d --name rougechain-node -p 5100:5100 -v qv-data:/data rougechain/node --mine --peers https://testnet.rougechain.io/api
```

---

## Troubleshooting

### "cargo not found"

Close and reopen PowerShell. Rust adds itself to PATH but it takes a new session to pick up.

### Build errors about MSVC

Make sure Visual Studio Build Tools is installed with the **C++ desktop workload**. Restart your terminal after installing.

### "Access denied" or antivirus blocking

- Run PowerShell as Administrator
- Add an antivirus exclusion for the `rougechain-node` directory
- Windows Defender may flag the newly built binary — allow it through

### Node doesn't respond

- Check Windows Firewall isn't blocking the port
- Make sure you're using `http://127.0.0.1:5100` (not `localhost`, which may resolve to IPv6)

---

## Updating

```powershell
cd rougechain-node
git pull
cd core
cargo build --release -p quantum-vault-daemon
# Restart the node
```

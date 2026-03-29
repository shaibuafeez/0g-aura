# 0g-aura

Decentralized AI coding agent powered by [0G Compute](https://0g.ai). Describe what you want to build, edit, or fix — aura streams responses from verifiable GPU providers and applies file changes directly to your project.

## Install

```bash
npm install -g 0g-aura
```

Or with npx (no install):

```bash
npx 0g-aura
```

Or clone and link locally:

```bash
git clone <repo-url>
cd 0g-aura
npm install
npm run build
npm link
```

## Setup

```bash
aura init
```

This walks you through wallet setup interactively:
1. **Create a new wallet** or **import an existing private key**
2. Choose where to save (`./.env` or `~/.aura/.env` for global)
3. Checks your A0GI balance automatically

You need A0GI tokens to pay for decentralized compute. Get them at [portal.0g.ai](https://portal.0g.ai).

## Usage

```bash
# Start in current directory with default model
aura

# Choose a model
aura -m deepseek-chat-v3-0324

# Target a specific project directory
aura -d ./my-project

# Skip apply confirmations
aura --no-confirm
```

Inside the TUI, type a prompt and press Enter. Aura will:

1. Read your project files for context
2. Stream a response from a 0G compute provider in real-time
3. Show a diff of proposed changes
4. Ask for confirmation before writing files

## CLI Flags

| Flag | Description |
|------|-------------|
| `-m, --model <name>` | Model to use (default: `GLM-5-FP8`) |
| `-d, --dir <path>` | Project directory (default: cwd) |
| `--no-confirm` | Apply changes without confirmation |
| `-V, --version` | Show version |
| `-h, --help` | Show help |

## Slash Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model <name>` | Switch AI model |
| `/add <path>` | Add a file to prompt context |
| `/remove <path\|all>` | Remove file(s) from context |
| `/files` | Show detected project tree |
| `/status` | Check 0G Compute connectivity |
| `/balance` | Check wallet A0GI balance |
| `/undo` | Revert the last applied file changes |
| `/export [file]` | Save conversation to markdown |
| `/cost` | Show session token usage |
| `/clear` | Clear conversation history |
| `/quit` | Exit |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send prompt / confirm apply |
| `Esc` | Clear input / reject apply |
| `Up/Down` | Recall previous prompts |
| `Shift+Up/Down` | Scroll conversation |
| `PageUp/PageDown` | Scroll fast |
| `Home/End` | Jump to oldest/latest |
| `Ctrl+C` | Exit |

## Models

| Model | Description |
|-------|-------------|
| `GLM-5-FP8` | Default, fast general-purpose |
| `deepseek-chat-v3-0324` | DeepSeek v3 |
| `gpt-oss-120b` | 120B open-source |
| `qwen3-vl-30b-a3b-instruct` | Qwen3 multimodal |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ZG_PRIVATE_KEY` | *(required)* | 0G wallet private key |
| `ZG_RPC_URL` | `https://evmrpc.0g.ai` | 0G RPC endpoint |
| `ZG_AUTO_DISCOVER_PROVIDER` | `true` | Auto-discover compute providers |
| `ZG_PROVIDER_ADDRESS` | — | Pin a specific provider (skips discovery) |

Config is loaded from `./.env` first, then `~/.aura/.env` as fallback. Run `aura init` to create one.

## How It Works

Aura connects to the [0G decentralized compute network](https://0g.ai) through the `@0glabs/0g-serving-broker` SDK. When you send a prompt:

1. **Context assembly** — scans your project tree and reads key files (with automatic token budget management)
2. **Provider discovery** — finds an available GPU provider serving your chosen model (or uses a pinned address)
3. **Streaming inference** — sends your conversation + project context to the provider and streams the response in real-time
4. **Parsing** — extracts file changes and shell commands from the model output
5. **Apply** — shows a diff preview, then writes files and runs commands on confirmation (with `/undo` support)

All inference runs on decentralized, verifiable GPU providers — no centralized API keys needed, just an 0G wallet with A0GI tokens.

## License

MIT

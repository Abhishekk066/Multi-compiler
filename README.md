# Multi-Language Online Compiler

A browser-based code editor and runner supporting 11 programming languages, with real-time terminal output, AI assistance, and shareable code snippets.

## Features

- **18 languages** — C++, C, Java, Python, JavaScript, TypeScript, Go, Ruby, PHP, Kotlin, Bash, Rust, C#, Perl, Lua, R, HTML, SQL
- **Real-time execution** via WebSocket — streaming stdout/stderr and interactive stdin
- **AI assistance** (powered by Ollama) — fix broken code or generate code from a prompt
- **Code sharing** — generate a shareable URL or QR code for any snippet
- **CodeMirror** editor with syntax highlighting
- **xterm.js** terminal for output

## Tech Stack

| Layer | Tech |
|---|---|
| Server | Node.js, Express |
| Real-time | WebSocket (`ws`) |
| Editor | CodeMirror 5 |
| Terminal | xterm.js |
| AI | Ollama (`qwen2.5-coder:3b`) |
| Container | Docker + Ubuntu 24.04 |

## Getting Started

### Prerequisites

Install the language runtimes you need:

```
gcc / g++   — C, C++
java / javac — Java
python3     — Python
node        — JavaScript
tsx         — TypeScript (installed via npm)
go          — Go
ruby        — Ruby
php         — PHP
kotlinc     — Kotlin
bash        — Bash
rustc       — Rust
mcs + mono  — C# (Mono)
perl        — Perl
lua5.4      — Lua
Rscript     — R
            — HTML (browser preview, no backend tool needed)
mysql       — SQL (MySQL 8)
```

Or just use Docker (see below).

### Local development

```bash
npm install
npm run dev      # nodemon, auto-restarts on changes
```

The server starts on port `6600` by default.

### Environment variables

Copy `.env` and adjust as needed:

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `6600` |
| `NODE_ENV` | `development` or `production` | `development` |
| `OLLAMA_HOST` | Ollama API base URL | — |
| `OLLAMA_MODEL` | Model to use for AI features | `qwen2.5-coder:3b` |
| `MAIN_DOMAIN` | Public domain for share links | `https://compiler.abhishekdev.cloud` |
| `REQUESTED_DOMAIN` | Partner domain for `/send-url` | — |
| `OBFUSCATE_ON_START` | Obfuscate `public/script.js` on startup | `false` |
| `MYSQL_HOST` | MySQL host for SQL runner | `127.0.0.1` |
| `MYSQL_PORT` | MySQL port | `3306` |
| `MYSQL_USER` | MySQL user | `root` |
| `MYSQL_PASSWORD` | MySQL password | — |
| `MYSQL_DATABASE` | MySQL database | `sandbox` |

### Docker

```bash
docker compose up --build
```

The Dockerfile installs all supported runtimes (GCC, JDK, Go, Python 3, Ruby, PHP, Node.js 22, Kotlin) and uses `mold` as a faster linker for C/C++.

## API Reference

### Code routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/generate-url` | Cache code and return a shareable URL |
| `POST` | `/generate-qrcode` | Generate a QR code for a URL |
| `POST` | `/send-url` | Fetch code from partner domain and cache it |
| `GET/POST` | `/code/share/:id` | Retrieve cached snippet by ID |
| `GET/POST` | `/code/c/:id` | Retrieve snippet (short link) |
| `GET/POST` | `/default-code` | Return the default starter snippet for a language |
| `GET` | `/languages` | List all supported languages |

### AI routes (`/api/ai`)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/fix-code` | `{ code, language, error? }` | Return fixed code |
| `POST` | `/write-code` | `{ prompt, language }` | Generate code from a natural-language prompt |

### WebSocket

Connect to `ws://<host>` and send JSON messages:

```json
// Run code
{ "type": "code", "language": "python", "code": "print('hello')" }

// Send stdin input to a running process
{ "type": "input", "input": "Alice\n" }
```

Server sends back messages with `type`: `running` | `output` | `stderr` | `compiled` | `error` | `finished`.

## Supported Languages

| Language | Compiler / Runtime |
|---|---|
| C++ | `g++` (-std=c++17) |
| C | `gcc` |
| Java | `javac` + `java` |
| Python | `python3` |
| JavaScript | `node` |
| TypeScript | `tsx` |
| Go | `go run` |
| Ruby | `ruby` |
| PHP | `php` |
| Kotlin | `kotlinc` + `java` |
| Bash | `bash` |
| Rust | `rustc` |
| C# | `mcs` + `mono` |
| Perl | `perl` |
| Lua | `lua5.4` |
| R | `Rscript` |
| HTML | browser preview (Blob URL iframe) |
| SQL | `mysql` CLI (MySQL 8) |

## URL patterns

| Pattern | Description |
|---|---|
| `/:lang-programming` | Language-specific landing page (e.g. `/python-programming`) |
| `/share/:id` | Open a shared snippet |
| `/c/:id` | Open a short-link snippet |

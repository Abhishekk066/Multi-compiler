import { spawn } from "child_process";
import crypto from "crypto";
import { existsSync, mkdirSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { performance } from "perf_hooks";
import { fileURLToPath } from "url";

const wsConnections = new Map();
const WS_MAX_PER_IP = 5;
const WS_WINDOW_MS = 60_000;

function wsRateCheck(ip) {
  const now = Date.now();
  const entry = wsConnections.get(ip) || {
    count: 0,
    reset: now + WS_WINDOW_MS,
  };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + WS_WINDOW_MS;
  }
  entry.count++;
  wsConnections.set(ip, entry);
  return entry.count <= WS_MAX_PER_IP;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.join(__dirname, "..");

function commandExists(command) {
  const pathEnv = process.env.PATH || "";
  const pathExt =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return pathEnv
    .split(path.delimiter)
    .some((dir) =>
      pathExt.some((ext) => existsSync(path.join(dir, `${command}${ext}`))),
    );
}

const USE_MOLD = commandExists("mold");

function cc(compiler, args) {
  return USE_MOLD ? ["mold", ["-run", compiler, ...args]] : [compiler, args];
}

const JVM_FAST_FLAGS = ["-XX:TieredStopAtLevel=1", "-XX:+UseSerialGC"];

const LANGUAGES = {
  cpp: {
    ext: ".cpp",
    compile: (src, out) => cc("g++", [src, "-o", out, "-std=c++17", "-pipe"]),
    run: (_src, out) => [out, []],
  },

  c: {
    ext: ".c",
    compile: (src, out) => cc("gcc", [src, "-o", out, "-lm", "-pipe"]),
    run: (_src, out) => [out, []],
  },

  java: {
    ext: ".java",
    compile: (src, out) => ["javac", ["-d", out, src]],
    run: (_src, out) => [
      "java",
      [...JVM_FAST_FLAGS, "-Xss512k", "-cp", out, "Main"],
    ],
  },

  go: {
    ext: ".go",
    run: (src) => ["go", ["run", src]],
  },

  kotlin: {
    ext: ".kt",
    compile: (src, out) => [
      "kotlinc",
      [src, "-include-runtime", "-d", `${out}.jar`],
    ],
    run: (_src, out) => ["java", [...JVM_FAST_FLAGS, "-Xss4m", "-jar", out]],
    extraOut: (out) => `${out}.jar`,
  },

  python: {
    ext: ".py",
    inlineCode: true,
    run: (_src, _out, code) => ["python3", ["-u", "-c", code]],
  },

  javascript: {
    ext: ".cjs",
    inlineCode: true,
    closeStdinAfterInput: true,
    run: (_src, _out, code) => ["node", ["-e", code]],
  },

  typescript: {
    ext: ".ts",
    run: (src) => [path.join(ROOT_DIR, "node_modules/.bin/tsx"), [src]],
    closeStdinAfterInput: true,
  },

  ruby: {
    ext: ".rb",
    inlineCode: true,
    run: (_src, _out, code) => ["ruby", ["-e", `$stdout.sync=true\n${code}`]],
  },

  php: {
    ext: ".php",
    run: (src) => [
      "php",
      ["-d", "output_buffering=Off", "-d", "implicit_flush=1", src],
    ],
  },

  bash: {
    ext: ".sh",
    inlineCode: true,
    run: (_src, _out, code) => ["bash", ["-c", code]],
  },

  rust: {
    ext: ".rs",
    compile: (src, out) => ["rustc", [src, "-o", out, "-C", "debuginfo=0"]],
    run: (_src, out) => [out, []],
  },

  csharp: {
    ext: ".cs",
    compile: (src, out) => ["mcs", [`-out:${out}.exe`, src]],
    run: (_src, out) => ["mono", [out]],
    extraOut: (out) => `${out}.exe`,
  },

  perl: {
    ext: ".pl",
    inlineCode: true,
    run: (_src, _out, code) => ["perl", ["-e", `$|=1;\n${code}`]],
  },

  lua: {
    ext: ".lua",
    run: (src) => ["lua", [src]],
  },

  r: {
    ext: ".r",
    run: (src) => ["Rscript", ["--vanilla", src]],
  },

  sql: {
    ext: ".sql",
    run: (src) => {
      const host = process.env.MYSQL_HOST || "127.0.0.1";
      const port = process.env.MYSQL_PORT || "3306";
      const user = process.env.MYSQL_USER || "root";
      const db = process.env.MYSQL_DATABASE || "sandbox";
      return [
        "bash",
        [
          "-c",
          `mysql -t --connect-timeout=5 -h "${host}" -P "${port}" -u "${user}" "${db}" < "${src}"`,
        ],
      ];
    },
  },
};

function normalizeLanguage(language = "cpp") {
  const lang = String(language).toLowerCase().trim();

  const aliases = {
    "c++": "cpp",
    cpp: "cpp",
    cplusplus: "cpp",
    "c plus plus": "cpp",

    c: "c",

    java: "java",

    py: "python",
    python: "python",

    js: "javascript",
    javascript: "javascript",

    ts: "typescript",
    typescript: "typescript",

    go: "go",
    golang: "go",

    kt: "kotlin",
    kotlin: "kotlin",

    rb: "ruby",
    ruby: "ruby",

    php: "php",

    sh: "bash",
    shell: "bash",
    bash: "bash",

    rs: "rust",
    rust: "rust",

    cs: "csharp",
    csharp: "csharp",
    "c#": "csharp",
    dotnet: "csharp",

    pl: "perl",
    perl: "perl",

    lua: "lua",

    r: "r",
    rscript: "r",

    sql: "sql",
    mysql: "sql",
    sqlite: "sql",
  };

  return aliases[lang] || "cpp";
}

function normalizeBashCode(code) {
  if (!code) return "";

  let fixedCode = String(code);

  fixedCode = fixedCode.replace(
    /read\s+-p\s+["']([^"']*)["']\s+([a-zA-Z_]\w*)/g,
    'printf "$1"\nread $2',
  );

  return fixedCode;
}

async function deleteFileIfExists(filePath) {
  try {
    await fs.access(filePath);
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Delete file error:", err);
    }
  }
}

async function deleteDirIfExists(dirPath) {
  try {
    await fs.rm(dirPath, {
      recursive: true,
      force: true,
    });
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Delete dir error:", err);
    }
  }
}

function cleanCompileError(errorText, langExt) {
  return String(errorText || "")
    .split("\n")
    .map((line) => line.replace(/^.*?tmp\/[^\s:]+/, `main${langExt}`))
    .join("\r\n");
}

function prepareRunCommand(cmd, args) {
  if (process.platform !== "win32" && commandExists("stdbuf")) {
    return ["stdbuf", ["-o0", "-e0", cmd, ...args]];
  }

  return [cmd, args];
}

function getRuntimeEnv(langKey) {
  const env = { ...process.env };

  if (langKey === "python") {
    env.PYTHONUNBUFFERED = "1";
  }

  if (langKey === "sql" && process.env.MYSQL_PASSWORD) {
    env.MYSQL_PWD = process.env.MYSQL_PASSWORD;
  }

  if (langKey === "go") {
    env.GOTMPDIR = "/app/tmp";
    env.GOCACHE = "/app/tmp/go-cache";
  }

  return env;
}

/**
 * @param {import('ws').WebSocketServer} wss
 */
const binDir = "/app/tmp";
try {
  mkdirSync(binDir, { recursive: true });
} catch (_) {}

export function setupCompilerWS(wss) {
  wss.on("connection", async (ws, req) => {
    const ip =
      req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      "unknown";
    if (!wsRateCheck(ip)) {
      ws.close(1008, "Too many connections");
      return;
    }
    const clientId = crypto.randomUUID();
    const tmpDir = os.tmpdir();

    let activeProcess = null;
    let executionStartTime = null;
    let currentSourceFile = null;
    let currentOutputFile = null;
    let currentExtraOut = null;
    let currentJavaDir = null;
    let currentLangKey = null;
    let activeRunId = null;

    function safeSend(payload) {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    }

    async function cleanupCurrentFiles() {
      if (currentSourceFile) await deleteFileIfExists(currentSourceFile);
      if (currentOutputFile) await deleteFileIfExists(currentOutputFile);
      if (currentExtraOut) await deleteFileIfExists(currentExtraOut);
      if (currentJavaDir) await deleteDirIfExists(currentJavaDir);

      currentSourceFile = null;
      currentOutputFile = null;
      currentExtraOut = null;
      currentJavaDir = null;
      currentLangKey = null;
      activeRunId = null;
    }

    const MAX_EXEC_MS = 30_000;

    function spawnRunProcess(cmd, args, langKey, runId) {
      const [finalCmd, finalArgs] = prepareRunCommand(cmd, args);

      let proc;

      try {
        proc = spawn(finalCmd, finalArgs, {
          stdio: ["pipe", "pipe", "pipe"],
          env: getRuntimeEnv(langKey),
        });
      } catch (err) {
        safeSend({
          type: "error",
          runId,
          message: `Runtime not found: ${finalCmd}.\r\n${err.message}`,
        });
        return;
      }

      activeProcess = proc;
      activeRunId = runId;
      executionStartTime = performance.now();

      const killTimer = setTimeout(() => {
        if (activeRunId === runId && activeProcess) {
          activeProcess.kill();
          safeSend({
            type: "stderr",
            runId,
            message: "\r\n\x1b[33mExecution timed out (30s limit).\x1b[0m\r\n",
          });
        }
      }, MAX_EXEC_MS);

      proc.on("close", () => clearTimeout(killTimer));
      proc.on("error", () => clearTimeout(killTimer));

      safeSend({
        type: "running",
        runId,
        message: "Running...",
      });

      proc.stdout.on("data", (output) => {
        safeSend({
          type: "output",
          runId,
          message: output.toString().replace(/\r?\n/g, "\r\n"),
        });
      });

      proc.stderr.on("data", (error) => {
        safeSend({
          type: "stderr",
          runId,
          message: error.toString().replace(/\r?\n/g, "\r\n"),
        });
      });

      proc.on("error", (err) => {
        safeSend({
          type: "error",
          runId,
          message: `Failed to start: ${finalCmd}.\r\n${err.message}`,
        });

        activeProcess = null;
        activeRunId = null;
      });

      proc.on("close", (exitCode) => {
        if (activeRunId !== runId) return;

        activeProcess = null;
        activeRunId = null;

        const executionTime = executionStartTime
          ? ((performance.now() - executionStartTime) / 1000).toFixed(2)
          : "0.00";

        safeSend({
          type: "finished",
          runId,
          timer: executionTime,
          exitCode: exitCode !== null ? exitCode : -1,
          message: "Execution Finished.",
        });
      });
    }

    async function compileCode({
      lang,
      langKey,
      sourceFile,
      outputFile,
      javaOutDir,
    }) {
      await deleteFileIfExists(outputFile);

      if (currentExtraOut) {
        await deleteFileIfExists(currentExtraOut);
      }

      const compileOut = langKey === "java" ? javaOutDir : outputFile;

      if (langKey === "java" && !existsSync(javaOutDir)) {
        await fs.mkdir(javaOutDir, { recursive: true });
      }

      const [compileCmd, compileArgs] = lang.compile(sourceFile, compileOut);

      const MAX_BUF = 65_536;

      return new Promise((resolve) => {
        let compileError = "";
        let compileOutput = "";

        const compile = spawn(compileCmd, compileArgs, {
          stdio: ["ignore", "pipe", "pipe"],
        });

        compile.stderr.on("data", (err) => {
          if (compileError.length < MAX_BUF) compileError += err.toString();
        });

        compile.stdout.on("data", (data) => {
          if (compileOutput.length < MAX_BUF) compileOutput += data.toString();
        });

        compile.on("close", async (code) => {
          if (code !== 0) {
            const cleanError = cleanCompileError(compileError, lang.ext);

            safeSend({
              type: "error",
              message: cleanError || compileOutput || "Compilation failed.",
            });

            resolve(false);
            return;
          }

          if (langKey !== "java") {
            try {
              await fs.chmod(outputFile, 0o755);
            } catch (_) {}
          }

          resolve(true);
        });

        compile.on("error", (err) => {
          safeSend({
            type: "error",
            message: `Compiler not found: ${compileCmd}.\r\nMake sure it is installed.\r\n${err.message}`,
          });

          resolve(false);
        });
      });
    }

    function sendInputToProcess(inputValue) {
      if (!activeProcess) {
        safeSend({
          type: "error",
          message: "No running program to receive input.",
        });
        return;
      }

      try {
        const input = String(inputValue ?? "");

        if (input.replace(/\r?\n$/, "") === "") {
          return;
        }

        const inputLine = input.endsWith("\n") ? input : `${input}\n`;
        const currentLang = LANGUAGES[currentLangKey];

        activeProcess.stdin.write(inputLine, (writeError) => {
          if (writeError) {
            safeSend({
              type: "error",
              runId: activeRunId,
              message: "Failed to send input to running program.",
            });
            return;
          }

          if (
            currentLang?.closeStdinAfterInput &&
            activeProcess?.stdin?.writable
          ) {
            activeProcess.stdin.end();
          }
        });
      } catch (err) {
        safeSend({
          type: "error",
          message: "Failed to send input to running program.",
        });
      }
    }

    ws.on("message", async (message) => {
      try {
        const data = JSON.parse(message);

        if (data.type === "code") {
          if (activeProcess) {
            activeProcess.kill();
            activeProcess = null;
            activeRunId = null;
          }

          await cleanupCurrentFiles();

          const langKey = normalizeLanguage(data.language || "cpp");
          const lang = LANGUAGES[langKey];

          if (!lang) {
            safeSend({
              type: "error",
              message: `Unsupported language: "${langKey}".\r\nSupported: ${Object.keys(
                LANGUAGES,
              ).join(", ")}`,
            });
            return;
          }

          currentLangKey = langKey;
          const runId = crypto.randomUUID();

          let sourceCode = String(data.code || "");

          if (langKey === "bash") {
            sourceCode = normalizeBashCode(sourceCode);
          }

          if (langKey === "r") {
            sourceCode =
              '.stdin_con <- file("stdin", open = "r")\nstdin <- function() .stdin_con\n' +
              sourceCode;
          }

          // Inline execution: pass code directly, no file written
          if (lang.inlineCode) {
            const [runCmd, runArgs] = lang.run(null, null, sourceCode);
            spawnRunProcess(runCmd, runArgs, langKey, runId);
            return;
          }

          // File-based execution: write source to tmpdir
          const javaOutDir = path.join(tmpDir, `java_${clientId}`);
          const baseName = langKey === "java" ? "Main" : `code_${clientId}`;
          const sourceDir = langKey === "java" ? javaOutDir : tmpDir;
          const sourceFile = path.join(sourceDir, `${baseName}${lang.ext}`);
          const outputFile = path.join(binDir, `code_${clientId}.out`);

          currentSourceFile = sourceFile;
          currentOutputFile = outputFile;
          currentExtraOut = lang.extraOut ? lang.extraOut(outputFile) : null;
          currentJavaDir = langKey === "java" ? javaOutDir : null;

          if (langKey === "java" && !existsSync(sourceDir)) {
            await fs.mkdir(sourceDir, { recursive: true });
          }

          await fs.writeFile(sourceFile, sourceCode, "utf8");

          if (lang.compile) {
            const compileOk = await compileCode({
              lang,
              langKey,
              sourceFile,
              outputFile,
              javaOutDir,
            });

            if (!compileOk) return;

            safeSend({
              type: "compiled",
              message: "Compiled Successfully!",
            });

            const runOut =
              langKey === "java" ? javaOutDir : currentExtraOut || outputFile;

            const [runCmd, runArgs] = lang.run(sourceFile, runOut);
            spawnRunProcess(runCmd, runArgs, langKey, runId);
            return;
          }

          const [runCmd, runArgs] = lang.run(sourceFile, outputFile);
          spawnRunProcess(runCmd, runArgs, langKey, runId);
          return;
        }

        if (data.type === "input") {
          sendInputToProcess(data.input);
        }
      } catch (err) {
        console.error("Compiler WS Error:", err);

        if (activeProcess) {
          activeProcess.kill();
          activeProcess = null;
          activeRunId = null;
        }

        safeSend({
          type: "error",
          message: "Internal Server Error",
        });
      }
    });

    ws.on("close", async () => {
      if (activeProcess) {
        activeProcess.kill();
        activeProcess = null;
        activeRunId = null;
      }

      await cleanupCurrentFiles();
    });
  });
}

/**
 * Cleanup temp files on process exit.
 */
export function setupCleanup() {
  async function cleanupTmpAndExit() {
    const tmpDir = os.tmpdir();

    try {
      const files = await fs.readdir(tmpDir);

      for (const file of files) {
        if (
          file.startsWith("code_") ||
          file.startsWith("Main") ||
          file.startsWith("java_")
        ) {
          const fullPath = path.join(tmpDir, file);
          const stat = await fs.stat(fullPath).catch(() => null);

          if (stat) {
            if (stat.isDirectory()) {
              await deleteDirIfExists(fullPath);
            } else {
              await deleteFileIfExists(fullPath);
            }
          }
        }
      }
    } catch (err) {
      console.error("Cleanup Error:", err);
    }

    process.exit();
  }

  process.on("SIGINT", cleanupTmpAndExit);
  process.on("SIGTERM", cleanupTmpAndExit);
}

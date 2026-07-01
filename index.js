import cors from "cors";
import "dotenv/config";
import EventEmitter from "events";
import express from "express";
import rateLimit from "express-rate-limit";
import { readFile } from "fs/promises";
import helmet from "helmet";
import http from "http";
import NodeCache from "node-cache";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

import aiRoutes from "./routes/ai.js";
import createCodeRouter from "./routes/code.js";
import { obfuscateScript } from "./utils/obfuscator.js";
import { setupCleanup, setupCompilerWS } from "./ws/compiler.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

EventEmitter.defaultMaxListeners = 60;

function stdinFaq(label, keyword) {
  return {
    q: `Does it support user input (stdin)?`,
    a: `Yes — CompileAny provides a live xterm.js terminal with full stdin/stdout support, so ${label} programs that read user input${keyword ? ` via ${keyword}` : ""} work exactly as they would locally.`,
  };
}

function freeFaq(label) {
  return {
    q: `Is the ${label} online compiler free to use?`,
    a: `Yes. CompileAny's ${label} compiler is completely free, with no signup, subscription, or installation required.`,
  };
}

const LANG_META = {
  cpp: {
    label: "C++",
    desc: "C++ Online Compiler: Write, compile, and run C++ code online for free. Instant compilation, real-time interactive terminal, and AI assistant.",
    about:
      "C++ is a compiled, high-performance language widely used in competitive programming, game engines, and systems software. CompileAny compiles your code with g++ and streams the output to a live terminal, so you can test algorithms and DSA problems without setting up a local toolchain.",
    faq: [
      freeFaq("C++"),
      {
        q: "Which C++ compiler does CompileAny use?",
        a: "CompileAny compiles C++ using g++ inside an isolated Linux container, giving you standard GCC behavior — the same compiler used by most competitive programming judges.",
      },
      stdinFaq("C++", "cin"),
    ],
  },
  c: {
    label: "C",
    desc: "C Online Compiler: Write, compile, and run C code online. Sandboxed GCC compiler, live terminal, and interactive stdin support.",
    about:
      "C is the foundational systems language behind operating systems, embedded firmware, and countless compilers. CompileAny runs your C code through gcc in an isolated Linux container, so you get standard, predictable compiler behavior for learning pointers, memory management, and data structures.",
    faq: [
      freeFaq("C"),
      {
        q: "Which C compiler does CompileAny use?",
        a: "C code is compiled with gcc, the same industry-standard compiler used in most Linux environments.",
      },
      stdinFaq("C", "scanf"),
    ],
  },
  java: {
    label: "Java",
    desc: "Java Online Compiler: Compile and run Java code online. Free browser-based Java compiler using standard OpenJDK JVM with full console I/O.",
    about:
      "Java powers everything from Android apps to enterprise backends. CompileAny compiles your code with javac and runs it on the JVM, giving you real bytecode execution and full console I/O — ideal for practicing OOP, DSA, and interview problems.",
    faq: [
      freeFaq("Java"),
      {
        q: "Which Java version does CompileAny use?",
        a: "Java code is compiled with javac and executed on a standard JVM (OpenJDK default-jdk), matching typical classroom and interview environments.",
      },
      stdinFaq("Java", "Scanner"),
    ],
  },
  python: {
    label: "Python",
    desc: "Python Online Compiler: Execute Python 3 scripts in your browser instantly. Free online Python interpreter with live stdin/stdout streaming.",
    about:
      "Python is the go-to language for scripting, data science, and quick prototyping thanks to its readable syntax. CompileAny runs your code with the Python 3 interpreter and streams output live, so loops, input(), and print statements behave exactly as they would locally.",
    faq: [
      freeFaq("Python"),
      {
        q: "Which Python version does CompileAny use?",
        a: "Code runs on Python 3 (CPython) inside an isolated container — no virtual environment setup needed.",
      },
      stdinFaq("Python", "input()"),
    ],
  },
  javascript: {
    label: "JavaScript",
    desc: "JavaScript Online Compiler: Write and run Node.js JavaScript online. Modern Node.js runtime with instant output and interactive console.",
    about:
      "JavaScript is the language of the web, and increasingly of the backend through Node.js. CompileAny executes your code on Node.js, so you can test async/await, array methods, and vanilla JS logic instantly without opening a browser console.",
    faq: [
      freeFaq("JavaScript"),
      {
        q: "Which JavaScript runtime does CompileAny use?",
        a: "JavaScript runs on Node.js 22 LTS, giving you a modern, spec-compliant runtime with full console output support.",
      },
      stdinFaq("JavaScript", "readline"),
    ],
  },
  typescript: {
    label: "TypeScript",
    desc: "TypeScript Online Compiler: Transpile and run TypeScript code online. Execute TS scripts directly using tsx compiler without setup.",
    about:
      "TypeScript adds static typing on top of JavaScript, catching errors before they hit runtime. CompileAny transpiles and executes your TypeScript directly, so you can test typed functions, interfaces, and generics without a separate build step.",
    faq: [
      freeFaq("TypeScript"),
      {
        q: "How does CompileAny run TypeScript without a build step?",
        a: "TypeScript is executed directly using tsx, which compiles and runs your .ts code in one step — no tsconfig setup required.",
      },
      stdinFaq("TypeScript", "readline"),
    ],
  },
  go: {
    label: "Go",
    desc: "Go Online Compiler: Write, compile, and execute Go (Golang) code online. Sandboxed go build toolchain with instant live streaming.",
    about:
      "Go is prized for its simplicity, fast compilation, and strong concurrency model via goroutines. CompileAny compiles and runs your Go code instantly, making it easy to test functions, structs, and channels without installing the Go toolchain locally.",
    faq: [
      freeFaq("Go"),
      {
        q: "Which Go compiler does CompileAny use?",
        a: "Go code is compiled using the standard go build toolchain inside a sandboxed container.",
      },
      stdinFaq("Go", "fmt.Scan"),
    ],
  },
  kotlin: {
    label: "Kotlin",
    desc: "Kotlin Online Compiler: Compile and run Kotlin programs online. Sandboxed OpenJDK runtime supporting clean modern Kotlin.",
    about:
      "Kotlin is the modern, concise language for Android and JVM development, fully interoperable with Java. CompileAny compiles your Kotlin code with kotlinc and runs it on the JVM, so you can try coroutines, null-safety, and extension functions instantly.",
    faq: [
      freeFaq("Kotlin"),
      {
        q: "Which Kotlin version does CompileAny use?",
        a: "Kotlin is compiled with kotlinc 2.0.21, a recent stable release, and executed on the JVM.",
      },
      stdinFaq("Kotlin", "readLine()"),
    ],
  },
  ruby: {
    label: "Ruby",
    desc: "Ruby Online Compiler: Execute Ruby scripts online in your browser. Standard ruby interpreter for fast coding and testing.",
    about:
      "Ruby is known for its elegant, human-readable syntax and is the backbone of the Rails framework. CompileAny runs your Ruby scripts through the standard ruby interpreter, ideal for quick scripting practice or testing Rails-style logic in isolation.",
    faq: [
      freeFaq("Ruby"),
      {
        q: "Which Ruby interpreter does CompileAny use?",
        a: "Ruby scripts run on the standard MRI ruby interpreter included in the execution container.",
      },
      stdinFaq("Ruby", "gets"),
    ],
  },
  php: {
    label: "PHP",
    desc: "PHP Online Compiler: Write and execute PHP scripts online via the php-cli interpreter. Test PHP functions instantly.",
    about:
      "PHP powers a huge share of the web, from WordPress to custom backends. CompileAny executes your PHP code with the php-cli interpreter, so you can test functions, arrays, and string handling without configuring a local web server.",
    faq: [
      freeFaq("PHP"),
      {
        q: "Which PHP runtime does CompileAny use?",
        a: "PHP code runs via the php-cli interpreter — the same engine used for command-line PHP scripts in production servers.",
      },
      stdinFaq("PHP", "fgets(STDIN)"),
    ],
  },
  bash: {
    label: "Bash",
    desc: "Bash Online Compiler: Run shell scripts online. Interactive standard bash environment for practicing script automation.",
    about:
      "Bash scripting is essential for automation, DevOps, and Linux system administration. CompileAny runs your shell scripts in a real bash environment, letting you test loops, pipes, and conditionals exactly as they'd behave on a Linux server.",
    faq: [
      freeFaq("Bash"),
      {
        q: "Which shell does CompileAny use for Bash?",
        a: "Scripts run in a genuine bash shell inside the container — the same shell used on most Linux servers.",
      },
      stdinFaq("Bash", "read"),
    ],
  },
  rust: {
    label: "Rust",
    desc: "Rust Online Compiler: Compile and execute Rust code online. Fast rustc compiler sandbox for learning Rust safety.",
    about:
      "Rust delivers C++-level performance with memory safety guaranteed at compile time, making it popular for systems programming and WebAssembly. CompileAny compiles your Rust code with rustc, so you can test ownership, borrowing, and match expressions instantly.",
    faq: [
      freeFaq("Rust"),
      {
        q: "Which Rust compiler does CompileAny use?",
        a: "Rust code is compiled using rustc, the official Rust compiler, inside an isolated sandbox.",
      },
      stdinFaq("Rust", "std::io::stdin"),
    ],
  },
  csharp: {
    label: "C#",
    desc: "C# Online Compiler: Write and run C# code online. Sandboxed .NET/Mono environment for practicing C# coding.",
    about:
      "C# is the primary language for .NET applications, game development, and enterprise software. CompileAny compiles and runs your C# code using the Mono toolchain, so you can test classes, LINQ, and console I/O without installing Visual Studio.",
    faq: [
      freeFaq("C#"),
      {
        q: "Which C# runtime does CompileAny use?",
        a: "C# code is compiled and executed using Mono (mcs/mono) rather than the full .NET SDK — ideal for standard console-based C# and classic .NET syntax.",
      },
      stdinFaq("C#", "Console.ReadLine"),
    ],
  },
  perl: {
    label: "Perl",
    desc: "Perl Online Compiler: Run Perl scripts online. Fast text processing interpreter for script testing.",
    about:
      "Perl remains a powerful tool for text processing, system administration, and legacy codebases. CompileAny runs your Perl scripts through the standard perl interpreter, making it easy to test regex, string manipulation, and one-liners.",
    faq: [
      freeFaq("Perl"),
      {
        q: "Which Perl interpreter does CompileAny use?",
        a: "Scripts run on the standard perl interpreter included in the Linux container.",
      },
      stdinFaq("Perl", "STDIN"),
    ],
  },
  lua: {
    label: "Lua",
    desc: "Lua Online Compiler: Execute Lua scripts online in your browser. Sandboxed Lua 5.4 environment.",
    about:
      "Lua is a lightweight, embeddable scripting language popular in game development and embedded systems. CompileAny runs your Lua code with Lua 5.4, giving you fast, sandboxed execution for testing scripts and game logic.",
    faq: [
      freeFaq("Lua"),
      {
        q: "Which Lua version does CompileAny use?",
        a: "Lua code runs on Lua 5.4, a specific version pinned in the execution environment for consistent behavior.",
      },
      stdinFaq("Lua", "io.read"),
    ],
  },
  r: {
    label: "R",
    desc: "R Online Compiler: Write and run R code online for free. Instant R interpreter with real-time output.",
    about:
      "R is the language of choice for statistical computing and data visualization. CompileAny executes your R scripts with Rscript, so you can test data manipulation, vectors, and statistical functions without installing RStudio.",
    faq: [
      freeFaq("R"),
      {
        q: "Which R runtime does CompileAny use?",
        a: "R scripts run via Rscript (r-base), the standard command-line interface for executing R code.",
      },
      stdinFaq("R", "readline()"),
    ],
  },
  html: {
    label: "HTML",
    desc: "HTML Online Compiler: Write and preview HTML, CSS, and JavaScript online for free. Instant live preview in your browser.",
    about:
      "HTML, CSS, and JavaScript together form the foundation of every website. CompileAny renders your code in a real sandboxed iframe with a live preview, so you can see layout and styling changes instantly as you type — no local server needed.",
    faq: [
      freeFaq("HTML"),
      {
        q: "How does the HTML live preview work?",
        a: "There's no compilation step — your HTML, CSS, and JS are rendered live inside a sandboxed iframe, just like a real browser preview.",
      },
      {
        q: "Does the preview update automatically?",
        a: "Yes — the live preview updates in real time as you edit your HTML, CSS, and JavaScript.",
      },
    ],
  },
  sql: {
    label: "SQL",
    desc: "SQL Online Compiler: Run SQL queries online in a live MySQL 8 database sandbox. Practice DDL and DML queries.",
    about:
      "SQL is essential for working with relational databases, from simple queries to complex joins and aggregations. CompileAny runs your queries against a live MySQL 8 database, rendering results as a clean, readable table instead of raw text.",
    faq: [
      freeFaq("SQL"),
      {
        q: "Which database does the SQL sandbox use?",
        a: "Queries run against a real MySQL 8 database instance, not a mock — so joins, subqueries, and aggregate functions behave exactly as they would in production.",
      },
      {
        q: "Can I create my own tables?",
        a: "Yes — CompileAny's SQL sandbox supports full DDL (CREATE TABLE) and DML (INSERT, UPDATE, SELECT) statements against a live MySQL 8 database.",
      },
    ],
  },
};

const INDEX_HTML_PATH = path.join(__dirname, "public/index.html");
const LANDING_HTML_PATH = path.join(__dirname, "public/landing.html");

function injectGoogleScripts(html) {
  const gaId = process.env.GA_TRACKING_ID;
  const adsenseId = process.env.ADSENSE_CLIENT_ID;
  const gtmId = process.env.GTM_TRACKING_ID;

  let headScripts = "";
  let bodyScripts = "";

  if (gaId) {
    headScripts += `
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${gaId}');
  </script>`;
  }

  if (adsenseId) {
    const formattedAdsenseId = adsenseId.startsWith("pub-") ? `ca-${adsenseId}` : adsenseId;
    headScripts += `
  <!-- Google AdSense -->
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${formattedAdsenseId}" crossorigin="anonymous"></script>`;
  }

  if (gtmId) {
    headScripts += `
  <!-- Google Tag Manager -->
  <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
  new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
  j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
  'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
  })(window,document,'script','dataLayer','${gtmId}');</script>
  <!-- End Google Tag Manager -->`;

    bodyScripts += `
  <!-- Google Tag Manager (noscript) -->
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtmId}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
  <!-- End Google Tag Manager (noscript) -->`;
  }

  if (headScripts) {
    html = html.replace("</head>", `${headScripts}\n</head>`);
  }

  if (bodyScripts) {
    html = html.replace(/<body[^>]*>/, (match) => `${match}\n${bodyScripts}`);
  }

  return html;
}

async function serveIndexHtml(res, meta = null, lang = null) {
  let html;
  try {
    html = await readFile(INDEX_HTML_PATH, "utf8");
  } catch {
    return res.sendFile(INDEX_HTML_PATH);
  }

  html = injectGoogleScripts(html);

  if (meta && lang) {
    const title = `${meta.label} Online Compiler: Compile & Run ${meta.label} Code — CompileAny`;
    const slug = lang === "html" ? "html" : `${lang}-online-compiler`;
    const canonical = `https://compileany.com/${slug}`;

    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
      .replace(
        /<meta\s+name="description"[^>]*>/,
        `<meta name="description" content="${meta.desc}" />`,
      )
      .replace(
        /<link rel="canonical"[^>]*>/,
        `<link rel="canonical" href="${canonical}" />`,
      )
      .replace(
        /<meta\s+property="og:title"[^>]*id="og-title"[^>]*\/>/,
        `<meta property="og:title" content="${title}" id="og-title" />`,
      )
      .replace(
        /<meta\s+property="og:description"[^>]*id="og-description"[^>]*\/>/,
        `<meta property="og:description" content="${meta.desc}" id="og-description" />`,
      )
      .replace(
        /<meta\s+property="og:url"[^>]*id="og-url"[^>]*\/>/,
        `<meta property="og:url" content="${canonical}" id="og-url" />`,
      )
      .replace(
        /<meta\s+name="twitter:title"[^>]*id="twitter-title"[^>]*\/>/,
        `<meta name="twitter:title" content="${title}" id="twitter-title" />`,
      )
      .replace(
        /<meta\s+name="twitter:description"[^>]*id="twitter-description"[^>]*\/>/,
        `<meta name="twitter:description" content="${meta.desc}" id="twitter-description" />`,
      )
      .replace(
        /<script type="application\/ld\+json" id="ld-json">[\s\S]*?<\/script>/,
        `<script type="application\/ld\+json" id="ld-json">
      {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        "name": "${title}",
        "applicationCategory": "DeveloperApplication",
        "operatingSystem": "Any (Web-based)",
        "url": "${canonical}",
        "offers": {
          "@type": "Offer",
          "price": "0",
          "priceCurrency": "USD"
        },
        "description": "${meta.desc}"
      }
    </script>`,
      )
      .replace(
        /<h1 id="seo-h1">[^<]*<\/h1>/,
        `<h1 id="seo-h1">${title}</h1>`,
      )
      .replace(
        /<p id="seo-about-text">[^<]*<\/p>/,
        `<p id="seo-about-text">${meta.about}</p>`,
      )
      .replace(
        /<div id="seo-faq">[\s\S]*?<\/div>\s*<\/div>\s*<\/details>/,
        `<div id="seo-faq">${meta.faq
          .map(
            (item) => `
        <details class="seo-faq-item">
          <summary>${item.q}</summary>
          <p>${item.a}</p>
        </details>`,
          )
          .join("")}
      </div>
    </div>
  </details>`,
      )
      .replace(
        /<script type="application\/ld\+json" id="faq-jsonld">[\s\S]*?<\/script>/,
        `<script type="application\/ld\+json" id="faq-jsonld">
      {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [${meta.faq
          .map(
            (item) => `
          {
            "@type": "Question",
            "name": "${item.q}",
            "acceptedAnswer": {
              "@type": "Answer",
              "text": "${item.a}"
            }
          }`,
          )
          .join(",")}
        ]
      }
    </script>`,
      );
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  return res.send(html);
}

async function serveCompilerPage(res, lang) {
  const meta = LANG_META[lang];
  if (!meta) return serveIndexHtml(res);
  return serveIndexHtml(res, meta, lang);
}

async function serveLandingPage(res) {
  let html;
  try {
    html = await readFile(LANDING_HTML_PATH, "utf8");
  } catch {
    return res.sendFile(LANDING_HTML_PATH);
  }

  html = injectGoogleScripts(html);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  return res.send(html);
}

const PORT = process.env.PORT || 6600;
const NODE_ENV = process.env.NODE_ENV || "development";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const codeCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
});

/* ----------------------------- Middlewares ----------------------------- */

app.set("trust proxy", true);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin:
      NODE_ENV === "production"
        ? [
            "https://compileany.com",
            "https://www.compileany.com",
            "https://compiler.abhishekdev.cloud",
            "https://fecpp.abhishekdev.cloud",
          ]
        : true,
    credentials: true,
  }),
);

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});

app.use(
  express.urlencoded({
    extended: true,
    limit: "2mb",
  }),
);

app.use(
  express.json({
    limit: "2mb",
  }),
);

/* ----------------------------- Static Files ----------------------------- */

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    setHeaders(res, filePath) {
      if (/\.(html|css|js)$/i.test(filePath)) {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }),
);

app.use(
  "/codemirror",
  express.static(path.join(__dirname, "node_modules/codemirror")),
);

app.use(
  "/xterm",
  express.static(path.join(__dirname, "node_modules/@xterm/xterm")),
);

/* ------------- Serve public/index.html for share/code routes ----------- */

app.get("/", (_req, res) => {
  return serveLandingPage(res);
});

app.get("/sitemap.xml", (_req, res) => {
  const base = "https://compileany.com";
  const langs = Object.keys(LANG_META);
  const urls = [
    `<url><loc>${base}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${base}/html</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
    ...langs
      .filter((l) => l !== "html")
      .map(
        (l) =>
          `<url><loc>${base}/${l}-online-compiler</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
      ),
  ].join("\n  ");
  res.setHeader("Content-Type", "application/xml");
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls}\n</urlset>`,
  );
});

app.get("/robots.txt", (_req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(
    `User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://compileany.com/sitemap.xml\n`,
  );
});

app.get(["/c/:id", "/share/:id"], (req, res) => {
  return serveIndexHtml(res);
});

/* -------------------------------- Routes -------------------------------- */

app.use("/api/ai", aiLimiter, aiRoutes);

app.get("/html", (_req, res) => {
  return serveCompilerPage(res, "html");
});

app.get("/:lang-online-compiler", (req, res, next) => {
  const lang = req.params.lang;
  if (!LANG_META[lang]) return next();
  return serveCompilerPage(res, lang);
});

app.get("/:lang-programming", (req, res, next) => {
  const lang = req.params.lang;
  if (!LANG_META[lang]) return next();
  const slug = lang === "html" ? "html" : `${lang}-online-compiler`;
  return res.redirect(301, `/${slug}`);
});

app.use("/", createCodeRouter(codeCache));

/* ---------------------------- Error Handler ----------------------------- */

app.use((req, res) => {
  return res.status(404).sendFile(path.join(__dirname, "public/404.html"));
});

app.use((err, req, res, next) => {
  console.error("Server Error:", err);

  return res.status(500).json({
    message: false,
    error: "Internal Server Error",
  });
});

/* -------------------------- WebSocket / Cleanup ------------------------- */

setupCompilerWS(wss);
setupCleanup();

/* ------------------------------- Startup -------------------------------- */

async function startServer() {
  try {
    if (process.env.OBFUSCATE_ON_START === "true") {
      await obfuscateScript();
    }
  } catch (err) {
    console.error("Obfuscation Error:", err);
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

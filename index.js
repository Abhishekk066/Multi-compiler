import cors from 'cors';
import 'dotenv/config';
import EventEmitter from 'events';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { readFile } from 'fs/promises';
import helmet from 'helmet';
import http from 'http';
import NodeCache from 'node-cache';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

import aiRoutes from './routes/ai.js';
import createCodeRouter from './routes/code.js';
import { obfuscateScript } from './utils/obfuscator.js';
import { setupCleanup, setupCompilerWS } from './ws/compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

EventEmitter.defaultMaxListeners = 60;

const LANG_META = {
  cpp:        { label: 'C++',        desc: 'Write and run C++ code online for free. Instant compilation with real-time output — no install needed.' },
  c:          { label: 'C',          desc: 'Write and run C code online for free. Instant compilation with real-time output — no install needed.' },
  java:       { label: 'Java',       desc: 'Write and run Java code online for free. Instant Java compiler in your browser, no setup required.' },
  python:     { label: 'Python',     desc: 'Write and run Python code online for free. Instant Python 3 interpreter with real-time output.' },
  javascript: { label: 'JavaScript', desc: 'Write and run JavaScript code online for free. Node.js runtime, instant output in your browser.' },
  typescript: { label: 'TypeScript', desc: 'Write and run TypeScript code online for free. Instant TypeScript compiler, no install needed.' },
  go:         { label: 'Go',         desc: 'Write and run Go code online for free. Instant Go compiler with real-time output in your browser.' },
  kotlin:     { label: 'Kotlin',     desc: 'Write and run Kotlin code online for free. Instant Kotlin compiler in your browser.' },
  ruby:       { label: 'Ruby',       desc: 'Write and run Ruby code online for free. Instant Ruby interpreter with real-time output.' },
  php:        { label: 'PHP',        desc: 'Write and run PHP code online for free. Instant PHP interpreter in your browser, no setup needed.' },
  bash:       { label: 'Bash',       desc: 'Write and run Bash scripts online for free. Instant shell execution in your browser.' },
  rust:       { label: 'Rust',       desc: 'Write and run Rust code online for free. Instant Rust compiler with real-time output.' },
  csharp:     { label: 'C#',         desc: 'Write and run C# code online for free. Instant C# compiler in your browser, no install needed.' },
  perl:       { label: 'Perl',       desc: 'Write and run Perl code online for free. Instant Perl interpreter with real-time output.' },
  lua:        { label: 'Lua',        desc: 'Write and run Lua code online for free. Instant Lua interpreter in your browser.' },
  r:          { label: 'R',          desc: 'Write and run R code online for free. Instant R interpreter with real-time output.' },
  html:       { label: 'HTML',       desc: 'Write and preview HTML, CSS, and JavaScript online for free. Instant live preview in your browser.' },
  sql:        { label: 'SQL',        desc: 'Write and run SQL queries online for free. Instant SQL sandbox in your browser.' },
};

const INDEX_HTML_PATH = path.join(__dirname, 'public/index.html');

async function serveCompilerPage(res, lang) {
  const meta = LANG_META[lang];
  if (!meta) return res.sendFile(INDEX_HTML_PATH);

  let html;
  try {
    html = await readFile(INDEX_HTML_PATH, 'utf8');
  } catch {
    return res.sendFile(INDEX_HTML_PATH);
  }

  const title = `${meta.label} Online Compiler — CompileAny`;
  const slug = lang === 'html' ? 'html' : `${lang}-online-compiler`;
  const canonical = `https://compileany.com/${slug}`;

  html = html
    .replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`)
    .replace(/<meta[\s\S]*?name="description"[\s\S]*?\/>/, `<meta name="description" content="${meta.desc}" />`)
    .replace(/<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${canonical}" />`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(html);
}

const PORT = process.env.PORT || 6600;
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const codeCache = new NodeCache({
  stdTTL: 3600,
  checkperiod: 600,
});

/* ----------------------------- Middlewares ----------------------------- */

app.set('trust proxy', true);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin:
      NODE_ENV === 'production'
        ? [
            'https://compileany.com',
            'https://www.compileany.com',
            'https://compiler.abhishekdev.cloud',
            'https://fecpp.abhishekdev.cloud',
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
  message: { error: 'Too many requests. Please wait a moment.' },
});

app.use(
  express.urlencoded({
    extended: true,
    limit: '2mb',
  }),
);

app.use(
  express.json({
    limit: '2mb',
  }),
);

/* ----------------------------- Static Files ----------------------------- */

app.use(
  express.static(path.join(__dirname, 'public'), {
    index: false,
    setHeaders(res, filePath) {
      if (/\.(html|css|js)$/i.test(filePath)) {
        res.setHeader(
          'Cache-Control',
          'no-store, no-cache, must-revalidate, proxy-revalidate',
        );
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }),
);

app.use(
  '/codemirror',
  express.static(path.join(__dirname, 'node_modules/codemirror')),
);

app.use(
  '/xterm',
  express.static(path.join(__dirname, 'node_modules/@xterm/xterm')),
);

/* ------------- Serve public/index.html for share/code routes ----------- */

app.get('/', (_req, res) => {
  return res.sendFile(path.join(__dirname, 'public/landing.html'));
});

app.get('/sitemap.xml', (_req, res) => {
  const base = 'https://compileany.com';
  const langs = Object.keys(LANG_META);
  const urls = [
    `<url><loc>${base}/</loc><changefreq>monthly</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${base}/html</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`,
    ...langs
      .filter(l => l !== 'html')
      .map(l => `<url><loc>${base}/${l}-online-compiler</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>`),
  ].join('\n  ');
  res.setHeader('Content-Type', 'application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls}\n</urlset>`);
});

app.get('/robots.txt', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://compileany.com/sitemap.xml\n`);
});

app.get(['/c/:id', '/share/:id'], (req, res) => {
  return res.sendFile(path.join(__dirname, 'public/index.html'));
});

/* -------------------------------- Routes -------------------------------- */

app.use('/api/ai', aiLimiter, aiRoutes);

app.get('/html', (_req, res) => {
  return serveCompilerPage(res, 'html');
});

app.get('/:lang-online-compiler', (req, res, next) => {
  const lang = req.params.lang;
  if (!LANG_META[lang]) return next();
  return serveCompilerPage(res, lang);
});

app.get('/:lang-programming', (req, res, next) => {
  const lang = req.params.lang;
  if (!LANG_META[lang]) return next();
  const slug = lang === 'html' ? 'html' : `${lang}-online-compiler`;
  return res.redirect(301, `/${slug}`);
});

app.use('/', createCodeRouter(codeCache));

/* ---------------------------- Error Handler ----------------------------- */

app.use((req, res) => {
  return res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

app.use((err, req, res, next) => {
  console.error('Server Error:', err);

  return res.status(500).json({
    message: false,
    error: 'Internal Server Error',
  });
});

/* -------------------------- WebSocket / Cleanup ------------------------- */

setupCompilerWS(wss);
setupCleanup();

/* ------------------------------- Startup -------------------------------- */

async function startServer() {
  try {
    if (process.env.OBFUSCATE_ON_START === 'true') {
      await obfuscateScript();
    }
  } catch (err) {
    console.error('Obfuscation Error:', err);
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();

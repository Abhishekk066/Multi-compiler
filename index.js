import cors from 'cors';
import 'dotenv/config';
import EventEmitter from 'events';
import express from 'express';
import http from 'http';
import NodeCache from 'node-cache';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

import aiRoutes from './routes/ai.js';
import createCodeRouter from './routes/code.js';
import { obfuscateScript } from './utils/obfuscator.js';
import { setupCleanup, setupCompilerWS } from './ws/compiler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

EventEmitter.defaultMaxListeners = 60;

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
  cors({
    origin:
      NODE_ENV === 'production'
        ? [
            'https://compiler.abhishekdev.cloud',
            'https://fecpp.abhishekdev.cloud',
          ]
        : true,
    credentials: true,
  }),
);

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

app.get(['/c/:id', '/share/:id'], (req, res) => {
  return res.sendFile(path.join(__dirname, 'public/index.html'));
});

/* -------------------------------- Routes -------------------------------- */

app.use('/api/ai', aiRoutes);

app.get('/:lang-programming', (req, res, next) => {
  const lang = req.params.lang;

  if (/^[a-z0-9+#-]+$/i.test(lang)) {
    return res.sendFile(path.join(__dirname, 'public/index.html'));
  }

  return next();
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

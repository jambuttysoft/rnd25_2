import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { apiRouter } from './routes/api.js';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const VERSION = Date.now().toString(36);

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} CT=${req.headers['content-type']?.slice(0, 80)} FL=${
      req.headers['content-type']?.startsWith('multipart') ? 'pending' : 'N/A'
    }`);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  setHeaders(res, filepath) {
    if (filepath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
    res.setHeader('X-Version', VERSION);
  }
}));

// API routes
app.use('/api', apiRouter);

// Uploads directory
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Serve frontend for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

// Start
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   PoA Verification Pipeline                         ║
║   Multimodal Physical Trace Analysis                ║
╚══════════════════════════════════════════════════════╝
  Server:    http://localhost:${PORT}
  API:       http://localhost:${PORT}/api
  Model:     ${process.env.VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct'}

  Experiments:
    [1] Equipment Verification   POST /api/experiment1/verify
    [2] Hidden Asset Detection    POST /api/experiment2/scan
    [3] Infrastructure Integrity  POST /api/experiment3/inspect
    [4] Scalability Optimization  POST /api/experiment4/benchmark

  Dashboard: http://localhost:${PORT}
  `);
});

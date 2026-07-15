import { Router } from 'express';
import multer from 'multer';
import { runExperiment1, extractReceiptData, autoDetect } from '../services/experiment1.js';
import { runExperiment2 } from '../services/experiment2.js';
import { runExperiment3 } from '../services/experiment3.js';
import { runExperiment4 } from '../services/experiment4.js';
import { resultStore } from '../services/store.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.join(__dirname, '..', 'uploads');

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'];

const MAGIC_BYTES = {
  jpeg: Buffer.from([0xFF, 0xD8, 0xFF]),
  png:  Buffer.from([0x89, 0x50, 0x4E, 0x47]),
  webp: Buffer.from([0x52, 0x49, 0x46, 0x46]) // "RIFF"
};

function validateImageMagic(filepath, mimeType) {
  const fd = fs.openSync(filepath, 'r');
  const header = Buffer.alloc(12);
  fs.readSync(fd, header, 0, 12, 0);
  fs.closeSync(fd);

  if (header.slice(0, 3).equals(MAGIC_BYTES.jpeg) || header.slice(0, 4).equals(MAGIC_BYTES.png)) {
    return header.slice(0, 4).equals(MAGIC_BYTES.png) ? 'image/png' : 'image/jpeg';
  }
  if (header.slice(0, 4).equals(MAGIC_BYTES.webp)) {
    return 'image/webp';
  }
  return null;
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
  }
});

export const apiRouter = Router();

// ---- Health ----
apiRouter.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PoA Verification Pipeline',
    version: '1.0.0',
    model: process.env.VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct'
  });
});

// ---- Helpers ----
function fileToBase64(filepath) {
  const data = fs.readFileSync(filepath);
  return data.toString('base64');
}

function cleanupFile(filepath) {
  try { fs.unlinkSync(filepath); } catch {}
}

function formReceiptData(body) {
  return {
    item: body.item || 'Unknown equipment',
    amount: body.amount || '$0',
    date: body.date || 'Unknown',
    vendor: body.vendor || 'Unknown vendor'
  };
}

async function ocrReceipt(receiptFile) {
  const receiptB64 = fileToBase64(receiptFile.path);
  const ocrResult = await extractReceiptData(receiptB64);
  const items = Array.isArray(ocrResult?.items) ? ocrResult.items
    : (Array.isArray(ocrResult) ? ocrResult : []);

  if (!items.length && !ocrResult?.vendor && !ocrResult?.total) return null;

  const totalStr = ocrResult?.total
    || (items.length ? `$${items.reduce((sum, it) => sum + (it.total_price || it.amount || 0), 0).toFixed(2)}` : null);

  return {
    item: items.map(it => it.name || it.description).filter(Boolean).join('; ') || ocrResult?.vendor || 'Unknown',
    amount: totalStr || '$0',
    date: ocrResult?.date || items[0]?.date || 'Unknown',
    vendor: ocrResult?.vendor || items[0]?.vendor || items[0]?.merchant || 'Unknown vendor',
    _raw: { vendor: ocrResult?.vendor, date: ocrResult?.date, total: ocrResult?.total, items }
  };
}

// ====================================================================
// EXPERIMENT 1 — Equipment Verification
// ====================================================================
const exp1Upload = upload.fields([
  { name: 'photo', maxCount: 1 },
  { name: 'receipt', maxCount: 1 }
]);

apiRouter.post('/experiment1/verify', exp1Upload, async (req, res) => {
  const ct = req.headers['content-type'] || 'missing';
  const cl = req.headers['content-length'] || 'missing';
  console.log(`[/experiment1/verify] INCOMING — CT=${ct.slice(0,120)} CL=${cl}`);
  console.log(`[/experiment1/verify] req.files =`, req.files ? Object.keys(req.files) : 'UNDEFINED');
  console.log(`[/experiment1/verify] req.body  =`, JSON.stringify(req.body).slice(0, 300));

  try {
    const photo = req.files?.photo?.[0];
    const receiptFile = req.files?.receipt?.[0];

    if (!photo) {
      if (receiptFile) cleanupFile(receiptFile.path);
      return res.status(400).json({
        error: 'No photo uploaded',
        detail: `Send a multipart/form-data request with a file field named "photo". Received Content-Type: ${ct.slice(0,80)}. Supported formats: JPEG, PNG, WebP up to 20MB.`
      });
    }

    const imageBase64 = fileToBase64(photo.path);
    const actualMime = validateImageMagic(photo.path);
    if (!actualMime) {
      cleanupFile(photo.path);
      if (receiptFile) cleanupFile(receiptFile.path);
      return res.status(400).json({ error: 'Invalid image file — must be JPEG, PNG, or WebP' });
    }
    const mimeType = actualMime;

    const formData = formReceiptData(req.body);
    let receiptData = formData;
    let ocrRaw = null;
    let source = 'form';

    if (receiptFile) {
      try {
        const ocr = await ocrReceipt(receiptFile);
        if (ocr) {
          ocrRaw = ocr._raw;
          receiptData = {
            item: ocr.item !== 'Unknown' ? ocr.item : formData.item,
            amount: ocr.amount !== '$0' ? ocr.amount : formData.amount,
            date: ocr.date !== 'Unknown' ? ocr.date : formData.date,
            vendor: ocr.vendor !== 'Unknown vendor' ? ocr.vendor : formData.vendor
          };
          source = 'ocr';
          console.log('[/experiment1/verify] OCR extracted receipt:', JSON.stringify({...receiptData, ocrRaw: undefined}).slice(0,300));
        }
      } catch (ocrErr) {
        console.error('[/experiment1/verify] OCR failed, using form data:', ocrErr.message);
      }
    }

    const result = await runExperiment1(imageBase64, receiptData, mimeType);
    const txn = uuidv4().slice(0, 8).toUpperCase();

    cleanupFile(photo.path);
    if (receiptFile) cleanupFile(receiptFile.path);

    const summary = {
      experiment: 1,
      status: 'completed',
      transaction_id: txn,
      receipt_source: source,
      receipt_effective: receiptData,
      verdict: result.match_summary?.verification_status,
      recommendation: result.recommendation,
      detected_items: result.detected_items?.map(it => it.name),
      confidence: result.match_summary?.overall_confidence,
      result
    };
    resultStore.save(summary);

    res.json({
      experiment: 1,
      status: 'completed',
      transaction_id: txn,
      receipt_source: source,
      receipt_ocr: ocrRaw,
      receipt_effective: receiptData,
      receipt_form: formData,
      result
    });
  } catch (err) {
    const pf = req.files?.photo?.[0];
    if (pf) cleanupFile(pf.path);
    const rf = req.files?.receipt?.[0];
    if (rf) cleanupFile(rf.path);
    console.error('[/experiment1/verify] Error:', err.message);
    res.status(503).json({
      error: 'Analysis failed — the AI model is unavailable. Please retry.',
      detail: err.message
    });
  }
});

// Auto-detect equipment from photo (no receipt needed)
apiRouter.post('/experiment1/auto-detect', upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Photo is required' });

    const imageBase64 = fileToBase64(file.path);
    const mimeType = file.mimetype;
    const result = await autoDetect(imageBase64, mimeType);

    cleanupFile(file.path);
    res.json({
      experiment: 1,
      task: 'auto-detect',
      status: 'completed',
      result
    });
  } catch (err) {
    console.error('[/experiment1/auto-detect] Error:', err.message, err.body?.slice(0,500));
    if (req.file) cleanupFile(req.file.path);
    res.status(503).json({ error: 'Detection failed — please retry', detail: err.message });
  }
});

apiRouter.post('/experiment1/ocr', upload.single('receipt'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Receipt image is required' });

    const imageBase64 = fileToBase64(file.path);
    const result = await extractReceiptData(imageBase64);

    cleanupFile(file.path);
    res.json({
      experiment: 1,
      task: 'ocr',
      status: 'completed',
      result
    });
  } catch (err) {
    if (req.file) cleanupFile(req.file.path);
    res.status(503).json({ error: 'Scan failed — please retry', detail: err.message });
  }
});

// ====================================================================
// EXPERIMENT 2 — Hidden Asset Detection
// ====================================================================
apiRouter.post('/experiment2/scan', upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Photo is required' });

    const erpCategory = req.body.erp_category || 'Consumables';

    const imageBase64 = fileToBase64(file.path);
    const result = await runExperiment2(imageBase64, erpCategory);
    const txn = uuidv4().slice(0, 8).toUpperCase();

    cleanupFile(file.path);

    resultStore.save({
      experiment: 2,
      status: 'completed',
      transaction_id: txn,
      erp_category: erpCategory,
      capital_equipment_found: result.summary?.capital_equipment_found || 0,
      consumables: result.summary?.consumables || 0,
      recoverable_value: result.summary?.estimated_recoverable_value,
      total_items: result.summary?.total_items || 0,
      result
    });

    res.json({
      experiment: 2,
      status: 'completed',
      transaction_id: txn,
      erp_category: erpCategory,
      result
    });
  } catch (err) {
    if (req.file) cleanupFile(req.file.path);
    res.status(503).json({ error: 'Scan failed — please retry', detail: err.message });
  }
});

// ====================================================================
// EXPERIMENT 3 — Infrastructure Integrity
// ====================================================================
apiRouter.post('/experiment3/inspect', upload.single('photo'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Photo is required' });

    const nodeLabel = req.body.node_label || 'Unnamed node';

    const imageBase64 = fileToBase64(file.path);
    const result = await runExperiment3(imageBase64, nodeLabel);
    const txn = uuidv4().slice(0, 8).toUpperCase();

    cleanupFile(file.path);

    resultStore.save({
      experiment: 3,
      status: 'completed',
      transaction_id: txn,
      node_label: nodeLabel,
      integration_score: result.integration_score,
      verdict: result.verdict,
      patch_cords: result.integration_status?.patch_cords_connected,
      power_connected: result.integration_status?.power_connected,
      link_leds: result.integration_status?.link_leds_lit,
      cable_mgmt: result.integration_status?.cable_management_populated,
      result
    });

    res.json({
      experiment: 3,
      status: 'completed',
      transaction_id: txn,
      node_label: nodeLabel,
      result
    });
  } catch (err) {
    if (req.file) cleanupFile(req.file.path);
    res.status(503).json({ error: 'Scan failed — please retry', detail: err.message });
  }
});

// ====================================================================
// EXPERIMENT 4 — Scalability & Optimization
// ====================================================================
apiRouter.post('/experiment4/benchmark', async (req, res) => {
  try {
    const imageCount = parseInt(req.body.image_count) || 10000;
    const mode = req.body.mode || 'both';

    const result = await runExperiment4({ imageCount, mode });
    const txn = uuidv4().slice(0, 8).toUpperCase();

    resultStore.save({
      experiment: 4,
      status: 'completed',
      transaction_id: txn,
      image_count: imageCount,
      mode,
      baseline_cost_per_image: result.baseline?.metrics?.cost_per_image,
      optimized_cost_per_image: result.optimized?.metrics?.cost_per_image,
      baseline_latency_ms: result.baseline?.metrics?.latency_per_image_ms,
      optimized_latency_ms: result.optimized?.metrics?.latency_per_image_ms,
      cost_reduction: result.comparison ? `${result.comparison.cost_reduction_percent}%` : null,
      speedup: result.comparison ? `${result.comparison.speedup_factor}x` : null,
      result
    });

    res.json({
      experiment: 4,
      status: 'completed',
      transaction_id: txn,
      result
    });
  } catch (err) {
    res.status(503).json({ error: 'Benchmark failed — please retry', detail: err.message });
  }
});

// ====================================================================
// SUMMARY
// ====================================================================
apiRouter.get('/summary', async (req, res) => {
  const benchmark = await runExperiment4({ imageCount: 10000, mode: 'both' });
  const latestByExp = resultStore.getLatestByExperiment();
  const allResults = resultStore.getAll();

  const experiments = [1, 2, 3, 4].map(id => {
    const r = latestByExp.get(id);
    const base = {
      id,
      status: r ? 'completed' : 'pending',
      run_count: allResults.filter(x => x.experiment === id).length,
      last_run: r ? r.saved_at : null,
      transaction_id: r?.transaction_id || null
    };

    switch (id) {
      case 1:
        return {
          ...base,
          name: 'Equipment Verification',
          metrics: {
            verdict: r?.verdict || '—',
            recommendation: r?.recommendation || '—',
            detected_items: r?.detected_items?.length ? r.detected_items.join(', ') : '—',
            confidence: r?.confidence ? `${(r.confidence * 100).toFixed(0)}%` : '—',
            receipt_source: r?.receipt_source || '—'
          }
        };
      case 2:
        return {
          ...base,
          name: 'Hidden Asset Detection',
          metrics: {
            capital_equipment: r?.capital_equipment_found ?? '—',
            consumables: r?.consumables ?? '—',
            recoverable_value: r?.recoverable_value || '—',
            erp_category: r?.erp_category || '—'
          }
        };
      case 3:
        return {
          ...base,
          name: 'Infrastructure Integrity',
          metrics: {
            integration_score: r?.integration_score !== undefined ? `${r.integration_score}/4` : '—',
            verdict: r?.verdict || '—',
            patch_cords: r?.patch_cords === true ? 'Yes' : r?.patch_cords === false ? 'No' : '—',
            power: r?.power_connected === true ? 'Yes' : r?.power_connected === false ? 'No' : '—'
          }
        };
      case 4:
        return {
          ...base,
          name: 'Scalability & Optimization',
          metrics: {
            cost_reduction: r?.cost_reduction || benchmark.comparison?.cost_reduction || '—',
            speedup: r?.speedup || benchmark.comparison?.speedup || '—',
            cost_per_image: r?.optimized_cost_per_image ? `$${r.optimized_cost_per_image}` : '—',
            mode: r?.mode || 'both'
          }
        };
      default:
        return base;
    }
  });

  const allRun = [1, 2, 3, 4].every(id => latestByExp.has(id));

  res.json({
    locked: !allRun,
    experiments,
    benchmark: benchmark.comparison || {},
    all_results: allResults.slice(-50),
    total_runs: allResults.length,
    total_estimated_impact: allRun ? '$4.1M' : '—',
    pending_experiments: [1, 2, 3, 4].filter(id => !latestByExp.has(id))
  });
});

// ---- Error handling middleware ----
apiRouter.use((err, req, res, next) => {
  const ct = req.headers['content-type'] || 'missing';
  console.error(`[ERROR-MW] ${req.method} ${req.path} CT=${ct.slice(0,100)} err=${err.message} code=${err.code} field=${err.field}`);
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload error: ${err.message}`, code: err.code, field: err.field });
  }
  if (err.message?.includes('Only JPEG')) {
    return res.status(400).json({ error: err.message });
  }
  console.error('API Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readResults() {
  ensureDir();
  if (!fs.existsSync(RESULTS_FILE)) return [];
  try {
    const raw = fs.readFileSync(RESULTS_FILE, 'utf8');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeResults(results) {
  ensureDir();
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
}

export const resultStore = {
  save(record) {
    const results = readResults();
    results.push({
      ...record,
      saved_at: new Date().toISOString()
    });
    writeResults(results);
    return record;
  },

  getAll() {
    return readResults();
  },

  getByExperiment(experimentId) {
    return readResults().filter(r => r.experiment === experimentId);
  },

  getLatestByExperiment() {
    const results = readResults();
    const map = new Map();
    for (const r of results) {
      const existing = map.get(r.experiment);
      if (!existing || new Date(r.saved_at) > new Date(existing.saved_at)) {
        map.set(r.experiment, r);
      }
    }
    return map;
  },

  getLatest(experimentId) {
    const byExp = this.getByExperiment(experimentId);
    return byExp[byExp.length - 1] || null;
  },

  clear() {
    writeResults([]);
  }
};

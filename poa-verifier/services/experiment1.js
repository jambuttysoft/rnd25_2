import { openrouter } from './openrouter.js';

// ====================================================================
// STEP 1: Automatic equipment detection from image
// ====================================================================
const DETECT_PROMPT = `You are a computer vision analyst for IT infrastructure equipment.
Examine the photo carefully and identify ALL equipment visible.

For each item, output JSON:
{
  "detected_equipment": [{
    "name": string — precise model/name (e.g. "Cisco Catalyst 9200 24-Port"),
    "category": "server" | "switch" | "router" | "ups" | "rack" | "cabling" | "tool" | "other",
    "brand": string or null — manufacturer name if visible,
    "model_number": string or null — any model/serial numbers visible,
    "confidence": float 0-1,
    "physical_condition": "new" | "used" | "damaged",
    "distinctive_features": [string] — what makes it identifiable
  }],
  "scene_context": string — where is this? (datacenter, warehouse, office, etc.),
  "estimated_quantity": int — total number of equipment units visible
}

Be specific about model numbers, port counts, form factors. If labels are visible, transcribe them.`;

async function autoDetectEquipment(imageBase64, mimeType = 'image/jpeg') {
  const result = await openrouter.analyzeImage(
    'You are an IT infrastructure equipment identifier. Return ONLY valid JSON.',
    DETECT_PROMPT,
    imageBase64,
    mimeType
  );
  return extractJson(result.text);
}

// ====================================================================
// STEP 2: Market analogue search (via LLM training knowledge)
// ====================================================================
const ANALOG_PROMPT = `You are a procurement and market research analyst for IT infrastructure.
Given the equipment identified below, provide:
1. Known market analogues — alternative models from other manufacturers that serve the same function
2. Typical price range (new and used market)
3. Common specifications
4. Known supply chain or EOL (End of Life) status

Return JSON:
{
  "primary_equipment": { ... name, category, brand ... },
  "market_analogues": [{
    "manufacturer": string,
    "model": string,
    "type": "direct_replacement" | "competitor" | "previous_generation" | "next_generation",
    "typical_price_new": string,
    "typical_price_used": string,
    "key_differences": string,
    "similarity_score": float 0-1
  }],
  "market_notes": string — any relevant market context (shortages, EOL, etc.)
}`;

async function searchMarketAnalogs(equipmentData) {
  const equipmentSummary = JSON.stringify(equipmentData, null, 2);
  const prompt = `Identified equipment from photo:\n${equipmentSummary}\n\nSearch for market analogues, pricing, and alternatives.`;

  const result = await openrouter.analyzeImage(
    'You are a market research analyst for IT equipment. Return ONLY valid JSON.',
    prompt,
    null // no image needed for this step
  );
  return extractJson(result.text);
}

// ====================================================================
// STEP 3: Cross-reference with receipt + generate justification
// ====================================================================
const CROSSREF_PROMPT = `You are a forensic audit analyst. Compare the detected equipment and market analysis against the receipt line item.

Provide a detailed JSON analysis:

{
  "verdict": "MATCH" | "PARTIAL_MATCH" | "MISMATCH" | "INCONCLUSIVE",
  "overall_confidence": float 0-1,
  "evidence_chain": [
    {
      "step": string — description of what was checked,
      "finding": string — what was found,
      "supports_match": bool
    }
  ],
  "justification": string — natural language explanation of WHY this verdict was reached. Reference specific visual evidence, model numbers, pricing comparisons. If mismatch, explain exactly what is wrong.,
  "discrepancies": [{
    "field": string — what field has an issue (name, price, brand, quantity),
    "expected": string,
    "found": string,
    "severity": "critical" | "major" | "minor"
  }],
  "matches": [{
    "field": string,
    "detail": string
  }],
  "recommendation": "APPROVE" | "REVIEW" | "REJECT"
}`;

async function crossReference(detection, marketAnalysis, receiptData) {
  const payload = JSON.stringify({
    detected: detection,
    market: marketAnalysis,
    receipt: {
      item: receiptData.item,
      amount: receiptData.amount,
      date: receiptData.date,
      vendor: receiptData.vendor
    }
  }, null, 2);

  const prompt = `Cross-reference analysis data:\n${payload}\n\nProvide detailed comparison and justification.`;

  const result = await openrouter.analyzeImage(CROSSREF_PROMPT, prompt);
  return extractJson(result.text);
}

// ====================================================================
// Main orchestrator — full 3-step pipeline
// ====================================================================
export async function runExperiment1(imageBase64, receiptData, mimeType = 'image/jpeg') {
  const detection = await autoDetectEquipment(imageBase64, mimeType);

  // Step 2: Market analogues
  const marketAnalysis = await searchMarketAnalogs(detection);

  // Step 3: Cross-reference
  const reference = await crossReference(detection, marketAnalysis, receiptData);

  return {
    pipeline: {
      step1_detection: detection,
      step2_market_analysis: marketAnalysis,
      step3_cross_reference: reference
    },
    detected_items: (detection.detected_equipment || []).map(e => ({
      name: e.name,
      category: e.category,
      confidence: e.confidence,
      visual_brand: e.brand,
      condition: e.physical_condition
    })),
    match_summary: {
      items_found: (detection.detected_equipment || []).length,
      items_in_receipt: 1,
      verification_status: mapVerdict(reference.verdict),
      overall_confidence: reference.overall_confidence || 0,
      suspected_duplicates: [],
      notes: reference.justification || ''
    },
    justification: reference.justification || '',
    evidence_chain: reference.evidence_chain || [],
    discrepancies: reference.discrepancies || [],
    matches: reference.matches || [],
    market_analogues: normalizeMarketAnalogs(marketAnalysis),
    recommendation: reference.recommendation || 'REVIEW',
    timestamp: new Date().toISOString()
  };
}

// ====================================================================
// Standalone auto-detect (for frontend preview)
// ====================================================================
export async function autoDetect(imageBase64, mimeType = 'image/jpeg') {
  const result = await autoDetectEquipment(imageBase64, mimeType);
  return {
    ...result,
    timestamp: new Date().toISOString()
  };
}

// ====================================================================
// Receipt OCR
// ====================================================================
export async function extractReceiptData(imageBase64) {
  const prompt = 'Extract all text from this receipt photo. Return a JSON object:\n\n'
    + '{\n'
    + '  "vendor": "store name",\n'
    + '  "date": "YYYY-MM-DD",\n'
    + '  "total": "total amount with currency",\n'
    + '  "items": [\n'
    + '    {"name": "product name", "quantity": number, "unit_price": number, "total_price": number}\n'
    + '  ]\n'
    + '}';

  const result = await openrouter.analyzeImage(
    'You are an OCR system specialized in receipt extraction. Return ONLY valid JSON.',
    prompt,
    imageBase64
  );

  return extractJson(result.text);
}

// ====================================================================
// Helpers
// ====================================================================
function normalizeMarketAnalogs(marketData) {
  const raw = marketData.market_analogues || marketData.alternatives || [];
  if (!Array.isArray(raw)) return [];

  return raw.flatMap(group => {
    // Group format: { equipment: "...", analogues: [...] }
    if (group.analogues && Array.isArray(group.analogues)) {
      return group.analogues.map(a => ({
        manufacturer: a.brand || a.manufacturer || group.equipment || 'Unknown',
        model: a.model || '',
        type: a.type || 'analogue',
        typical_price_new: a.price_range || a.typical_price_new || '',
        typical_price_used: a.typical_price_used || '',
        key_differences: a.features?.join('; ') || a.key_differences || '',
        similarity_score: a.similarity_score ?? 0.5
      }));
    }
    // Flat format: { manufacturer: "...", model: "...", ... }
    if (group.manufacturer || group.brand) {
      return [{
        manufacturer: group.brand || group.manufacturer,
        model: group.model || '',
        type: group.type || 'analogue',
        typical_price_new: group.price_range || group.typical_price_new || '',
        typical_price_used: group.typical_price_used || '',
        key_differences: group.features?.join('; ') || group.key_differences || '',
        similarity_score: group.similarity_score ?? 0.5
      }];
    }
    return [];
  });
}

function mapVerdict(v) {
  const map = {
    'MATCH': 'VERIFIED',
    'PARTIAL_MATCH': 'PARTIAL',
    'MISMATCH': 'NOT_VERIFIED',
    'INCONCLUSIVE': 'PARTIAL'
  };
  return map[v] || 'PARTIAL';
}

function extractJson(text) {
  if (!text) return { error: 'Empty response' };
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { error: 'No JSON found in response', raw: text.slice(0, 500) };
  } catch {
    return { error: 'Failed to parse JSON', raw: text.slice(0, 500) };
  }
}

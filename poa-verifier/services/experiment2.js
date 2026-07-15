import { openrouter } from './openrouter.js';

const SYSTEM_PROMPT = `You are an asset classification auditor for construction and IT infrastructure projects.
Your task is to identify HIGH-VALUE CAPITAL EQUIPMENT that has been misclassified as general consumables or materials.

HIGH-VALUE CAPITAL EQUIPMENT indicators:
- Professional brand logos (Makita, Hilti, Bosch Pro, DeWalt, Fluke, Milwakee, etc.)
- Specialized tool geometry (SDS-plus chucks, laser apertures, digital displays, precision dials)
- Industrial-grade construction (metal housings, reinforced components)
- Model/serial number plates
- Professional-grade features (variable speed triggers, torque settings, battery indicators)

CONSUMABLES indicators:
- Simple packaging, no brand-specific tool geometry
- Cables, fasteners, connectors, cable ties, adhesive, tape
- Basic hand tools (screwdrivers, pliers, wrenches without brand marking)

Return JSON: {
  "detected_items": [{
    "name": string,
    "classification": "CAPITAL_EQUIPMENT" | "CONSUMABLE",
    "confidence": float,
    "brand": string or null,
    "estimated_value_category": "low" | "medium" | "high",
    "reasoning": string
  }],
  "summary": {
    "total_items": int,
    "capital_equipment_found": int,
    "consumables": int,
    "estimated_recoverable_value": string,
    "recommendation": string
  }
}`;

/**
 * Run Experiment 2: Hidden Asset Detection
 */
export async function runExperiment2(imageBase64, erpCategory) {
  const userPrompt = `This item is currently classified in the ERP system as: "${erpCategory}"

Analyze the photo and determine if any items visible are HIGH-VALUE CAPITAL EQUIPMENT misclassified as consumables/materials.
Look for professional tools, brand logos, specialized equipment that would be capital assets (>$500 value).
If you see consumables, note those too. Be specific about which items need reclassification.`;

  const result = await openrouter.analyzeImage(SYSTEM_PROMPT, userPrompt, imageBase64);
  return {
    ...extractJson(result.text),
    raw_text: result.text,
    usage: result.usage,
    timestamp: new Date().toISOString()
  };
}

function extractJson(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    return { error: 'No JSON found in response', raw: text };
  } catch {
    return { error: 'Failed to parse JSON', raw: text };
  }
}

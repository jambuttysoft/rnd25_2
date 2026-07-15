import { openrouter } from './openrouter.js';

const SYSTEM_PROMPT = `You are an infrastructure integrity inspector for data center equipment.
Your task is to verify not just that equipment is PHYSICALLY PRESENT, but that it is FUNCTIONALLY INTEGRATED.

Check these 4 integration indicators:
1. PATCH CORDS — Are network/patch cables inserted into switch/router ports?
2. POWER CONNECTIVITY — Are power cables connected to PSU slots?
3. LINK LEDS — Are front-panel link/activity LEDs illuminated?
4. CABLE MANAGEMENT — Are cable management channels populated with routed cabling?

Return JSON: {
  "integration_status": {
    "patch_cords_connected": bool,
    "patch_cords_confidence": float,
    "power_connected": bool,
    "power_confidence": float,
    "link_leds_lit": bool,
    "leds_confidence": float,
    "cable_management_populated": bool,
    "cable_mgmt_confidence": float
  },
  "integration_score": int (0-4, sum of verified indicators),
  "verdict": "FULLY_INTEGRATED" | "PARTIALLY_INTEGRATED" | "NOT_INTEGRATED",
  "detected_equipment": [{
    "name": string,
    "type": string,
    "has_cables": bool,
    "has_power": bool,
    "led_status": string or null
  }],
  "audit_notes": string
}`;

/**
 * Run Experiment 3: Infrastructure Integrity Control
 */
export async function runExperiment3(imageBase64, nodeLabel) {
  const userPrompt = `Inspect this infrastructure node: ${nodeLabel}

Analyze the photo for functional integration. Check:
1. Are patch cords inserted into the equipment ports? Look closely at switch/router faceplates.
2. Are power cables connected to the power supply units?
3. Are any front-panel LEDs illuminated (green/amber)?
4. Is cable management populated?

Note that equipment may be physically mounted but NOT functionally connected.
This is critical for detecting fraudulent acceptance certificates.`;

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

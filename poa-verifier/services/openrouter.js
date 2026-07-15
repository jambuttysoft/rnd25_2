import 'dotenv/config';

const MAX_RETRIES = 2;
const INITIAL_TIMEOUT_MS = 60000;
const RETRY_TIMEOUT_MS = 90000;
const BACKOFF_BASE_MS = 2000;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class OpenRouterService {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.primaryModel = process.env.VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct';
    this.fallbackModel1 = process.env.FALLBACK_MODEL_1 || 'qwen/qwen2.5-vl-7b-instruct';
    this.fallbackModel2 = process.env.FALLBACK_MODEL_2 || 'openai/gpt-4o';
    this.baseUrl = 'https://openrouter.ai/api/v1';
  }

  /**
   * Core inference — direct HTTP call to OpenRouter with retry, timeout, and fallback.
   * @param {string} systemInstruction
   * @param {string} userPrompt
   * @param {Array<{data?:string,url?:string,mimeType?:string}>} images
   * @param {object} options - { model, temperature, maxTokens, maxRetries, timeoutMs }
   */
  async analyze(systemInstruction, userPrompt, images = [], options = {}) {
    const messages = [];

    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }

    const contentParts = [{ type: 'text', text: userPrompt }];

    for (const img of images) {
      if (img.data) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType || 'image/jpeg'};base64,${img.data}` }
        });
      } else if (img.url) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: img.url }
        });
      }
    }

    messages.push({ role: 'user', content: contentParts });

    const requestedModel = options.model || this.primaryModel;
    const maxRetries = options.maxRetries ?? MAX_RETRIES;

    return await this._callWithRetry(messages, requestedModel, options, maxRetries);
  }

  async _callOnce(messages, model, options) {
    const timeoutMs = options.timeoutMs ?? INITIAL_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'PoA-Verification-Pipeline'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.1,
          max_tokens: options.maxTokens || 2048
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        console.error(`[OpenRouter] HTTP ${response.status} for model ${model}`);
        console.error('[OpenRouter] Response body:', errBody.slice(0, 500));
        const err = new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
        err.statusCode = response.status;
        err.body = errBody;
        err.model = model;
        throw err;
      }

      const json = await response.json();
      const text = json.choices?.[0]?.message?.content || '';
      const usage = json.usage || { prompt_tokens: 0, completion_tokens: 0 };

      return {
        text,
        model,
        usage: {
          inputTokens: usage.prompt_tokens || 0,
          outputTokens: usage.completion_tokens || 0
        }
      };
    } catch (err) {
      if (err.name === 'AbortError') {
        const wrapped = new Error(`OpenRouter request timed out after ${timeoutMs}ms (model: ${model})`);
        wrapped.statusCode = 504;
        wrapped.model = model;
        throw wrapped;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async _callWithRetry(messages, model, options, retriesLeft) {
    let lastErr;

    for (let attempt = 0; attempt <= retriesLeft; attempt++) {
      try {
        return await this._callOnce(messages, model, {
          ...options,
          timeoutMs: attempt === 0 ? INITIAL_TIMEOUT_MS : RETRY_TIMEOUT_MS
        });
      } catch (err) {
        lastErr = err;

        if (err.statusCode && !RETRYABLE_STATUS.has(err.statusCode)) {
          throw err;
        }

        if (attempt < retriesLeft) {
          const backoff = BACKOFF_BASE_MS * Math.pow(2, attempt);
          console.warn(`[OpenRouter] Attempt ${attempt + 1} failed (${err.statusCode || err.message}). Retrying in ${backoff}ms…`);
          await sleep(backoff);
          continue;
        }

        console.warn(`[OpenRouter] All ${retriesLeft + 1} retries exhausted for ${model}.`);
      }
    }

    const fallbackChain = this._fallbackChainFor(model);
    for (const fbModel of fallbackChain) {
      console.warn(`[OpenRouter] Falling back to ${fbModel}…`);
      try {
        return await this._callOnce(messages, fbModel, { ...options, timeoutMs: RETRY_TIMEOUT_MS });
      } catch (err) {
        console.error(`[OpenRouter] Fallback ${fbModel} also failed: ${err.message}`);
        lastErr = err;
      }
    }

    throw lastErr;
  }

  _fallbackChainFor(startModel) {
    const all = [this.primaryModel, this.fallbackModel1, this.fallbackModel2];
    const idx = all.indexOf(startModel);
    if (idx === -1) return all;
    return all.slice(idx + 1);
  }

  async analyzeImage(systemPrompt, userPrompt, imageBase64, mimeType = 'image/jpeg') {
    const images = imageBase64 ? [{ data: imageBase64, mimeType }] : [];
    return this.analyze(systemPrompt, userPrompt, images);
  }
}

export const openrouter = new OpenRouterService();

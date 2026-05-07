const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4.1-mini";
const MAX_BRAND_NAME_LENGTH = 120;
const OPENAI_TIMEOUT_MS = 25000;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return Promise.resolve(req.body);
  }

  if (typeof req.body === "string") {
    try {
      return Promise.resolve(JSON.parse(req.body));
    } catch (error) {
      return Promise.reject(new Error("Invalid JSON request body"));
    }
  }

  return new Promise((resolve, reject) => {
    let rawBody = "";

    req.on("data", (chunk) => {
      rawBody += chunk;

      if (rawBody.length > 16 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!rawBody) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(rawBody));
      } catch (error) {
        reject(new Error("Invalid JSON request body"));
      }
    });

    req.on("error", reject);
  });
}

function normalizeBrandScore(result) {
  return {
    score: Math.max(0, Math.min(100, Number(result.score) || 0)),
    strengths: Array.isArray(result.strengths) ? result.strengths.slice(0, 5) : [],
    weaknesses: Array.isArray(result.weaknesses) ? result.weaknesses.slice(0, 5) : [],
    taglineSuggestion: String(result.taglineSuggestion || ""),
    colorPaletteSuggestion: Array.isArray(result.colorPaletteSuggestion)
      ? result.colorPaletteSuggestion.slice(0, 5)
      : [],
    fontPairingSuggestion: String(result.fontPairingSuggestion || "")
  };
}

function extractResponseJson(openAiResponse) {
  if (openAiResponse.output_text) {
    return JSON.parse(openAiResponse.output_text);
  }

  const message = Array.isArray(openAiResponse.output)
    ? openAiResponse.output.find((item) => item.type === "message")
    : null;
  const content = Array.isArray(message && message.content) ? message.content : [];
  const textItem = content.find((item) => item.type === "output_text" && item.text);

  if (!textItem) {
    throw new Error("OpenAI response did not include JSON text");
  }

  return JSON.parse(textItem.text);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: "OPENAI_API_KEY is not configured" });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const brandName = typeof body.brandName === "string" ? body.brandName.trim() : "";

    if (!brandName) {
      sendJson(res, 400, { error: "brandName is required" });
      return;
    }

    if (brandName.length > MAX_BRAND_NAME_LENGTH) {
      sendJson(res, 400, {
        error: `brandName must be ${MAX_BRAND_NAME_LENGTH} characters or fewer`
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

    const upstream = await fetch(OPENAI_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          {
            role: "system",
            content:
              "You are a senior brand strategist. Evaluate brand names for clarity, memorability, positioning, and visual identity potential. Return concise, practical recommendations only."
          },
          {
            role: "user",
            content: `Create a brand score analysis for this brand name: ${brandName}`
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "brand_score",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                score: {
                  type: "integer",
                  minimum: 0,
                  maximum: 100,
                  description: "Overall brand score out of 100."
                },
                strengths: {
                  type: "array",
                  minItems: 3,
                  maxItems: 5,
                  items: { type: "string" }
                },
                weaknesses: {
                  type: "array",
                  minItems: 3,
                  maxItems: 5,
                  items: { type: "string" }
                },
                taglineSuggestion: {
                  type: "string",
                  description: "One concise tagline suggestion."
                },
                colorPaletteSuggestion: {
                  type: "array",
                  minItems: 3,
                  maxItems: 5,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      hex: {
                        type: "string",
                        pattern: "^#[0-9A-Fa-f]{6}$"
                      },
                      usage: { type: "string" }
                    },
                    required: ["name", "hex", "usage"]
                  }
                },
                fontPairingSuggestion: {
                  type: "string",
                  description:
                    "A practical font pairing, including heading and body font recommendations."
                }
              },
              required: [
                "score",
                "strengths",
                "weaknesses",
                "taglineSuggestion",
                "colorPaletteSuggestion",
                "fontPairingSuggestion"
              ]
            }
          }
        },
        temperature: 0.7
      })
    }).finally(() => clearTimeout(timeout));

    const responseBody = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const message =
        responseBody.error && responseBody.error.message
          ? responseBody.error.message
          : "Unable to generate brand score";

      sendJson(res, upstream.status >= 500 ? 502 : upstream.status, { error: message });
      return;
    }

    const result = normalizeBrandScore(extractResponseJson(responseBody));
    sendJson(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate brand score";
    const isTimeout = error && error.name === "AbortError";
    const statusCode = message.includes("Invalid JSON") || message.includes("too large") ? 400 : 500;

    sendJson(res, isTimeout ? 504 : statusCode, {
      error: isTimeout ? "OpenAI request timed out" : message
    });
  }
};


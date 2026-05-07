const OPENAI_API_URL = "https://api.openai.com/v1/responses";
const MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 25000;

const TEXT_TYPES = {
  tagline: "startup taglines",
  caption: "Instagram captions",
  cta: "call-to-action button texts",
  headline: "portfolio section headlines",
  ad: "short ad copy variations",
  bio: "brand bio paragraphs"
};

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

function normalizeResults(value) {
  const results = Array.isArray(value.results) ? value.results : value;
  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, 3);
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
    const brand = typeof body.brand === "string" ? body.brand.trim() : "";
    const textType = typeof body.textType === "string" ? body.textType : "tagline";
    const typeLabel = TEXT_TYPES[textType] || TEXT_TYPES.tagline;

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
              "You are a world-class copywriter for premium brands and startups. Write concise, specific, non-generic copy."
          },
          {
            role: "user",
            content: `Generate 3 unique, powerful ${typeLabel} for this brand: "${
              brand || "a modern creative agency"
            }". Vary the tone across the 3 options.`
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "generated_text_options",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                results: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  items: { type: "string" }
                }
              },
              required: ["results"]
            }
          }
        }
      })
    }).finally(() => clearTimeout(timeout));

    const responseBody = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      const message =
        responseBody.error && responseBody.error.message
          ? responseBody.error.message
          : "Unable to generate text";

      sendJson(res, upstream.status >= 500 ? 502 : upstream.status, { error: message });
      return;
    }

    const results = normalizeResults(extractResponseJson(responseBody));
    if (results.length < 3) {
      throw new Error("OpenAI response did not include enough text options");
    }

    sendJson(res, 200, { results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to generate text";
    const isTimeout = error && error.name === "AbortError";
    const statusCode = message.includes("Invalid JSON") || message.includes("too large") ? 400 : 500;

    sendJson(res, isTimeout ? 504 : statusCode, {
      error: isTimeout ? "OpenAI request timed out" : message
    });
  }
};

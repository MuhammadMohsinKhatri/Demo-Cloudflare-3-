import controls from "../seed/controls.json";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dims
const LLM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Input limits: keep Workers AI cost bounded and stay inside Vectorize limits
// (id <= 64 bytes, metadata <= 10 KiB).
const MAX_DOCS = 100;
const MAX_ID = 64;
const MAX_TEXT = 4000;
const MAX_EVIDENCE = 8000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
}

async function keyMatches(provided, expected) {
  const enc = new TextEncoder();
  // Hash both sides so lengths match, then compare in constant time.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided ?? "")),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-api-key",
    },
  });

async function embed(env, texts) {
  const out = await env.AI.run(EMBED_MODEL, { text: texts });
  return out.data;
}

async function indexDocs(env, docs) {
  const BATCH = 50;
  for (let i = 0; i < docs.length; i += BATCH) {
    const slice = docs.slice(i, i + BATCH);
    const vectors = await embed(env, slice.map((d) => d.text));
    await env.VECTORIZE.upsert(
      slice.map((d, j) => ({
        id: d.id,
        values: vectors[j],
        metadata: { criteria: d.criteria ?? "", text: d.text },
      }))
    );
  }
  return docs.length;
}

async function search(env, query, topK = 5) {
  const [vec] = await embed(env, [query]);
  const res = await env.VECTORIZE.query(vec, { topK, returnMetadata: "all" });
  return res.matches.map((m) => ({
    id: m.id,
    score: Number(m.score.toFixed(4)),
    criteria: m.metadata?.criteria,
    text: m.metadata?.text,
  }));
}

async function audit(env, evidence) {
  const matches = await search(env, evidence, 4);
  // Without retrieved controls the LLM would grade against controls it invents.
  if (!matches.length)
    throw new HttpError(503, "No controls indexed yet: POST /seed, then retry in a minute");
  const context = matches
    .map((m) => `[${m.id}] (${m.criteria}) ${m.text}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a SOC 2 audit assistant. Using ONLY the controls provided, assess the evidence. " +
        "For each relevant control give: control ID, status (Satisfied / Partial / Gap), a one-sentence reason, " +
        "and a recommended remediation if not Satisfied. Cite control IDs in brackets. " +
        "If evidence is insufficient to judge, say so. Do not invent facts about the organization.",
    },
    {
      role: "user",
      content: `CONTROLS:\n${context}\n\nEVIDENCE:\n${evidence}`,
    },
  ];

  const ai = await env.AI.run(LLM_MODEL, { messages, max_tokens: 700 });
  return { retrieved_controls: matches, analysis: ai.response };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (req.method === "OPTIONS") return json({});

      // API key auth: set with `npx wrangler secret put API_KEY`
      if (url.pathname !== "/") {
        if (!env.API_KEY)
          return json({ error: "Server misconfigured: API_KEY secret not set" }, 500);
        if (!(await keyMatches(req.headers.get("x-api-key"), env.API_KEY)))
          return json({ error: "Unauthorized" }, 401);
      }

      if (url.pathname === "/") {
        return json({
          name: "SOC 2 Vectorize demo",
          endpoints: {
            "POST /seed": "index the built-in SOC 2 controls",
            "POST /index": "index custom docs: [{id, criteria, text}]",
            "GET /query?q=...": "semantic search over controls",
            "POST /audit": "body {evidence: '...'} -> mapped controls + gap analysis",
          },
        });
      }

      if (url.pathname === "/seed" && req.method === "POST") {
        return json({ indexed: await indexDocs(env, controls) });
      }

      if (url.pathname === "/index" && req.method === "POST") {
        const docs = await readJson(req);
        const valid =
          Array.isArray(docs) &&
          docs.length > 0 &&
          docs.length <= MAX_DOCS &&
          docs.every(
            (d) =>
              typeof d?.id === "string" &&
              d.id &&
              new TextEncoder().encode(d.id).length <= MAX_ID &&
              typeof d.text === "string" &&
              d.text &&
              d.text.length <= MAX_TEXT &&
              (d.criteria === undefined || typeof d.criteria === "string")
          );
        if (!valid)
          return json({
            error: `Body must be 1-${MAX_DOCS} items of {id (<=${MAX_ID} bytes), text (<=${MAX_TEXT} chars), criteria?}`,
          }, 400);
        return json({ indexed: await indexDocs(env, docs) });
      }

      if (url.pathname === "/query" && req.method === "GET") {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "Missing ?q=" }, 400);
        if (q.length > MAX_TEXT) return json({ error: `q must be <= ${MAX_TEXT} chars` }, 400);
        return json(await search(env, q));
      }

      if (url.pathname === "/audit" && req.method === "POST") {
        const evidence = (await readJson(req))?.evidence;
        if (typeof evidence !== "string" || !evidence.trim())
          return json({ error: "Missing evidence" }, 400);
        if (evidence.length > MAX_EVIDENCE)
          return json({ error: `evidence must be <= ${MAX_EVIDENCE} chars` }, 400);
        return json(await audit(env, evidence));
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "Internal error" }, 500);
    }
  },
};

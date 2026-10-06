import controls from "../seed/controls.json";

const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"; // 768 dims
const LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct";

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
        if (req.headers.get("x-api-key") !== env.API_KEY)
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
        const docs = await req.json();
        if (!Array.isArray(docs) || !docs.every((d) => d.id && d.text))
          return json({ error: "Body must be [{id, text, criteria?}]" }, 400);
        return json({ indexed: await indexDocs(env, docs) });
      }

      if (url.pathname === "/query" && req.method === "GET") {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "Missing ?q=" }, 400);
        return json(await search(env, q));
      }

      if (url.pathname === "/audit" && req.method === "POST") {
        const { evidence } = await req.json();
        if (!evidence) return json({ error: "Missing evidence" }, 400);
        return json(await audit(env, evidence));
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: String(err?.message ?? err) }, 500);
    }
  },
};

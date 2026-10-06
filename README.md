# SOC 2 Audit Agent: Cloudflare Vectorize demo

A Cloudflare Worker that embeds SOC 2 control descriptions with Workers AI, stores them in
Vectorize, and exposes semantic search plus an LLM-powered gap analysis endpoint (RAG).

**Stack:** Workers · Workers AI (`bge-base-en-v1.5`, `llama-3.3-70b-instruct-fp8-fast`) · Vectorize

## Setup
```bash
npm install
npx wrangler login
npm run create-index      # 768 dims, cosine
npm run deploy
npx wrangler secret put API_KEY      # choose any long random string
curl -X POST https://<your-worker>.workers.dev/seed -H "x-api-key: YOUR_KEY"
```
Vectorize is eventually consistent, so wait a few seconds after seeding before querying.

## Usage
```bash
# Semantic search
curl "https://<worker>/query?q=how+do+we+review+who+has+access" -H "x-api-key: YOUR_KEY"

# Audit: map evidence to controls and get gap analysis
curl -X POST https://<worker>/audit -H "content-type: application/json" -H "x-api-key: YOUR_KEY" \
  -d '{"evidence":"We use Okta SSO with MFA. Access reviews are done annually. Offboarding is manual."}'
```

## Architecture
evidence → embed (Workers AI) → Vectorize top-K controls → LLM with controls as context → cited findings

## Notes
- Control text is a paraphrased summary of AICPA Trust Services Criteria, not official wording.
- Output is an assistive draft, not an audit opinion.
- All endpoints except `/` require an `x-api-key` header matching the `API_KEY` secret.
- Next steps: R2 for evidence docs, D1 for findings history, chunking for long policies.

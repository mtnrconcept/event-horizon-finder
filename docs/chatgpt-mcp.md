# EVENTA MCP for ChatGPT

EVENTA exposes a public, read-only MCP endpoint at:

```text
https://YOUR_PUBLIC_EVENTA_DOMAIN/mcp
```

The server uses the Streamable HTTP transport and advertises three idempotent tools:

- `search(query)` — standard connector search returning `id`, `title`, and canonical `url`.
- `fetch(id)` — standard connector fetch returning the full event text and citation URL.
- `discover_events(...)` — recommendations filtered by geography, dates, category, genre, price, tickets, verification, and accessibility.

No Supabase service-role credential is used. The endpoint can only read rows already exposed to the public catalogue through RLS and public discovery RPCs.

## Connect in ChatGPT

1. Deploy EVENTA on a public HTTPS domain. Disable Vercel Deployment Protection for this production endpoint, or expose `/mcp` through a public custom domain.
2. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
3. Open **Settings → Plugins**, create a developer-mode app, and enter `https://YOUR_PUBLIC_EVENTA_DOMAIN/mcp` as the MCP server URL.
4. Confirm that ChatGPT discovers `search`, `fetch`, and `discover_events`.
5. Start a new chat, enable EVENTA from the `+` menu, then try: “Trouve-moi trois soirées techno à Genève ce week-end à moins de 40 CHF.”

## Low-cost protocol check

```bash
curl --fail-with-body https://YOUR_PUBLIC_EVENTA_DOMAIN/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"eventa-check","version":"1.0.0"}}}'
```

Then call `tools/list` with another JSON-RPC request. For a full host-loop check, use ChatGPT Developer Mode or MCP Inspector against the deployed `/mcp` URL.

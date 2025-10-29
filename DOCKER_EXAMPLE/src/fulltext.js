import express from "express";
const router = express.Router();
const { Client } = require("@elastic/elasticsearch");

// ---- Config ----
// env expected in project README (ELASTIC_URL, ELASTIC_USER, ELASTIC_PASS)
// Fallbacks allow running against local dev with basic auth disabled.
const es = new Client({
  node: process.env.ELASTIC_URL || "http://localhost:9000",
  auth:
    process.env.ELASTIC_USER && process.env.ELASTIC_PASS
      ? { username: process.env.ELASTIC_USER, password: process.env.ELASTIC_PASS }
      : undefined,
  tls: { rejectUnauthorized: false }, 
});

// Index pattern for logs.
//const INDEX = process.env.LOG_INDEX_PATTERN || "logs-*";

// input guards
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// ---- Route: POST /api/fulltext/search ----
// Example Request in below comments
// Body:
// {
//   "q": "\"connection reset\" | timeout~1",
//   "services": ["payments-api","auth-api"],
//   "levels": ["error","warn"],
//   "time": { "gte": "now-6h", "lte": "now" },
//   "size": 100,
//   "pit": { "id": "<from previous page>", "keep_alive": "1m" },
//   "cursor": ["<search_after sort values array>"]
// }
router.post("/search", async (req, res) => {
  try {
    const {
      q = '"error" | timeout',
      services = [],
      levels = [],
      time = { gte: "now-24h", lte: "now" },
      size = 100,
      pit, // { id, keep_alive }
      cursor, // search_after array from previous page
      // Advanced toggles
      highlight = true,
      includeTimeline = true,
      includeFacets = true,
    } = req.body || {};

    // Build the main lexical legs
    const must = [
      {
        // Fault-tolerant query syntax safe for end-user input
        // https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-simple-query-string-query
        simple_query_string: {
          query: q,
          fields: ["message^4", "service", "path", "error.code", "host"],
          default_operator: "and",
        },
      },
      // Lightweight typo-tolerant backup leg (does not parse operators)
      {
        multi_match: {
          query: String(q).replace(/[^\w\s"]/g, " "),
          fields: ["message^3", "path", "service", "host"],
          fuzziness: "AUTO",
          prefix_length: 2,
        },
      },
    ];

    const filter = [
      { range: { "@timestamp": { gte: time.gte || "now-24h", lte: time.lte || "now" } } },
      ...(asArray(levels).length ? [{ terms: { level: asArray(levels) } }] : []),
      ...(asArray(services).length ? [{ terms: { service: asArray(services) } }] : []),
    ];

    const body = {
      size: Math.min(Number(size) || 50, 1000),
      track_total_hits: true,
      // Time-decay ranking: prefer recency without excluding older docs
      // https://www.elastic.co/docs/reference/elasticsearch/rest-apis/rescore-search-results (note decay in function_score)
      query: {
        function_score: {
          query: { bool: { must, filter } },
          functions: [
            { exp: { "@timestamp": { origin: "now", scale: "2h", decay: 0.6 } } },
          ],
          score_mode: "multiply",
          boost_mode: "multiply",
        },
      },
      sort: [{ "@timestamp": "desc" }, { _shard_doc: "desc" }],
      _source: {
        includes: ["@timestamp", "level", "service", "error.code", "host", "path", "message"],
      },
    };

    // Optional precise reranking for the top window (phrase match boost)
    // https://www.elastic.co/docs/reference/elasticsearch/rest-apis/rescore-search-results
    body.rescore = {
      window_size: Math.min(1000, body.size),
      query: {
        rescore_query: {
          match_phrase: {
            message: {
              query: "connection reset",
              slop: 1,
              boost: 6,
            },
          },
        },
        query_weight: 1,
        rescore_query_weight: 2,
      },
    };

    if (highlight) {
      body.highlight = {
        fields: { message: { fragment_size: 180, number_of_fragments: 1 } },
      };
    }

    if (includeFacets) {
      body.aggs = {
        by_service: { terms: { field: "service", size: 25 } },
        by_level: { terms: { field: "level", size: 8 } },
        by_error_code: { terms: { field: "error.code", size: 20 } },
      };
    }

    if (includeTimeline) {
      body.aggs = {
        ...(body.aggs || {}),
        timeline: { date_histogram: { field: "@timestamp", fixed_interval: "5m" } },
      };
    }

    // Use PIT + search_after for stable deep pagination (avoid from/size)
    // First page without PIT: we open one. If client supplies pit.id, reuse it.
    let pitId = pit?.id;
    const keepAlive = pit?.keep_alive || "1m";
    if (!pitId) {
      const pitRes = await es.openPointInTime({ index: INDEX, keep_alive: keepAlive });
      pitId = pitRes?.body?.id || pitRes?.id;
    }
    body.pit = { id: pitId, keep_alive: keepAlive };
    if (Array.isArray(cursor) && cursor.length) body.search_after = cursor;

    const resp = await es.search({ body });

    const hits = (resp.body?.hits?.hits || resp.hits?.hits || []).map((h) => ({
      id: h._id,
      sort: h.sort, // pass back for next-page cursor
      ts: h._source?.["@timestamp"],
      level: h._source?.level,
      service: h._source?.service,
      code: h._source?.error?.code,
      host: h._source?.host,
      path: h._source?.path,
      message: h._source?.message,
      snippet: h.highlight?.message?.[0],
      score: h._score,
    }));

    // Return a fresh PIT id to keep pagination stable
    // (ES may rotate PIT ids; we keep it alive for the caller)
    const nextPitId = resp.body?.pit_id || pitId;

    res.json({
      ok: true,
      total: resp.body?.hits?.total || resp.hits?.total,
      pit: { id: nextPitId, keep_alive: keepAlive },
      hits,
      facets: resp.body?.aggregations
        ? {
            services: resp.body.aggregations.by_service?.buckets || [],
            levels: resp.body.aggregations.by_level?.buckets || [],
            errorCodes: resp.body.aggregations.by_error_code?.buckets || [],
          }
        : undefined,
      timeline: resp.body?.aggregations?.timeline?.buckets || undefined,
      // For pagination: use the last hit's sort values as the next cursor
      nextCursor: hits.length ? hits[hits.length - 1].sort : null,
    });
  } catch (err) {
    console.error("[fulltext/search] error:", err?.meta?.body || err);
    const status = err?.statusCode || err?.meta?.statusCode || 500;
    res.status(status).json({
      ok: false,
      error: err?.meta?.body?.error || err?.message || "Search error",
    });
  }
});

// ---- Route: POST /api/fulltext/close-pit ----
// Close a PIT when the client is done paginating.
router.post("/close-pit", async (req, res) => {
  try {
    const id = req.body?.id;
    if (!id) return res.status(400).json({ ok: false, error: "Missing PIT id" });
    await es.closePointInTime({ body: { id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("[fulltext/close-pit] error:", err?.meta?.body || err);
    const status = err?.statusCode || err?.meta?.statusCode || 500;
    res.status(status).json({
      ok: false,
      error: err?.meta?.body?.error || err?.message || "Close PIT error",
    });
  }
});

export default router;

#!/usr/bin/env node

require("dotenv").config();

const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");

const SEED_URL = "https://en.tbsn.org/master/index/1.html";
const ALLOWED_HOST = "en.tbsn.org";
const MAX_PAGES = Number.parseInt(process.env.MAX_TBSN_PAGES || "50", 10);
const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";
const CRAWL_DELAY_MS = Number.parseInt(process.env.TBSN_CRAWL_DELAY_MS || "500", 10);
const USER_AGENT = "TBS-V2-Knowledge-Ingester/1.0 (+official-source-attribution)";
const CHUNK_TARGET_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 180;
const MIN_BODY_CHARS = 300;
const VALID_DETAIL_PATH_PATTERN = /^\/master\/detail\/\d+\/[^/]+\.html$/i;

const SKIP_PATH_PATTERNS = [
  /\/user\b/i,
  /\/member\b/i,
  /\/login\b/i,
  /\/logout\b/i,
  /\/register\b/i,
  /\/admin\b/i,
  /\/search\b/i,
  /\/api\b/i,
  /\/cart\b/i,
  /\/privacy\b/i,
  /\/contact\b/i,
];

const stats = {
  pagesFetched: 0,
  sourcesUpserted: 0,
  chunksUpserted: 0,
  skippedPages: 0,
  errors: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hash(input) {
  return crypto.createHash("sha256").update(String(input || ""), "utf8").digest("hex");
}

function slug(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeWhitespace(input) {
  return String(input || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(input) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };

  return String(input || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const isHex = key[1] === "x";
      const value = Number.parseInt(key.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return Object.prototype.hasOwnProperty.call(entities, key) ? entities[key] : match;
  });
}

function stripTags(html) {
  return decodeHtmlEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
}

function removeHtmlNoise(html) {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<header\b[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ");
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = String(html || "").match(pattern);
    if (match && match[1]) {
      return normalizeWhitespace(stripTags(match[1]));
    }
  }
  return "";
}

function extractTitle(html) {
  const ogTitle = firstMatch(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i,
  ]);
  if (ogTitle) return ogTitle;

  const h1 = firstMatch(html, [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i]);
  if (h1) return h1;

  const title = firstMatch(html, [/<title\b[^>]*>([\s\S]*?)<\/title>/i]);
  return title.replace(/\s*[-|]\s*True Buddha School.*$/i, "").trim();
}

function extractCategory(url, html) {
  const breadcrumb = firstMatch(html, [
    /<[^>]+class=["'][^"']*(?:breadcrumb|crumb|path|nav_path)[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i,
  ]);
  if (breadcrumb) return breadcrumb;

  const pathParts = new URL(url).pathname.split("/").filter(Boolean);
  if (pathParts.length > 0) return pathParts[0];
  return "official";
}

function extractBodyText(html) {
  const cleaned = removeHtmlNoise(html);
  const candidates = [];
  const candidatePatterns = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/gi,
    /<main\b[^>]*>([\s\S]*?)<\/main>/gi,
    /<div\b[^>]+class=["'][^"']*(?:content|article|detail|main|text|master)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi,
  ];

  for (const pattern of candidatePatterns) {
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
      const text = normalizeWhitespace(stripTags(match[1]));
      if (text.length >= MIN_BODY_CHARS) candidates.push(text);
    }
  }

  if (candidates.length > 0) {
    return candidates.sort((a, b) => b.length - a.length)[0];
  }

  return normalizeWhitespace(stripTags(cleaned));
}

function chunkText(text) {
  const paragraphs = normalizeWhitespace(text)
    .split(/\n{2,}/)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!current) {
      current = paragraph;
      continue;
    }

    if ((current + "\n\n" + paragraph).length <= CHUNK_TARGET_CHARS) {
      current = `${current}\n\n${paragraph}`;
      continue;
    }

    chunks.push(current);
    const overlap = current.slice(-CHUNK_OVERLAP_CHARS);
    current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
  }

  if (current) chunks.push(current);

  return chunks
    .map((chunk) => normalizeWhitespace(chunk))
    .filter((chunk) => chunk.length > 0);
}

function normalizeUrl(href, baseUrl) {
  try {
    const url = new URL(href, baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function isRelevantTbsnUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return false;
  }

  if (url.protocol !== "https:") return false;
  if (url.hostname !== ALLOWED_HOST) return false;
  if (urlString.toLowerCase().includes("facebook.com")) return false;
  if (!url.pathname.startsWith("/master/")) return false;
  if (SKIP_PATH_PATTERNS.some((pattern) => pattern.test(url.pathname))) return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|mp3|mp4|mov)$/i.test(url.pathname)) return false;

  return true;
}

function isListingPageUrl(urlString) {
  try {
    return new URL(urlString).pathname.startsWith("/master/index");
  } catch {
    return false;
  }
}

function isContentPageUrl(urlString) {
  try {
    return VALID_DETAIL_PATH_PATTERN.test(new URL(urlString).pathname);
  } catch {
    return false;
  }
}

function isInvalidDetailUrl(urlString) {
  try {
    const url = new URL(urlString);
    return url.pathname.startsWith("/master/detail/") && !isContentPageUrl(urlString);
  } catch {
    return false;
  }
}

function extractLinks(html, baseUrl) {
  const links = new Set();
  const anchorPattern = /<a\b[^>]+href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    const fullUrl = normalizeUrl(href, baseUrl);
    if (!fullUrl) continue;
    if (isInvalidDetailUrl(fullUrl)) {
      console.log(`[reject] invalid detail URL: ${fullUrl}`);
      continue;
    }
    if (isRelevantTbsnUrl(fullUrl)) links.add(fullUrl);
  }

  return [...links];
}

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error(`Skipped non-HTML response: ${contentType}`);
  }

  return response.text();
}

function buildSourceRow(url, title, category, bodyText) {
  const sourceKey = `tbsn-${slug(url)}`;
  const contentHash = hash(`${url}\n${title}\n${bodyText}`);

  return {
    source_key: sourceKey,
    url,
    canonical_url: url,
    domain: ALLOWED_HOST,
    title,
    category,
    source_type: "official_page",
    language: "en",
    trust_level: "official",
    priority: 90,
    attribution: "Official True Buddha School Net source",
    status: "active",
    content_hash: contentHash,
    metadata: {
      seed_url: SEED_URL,
      crawler: "scripts/ingest-tbsn-corpus.cjs",
    },
    fetched_at: new Date().toISOString(),
  };
}

function buildChunkRows(sourceId, sourceRow, chunks) {
  return chunks.map((chunk, index) => {
    const contentHash = hash(`${sourceRow.url}\n${index}\n${chunk}`);

    return {
      source_id: sourceId,
      chunk_key: `${sourceRow.source_key}-chunk-${String(index + 1).padStart(4, "0")}`,
      chunk_index: index + 1,
      source_title: sourceRow.title,
      source_url: sourceRow.url,
      category: sourceRow.category,
      language: sourceRow.language,
      chunk_text: chunk,
      english_translation: null,
      summary: null,
      tags: [],
      entities: [],
      doctrinal_theme: null,
      trust_level: sourceRow.trust_level,
      priority: sourceRow.priority,
      char_count: chunk.length,
      content_hash: contentHash,
      metadata: {
        source_key: sourceRow.source_key,
        attribution: sourceRow.attribution,
      },
    };
  });
}

async function upsertSourceAndChunks(supabase, sourceRow, chunkRows) {
  const { data: source, error: sourceError } = await supabase
    .from("tbs_sources")
    .upsert(sourceRow, { onConflict: "url" })
    .select("id")
    .single();

  if (sourceError) {
    throw new Error(`source upsert failed: ${sourceError.message}`);
  }

  const rows = buildChunkRows(source.id, sourceRow, chunkRows.map((row) => row.chunk_text));
  const { error: chunkError } = await supabase
    .from("tbs_knowledge_chunks")
    .upsert(rows, { onConflict: "chunk_key" });

  if (chunkError) {
    throw new Error(`chunk upsert failed: ${chunkError.message}`);
  }

  stats.sourcesUpserted += 1;
  stats.chunksUpserted += rows.length;
}

function createSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required unless DRY_RUN=true.");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

async function ingest() {
  const maxPages = Number.isFinite(MAX_PAGES) && MAX_PAGES > 0 ? MAX_PAGES : 50;
  const supabase = DRY_RUN ? null : createSupabaseClient();
  const queue = [SEED_URL];
  const seen = new Set();

  console.log(`[TBSN ingest] seed=${SEED_URL}`);
  console.log(`[TBSN ingest] dryRun=${DRY_RUN} maxPages=${maxPages}`);

  while (queue.length > 0 && stats.pagesFetched < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);

    if (!isRelevantTbsnUrl(url)) {
      stats.skippedPages += 1;
      console.log(`[skip] irrelevant: ${url}`);
      continue;
    }

    try {
      console.log(`[fetch] ${url}`);
      const html = await fetchPage(url);
      stats.pagesFetched += 1;

      const links = extractLinks(html, url);
      for (const link of links) {
        if (!seen.has(link) && queue.length + seen.size < maxPages * 4) {
          queue.push(link);
        }
      }

      if (isListingPageUrl(url)) {
        stats.skippedPages += 1;
        console.log(`[skip] listing page: ${url}`);
        if (CRAWL_DELAY_MS > 0) await sleep(CRAWL_DELAY_MS);
        continue;
      }

      if (!isContentPageUrl(url)) {
        stats.skippedPages += 1;
        if (isInvalidDetailUrl(url)) {
          console.log(`[reject] invalid detail URL: ${url}`);
        } else {
          console.log(`[skip] non-content page: ${url}`);
        }
        if (CRAWL_DELAY_MS > 0) await sleep(CRAWL_DELAY_MS);
        continue;
      }

      const title = extractTitle(html) || url;
      const category = extractCategory(url, html);
      const bodyText = extractBodyText(html);

      if (bodyText.length < MIN_BODY_CHARS) {
        stats.skippedPages += 1;
        console.log(`[skip] short body (${bodyText.length} chars): ${url}`);
        continue;
      }

      const chunks = chunkText(bodyText);
      const sourceRow = buildSourceRow(url, title, category, bodyText);
      const chunkRows = buildChunkRows("dry-run-source-id", sourceRow, chunks);

      console.log(`[parse] title="${title}" category="${category}" chars=${bodyText.length} chunks=${chunks.length}`);

      if (DRY_RUN) {
        stats.sourcesUpserted += 1;
        stats.chunksUpserted += chunks.length;
      } else {
        await upsertSourceAndChunks(supabase, sourceRow, chunkRows);
      }

      if (CRAWL_DELAY_MS > 0) await sleep(CRAWL_DELAY_MS);
    } catch (error) {
      stats.errors += 1;
      console.warn(`[error] ${url}: ${error.message}`);
    }
  }

  console.log("[TBSN ingest] complete");
  console.log(`  pages fetched: ${stats.pagesFetched}`);
  console.log(`  sources ${DRY_RUN ? "parsed" : "upserted"}: ${stats.sourcesUpserted}`);
  console.log(`  chunks ${DRY_RUN ? "parsed" : "upserted"}: ${stats.chunksUpserted}`);
  console.log(`  skipped pages: ${stats.skippedPages}`);
  console.log(`  errors: ${stats.errors}`);
}

ingest().catch((error) => {
  console.error(`[TBSN ingest] fatal: ${error.message}`);
  process.exitCode = 1;
});

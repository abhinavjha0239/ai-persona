-- ============================================================
-- Supabase pgvector Setup for AI Persona RAG
-- ============================================================
-- Run this in Supabase SQL Editor (Dashboard → SQL Editor)
-- before running the ingestion script.
--
-- Features:
--   - Hybrid search (BM25 full-text + vector similarity)
--   - RRF (Reciprocal Rank Fusion) scoring for combining results
--   - NO vector index (brute-force is faster for <1000 vectors)
--   - Full-text search GIN index for BM25
--   - Metadata filtering via GIN index
--
-- Default: 1536d for Azure OpenAI / OpenAI text-embedding-3-small.
-- Change to 768 if using Google text-embedding-004.
-- ============================================================

-- Enable pgvector extension
create extension if not exists vector;

-- Documents table
-- NO vector index for small corpus (<1000 rows) — brute-force scan is faster
create table if not exists documents (
  id text primary key,
  content text not null,
  embedding vector(1536),
  metadata jsonb default '{}',
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz default now()
);

-- GIN index for full-text search (always beneficial)
create index if not exists documents_fts_idx
  on documents using gin (fts);

-- GIN index for metadata filtering
create index if not exists documents_metadata_idx
  on documents using gin (metadata);

-- ============================================================
-- Hybrid search function: vector + full-text with RRF fusion
-- ============================================================
-- Combines semantic similarity (vector cosine) with keyword
-- matching (PostgreSQL full-text search) using Reciprocal Rank
-- Fusion for best-of-both-worlds retrieval.
-- ============================================================

create or replace function match_documents(
  query_text text default '',
  query_embedding vector(1536) default null,
  match_count int default 8,
  similarity_threshold float default 0.3,
  full_text_weight float default 1.0,
  semantic_weight float default 1.0,
  rrf_k int default 60,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (
  id text,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  with semantic_search as (
    select
      d.id,
      d.content,
      d.metadata,
      1 - (d.embedding <=> query_embedding) as cosine_similarity,
      row_number() over (
        order by d.embedding <=> query_embedding
      ) as rank
    from documents d
    where
      query_embedding is not null
      and 1 - (d.embedding <=> query_embedding) > similarity_threshold
      and (filter_metadata = '{}'::jsonb or d.metadata @> filter_metadata)
    order by d.embedding <=> query_embedding
    limit least(match_count * 3, 30)
  ),
  full_text_search as (
    select
      d.id,
      d.content,
      d.metadata,
      ts_rank(d.fts, websearch_to_tsquery('english', query_text)) as text_score,
      row_number() over (
        order by ts_rank(d.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from documents d
    where
      query_text <> ''
      and d.fts @@ websearch_to_tsquery('english', query_text)
      and (filter_metadata = '{}'::jsonb or d.metadata @> filter_metadata)
    order by text_score desc
    limit least(match_count * 3, 30)
  )
  select
    coalesce(ss.id, fts.id) as id,
    coalesce(ss.content, fts.content) as content,
    coalesce(ss.metadata, fts.metadata) as metadata,
    (
      coalesce(semantic_weight / (rrf_k + ss.rank)::float, 0.0) +
      coalesce(full_text_weight / (rrf_k + fts.rank)::float, 0.0)
    )::float as similarity
  from semantic_search ss
  full outer join full_text_search fts on ss.id = fts.id
  order by similarity desc
  limit match_count;
end;
$$;

# StockShift Build Instructions

Treat the Notion sprint **StockShift — Finished Product Sprint** as the product source of truth.

## Goal

Build the polished commercial version, not another throwaway MVP.

Core workflow:

**PDF/XLSX/CSV → extraction → normalized product records → reconciliation → margin impact → human review → customer-specific import file.**

## Required architecture

- Vue 3 + Vite + TypeScript
- Tailwind CSS
- Supabase Postgres/Auth/Storage
- Vercel for web/API orchestration
- Python worker/service for document extraction
- PaddleOCR-VL behind a DocumentExtractor abstraction
- Stripe for billing
- durable background job model for long-running extraction

## Engineering rules

1. Preserve deterministic logic for arithmetic, prices, margins and exact identifiers.
2. Parse CSV/XLSX directly; do not send clean structured data through OCR.
3. Use PaddleOCR-VL for difficult/scanned/image-based PDFs.
4. Every uncertain match must be reviewable; never silently guess.
5. Preserve provenance: source file/page/row or bounding box.
6. Store money using decimal/numeric semantics, never binary floating point.
7. Keep document extraction provider-abstracted.
8. Keep tenant isolation and Supabase RLS in mind from first schema.
9. Do not add unrelated ERP/CRM/inventory features.
10. Prefer a clean B2B interface over decorative dashboards.

## First task for Codex

Before implementing new features, inspect the repository and produce:
- current architecture
- missing production components
- proposed final folder structure
- database schema
- background processing design
- extraction service boundary
- PaddleOCR-VL integration point
- migration path from CSV MVP to finished product
- ordered implementation plan
- proposed first implementation commit

If the existing private MVP source is not present, say so explicitly and scaffold the production app rather than pretending to preserve unavailable code.

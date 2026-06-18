# JSONL loading performance — count-then-tail bench

## Background

When a session JSONL grows to 8101 entries, the first open was extremely slow. Root cause: the backend read the full 16MB file, ran 8101 `JSON.parse` calls, then SSE-pushed all 8101 entries to the frontend — while the UI only renders the last 200 by default.

## Approach

count-then-tail (two phases):

1. **count**: Reverse byte scan, count `\n` only, no parse — `O(scannedBytes)`, typically < 50ms.
2. **tail**: Parse only the last N entries (default 200) — 200 parses instead of 8101.
3. **lazy**: Frontend "Load all" triggers REST `GET /api/sessions/:id/jsonl-history?from&limit` to fetch earlier history on demand.

## Measured data

Repro script: `mobius/tests/jsonl-loading-bench.js`

| Scenario | File size | countLines | tailCount=200 | maxLines=10000 (legacy) | tail/full |
| -------- | --------- | ---------- | ------------- | ----------------------- | --------- |
| small    | 2.6MB     | 32.0ms     | 15.7ms        | 69.3ms                  | 4.4x      |
| mid      | 17.3MB    | 47.4ms     | 7.5ms         | 146.0ms                 | 19.6x     |
| big      | 49.0MB    | 93.6ms     | 6.1ms         | 96.9ms                  | 15.9x     |

- **First-open cost** ≈ `countLines` + `tailCount=200` ≈ 40–100ms (linear in file size, independent of entry count).
- **Speedup**: small 4x, mid 20x, big 16x.

> mid (17.3MB) beats small on ratio because small uses `readFull` (one `readFileSync`) while mid uses `readTailWindow` (reverse scan). Reverse scan reads only ~256KB from the tail, decoupled from total file size.

## Behavior changes

- SSE defaults to the last 200 entries; header uses `jsonl_meta { total }` for the true count.
- Frontend `JsonlView` header still shows "8101 entries / N turns" but renders 200 by default.
- User clicks "Load all (8101 total)" to REST-fetch the remaining 7901 and prepend.

## Compatibility

- Old frontend: ignores `jsonl_meta` but still renders `jsonl_history` (shows 200 entries instead of 8101).
- Old backend: no `jsonl_meta`; frontend falls back to `jsonl_history.total`.
- `?full=1` uses the legacy path (push all at once, capped by maxLines) as an escape hatch.

## How to run

```bash
node mobius/tests/jsonl-loading-bench.js
```

Creates three temporary JSONL files (small / mid / big), runs three read strategies, prints a table and performance assertions.

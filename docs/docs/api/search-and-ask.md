---
title: 'Search and ask'
description: 'Search across all your spaces in any language, and ask one space a question with cited answers.'
---

# Search and ask

## Search across spaces

```bash
curl "https://api.spacecontext.app/v1/search?q=where+did+I+see+a+ladder&limit=5" \
  -H "Authorization: Bearer $SPACECONTEXT_API_KEY"
```

```json
{
  "object": "search_results",
  "query": "where did I see a ladder",
  "data": [
    {
      "space_id": "spc_3f…", "space_name": "Seaside flat", "scan_id": "scn_8a…",
      "record_type": "item", "record_id": "itm_12",
      "title": "Aluminium step ladder", "area": "Storage room",
      "text": "Aluminium step ladder, folded against the wall behind the door…",
      "score": 0.87
    }
  ]
}
```

| Parameter | |
| --- | --- |
| `q` | The question, 1–300 characters, in any language. |
| `space_id` | Optional. Only this space. |
| `limit` | 1–25, default 10. |

Records are items, areas, issues, key locations, instructions, facts and Q&A. Search is semantic (multilingual embeddings) with a reranker: "rubinetto dell'acqua" finds "water shut-off valve". Each result points to a record you can open with `GET /spaces/{space_id}`.

- A space appears once its current scan has been indexed: right after a scan completes, or, for spaces scanned with the app, after their deep pass.
- The index holds only redacted content: results never contain a sensitive value, whatever the key's scopes.
- Test keys search the demo space, without a model.

## Ask one space

```bash
curl -X POST https://api.spacecontext.app/v1/spaces/spc_3f…/ask \
  -H "Authorization: Bearer $SPACECONTEXT_API_KEY" -H "Content-Type: application/json" \
  -d '{"question": "Where is the water shut-off?"}'
```

```json
{
  "object": "answer",
  "space_id": "spc_3f…", "scan_id": "scn_8a…",
  "question": "Where is the water shut-off?",
  "answer": "Under the bathroom sink, behind the cupboard door.",
  "documented": true,
  "citations": [
    {
      "record_type": "key_location", "record_id": "loc_1",
      "title": "Main water valve", "area": "Bathroom",
      "evidence": [{ "frame_id": "frame-14", "timestamp_ms": 41200, "url": "https://api.spacecontext.app/v1/media/…" }]
    }
  ]
}
```

- The answer uses only the space's records. When they do not contain it, `documented` is `false` and the answer says so.
- Every citation is a record of the document; evidence URLs are signed and expire.
- A key without `spaces:sensitive` never gets a sensitive value in an answer, and the model never sees one.
- Spaces scanned with the app answer `409 ENRICHMENT_PENDING` to such a key until they are screened (usually a minute or two after the first read).
- Up to 500 characters per question. A question counts against the daily limit only once it is going to be answered: one refused for its length, or because the space is still being screened, does not. Test keys never count.

# enrichment updates
enrich process is not good at fetching datasources, manually figure out how to query the websites
e.g. the problem
> - ⚠️ USDA API: POST works but returns empty results for most plants — NCSU is the main working source
> - ⚠️ Prairie Moon / FSUS / MBG: all return 404 or are down — no data from these currently
> - ⚠️ NCSU raw HTML: browser DOM stripping removes nav better than Python regex; the 1000-char window may cut off useful content
> - ⚠️ USDA zone: NCSU reports zone 5–9 for some plants, ground truth expects 4–8 — prefer wider range when sources conflict

# the copy prompt doesn't include any data from the websources
we might need to fix the first TODO to get to this

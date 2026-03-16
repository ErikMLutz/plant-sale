# TODO

## Known issues / next steps

- [ ] Verify PPTX output quality end-to-end with a full enriched + merged dataset
- [ ] Test zip round-trip with plants that have complex HTML descriptions (nested quotes, special chars)
- [ ] Consider adding retry logic for enrichment 429 rate-limit errors (currently failed plants stay `pending` silently)
- [ ] `DEBUG` flag in `config.js` — flip to `false` before distributing to other reviewers

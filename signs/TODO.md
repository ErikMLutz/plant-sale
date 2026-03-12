- slides
  - 2 per page, space in the middle to cut
  - remove duplicate latin name
  - bigger text
  - multiple sun icons
  - drop all images stacked on top of each other for human edits
  - add prominent gold badge/star with "piedmont native" label
  - add a "review needed" status based on aggregated info from plants.csv and anything we add to compare between
    squarespace and plants.csv. this should also sort above the `plants.csv` status along with the "ai enriched" and
    "needs enriching" and "manually edited" statuses
- piedmont native
   - pull map from bonap https://bonap.net/Napa/TaxonMaps/Genus/County/Andropogon
   - check color of each county in piedmont https://www.birdforum.net/opus/File:Nc_map_w_regions_n_counties.jpg
   - if >=10% are dark green, light green, or yellow classify it as "piedmont native"
- plants.csv
   - reprocess infosheets into plants.csv programmatically to remove AI hallucinations
   - create AI compare that checks flags contradictions between plants.csv and squarespace for human review
- squarespace inventory update (lower priority)
   - tooling to update squarespace inventory description based on whats in plants.csv
   - update export -> reimport new descriptions -> squarespace is now the source of truth for signs

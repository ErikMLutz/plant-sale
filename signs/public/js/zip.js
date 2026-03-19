// ─── Zip file helpers ──────────────────────────────────────────────────────────

let zipSsFileName  = null;   // Filename of the SS inventory inside the zip
let zipSsContent   = null;   // Raw text of the SS inventory
let zipOldCsvFiles = [];     // [{name, content}] all plants.improved.*.csv from uploaded zip

const CSV_NAME_PATTERN = /^plants\.improved\.\d{8}_\d{6}\.csv$/i;

/**
 * Read a zip file and extract the SS inventory + latest plants CSV.
 * Populates zipSsFileName, zipSsContent, zipOldCsvFiles globals.
 * Returns {ssContent, latestCsvContent} — latestCsvContent may be null.
 */
async function readZipFile(file) {
  const zip = await JSZip.loadAsync(file);

  zipSsFileName  = null;
  zipSsContent   = null;
  zipOldCsvFiles = [];

  const readTasks = [];
  zip.forEach((relativePath, zipEntry) => {
    if (zipEntry.dir) return;
    const name = relativePath.replace(/^.*\//, ''); // strip any directory prefix
    if (!/^(plants|inventory)/i.test(name)) return;     // only accept known-prefixed files
    if (!/\.(csv|tsv)$/i.test(name)) return;            // only accept csv/tsv files
    readTasks.push(zipEntry.async('text').then(content => ({ name, content })));
  });

  const files = await Promise.all(readTasks);
  for (const { name, content } of files) {
    if (CSV_NAME_PATTERN.test(name)) {
      zipOldCsvFiles.push({ name, content });
    } else {
      zipSsFileName = name;
      zipSsContent  = content;
    }
  }

  // Sort by filename (timestamp embedded → lexicographic = chronological)
  zipOldCsvFiles.sort((a, b) => a.name.localeCompare(b.name));

  const latestCsvContent = zipOldCsvFiles.length > 0
    ? zipOldCsvFiles[zipOldCsvFiles.length - 1].content
    : null;

  return { ssContent: zipSsContent, latestCsvContent };
}

/**
 * Build and download a new zip containing:
 *  - The original SS inventory file
 *  - All old plants.improved.*.csv files from the uploaded zip
 *  - A new plants.improved.<datetime>.csv with the given content
 */
async function downloadZip(newCsvContent) {
  if (!zipSsFileName || !zipSsContent) {
    alert('No zip loaded — import a zip file first.');
    return;
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datetime = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const zip = new JSZip();
  zip.file(zipSsFileName, zipSsContent);
  for (const { name, content } of zipOldCsvFiles) {
    zip.file(name, content);
  }
  zip.file(`plants.improved.${datetime}.csv`, newCsvContent);

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `plant-sale-signs-data.${datetime}.plant`;
  a.click();
  URL.revokeObjectURL(a.href);
}

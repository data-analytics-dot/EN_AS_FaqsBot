// dump_canvas.js
import fetch from "node-fetch";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const CODA_API_KEY = process.env.CODA_API_KEY;
const DOC_ID = process.env.CODA_DOC_ID;
const TABLE_ID = process.env.CODA_FAQ_TABLE_ID;

if (!CODA_API_KEY || !DOC_ID || !TABLE_ID) {
  console.error("Missing env vars. Make sure CODA_API_KEY, CODA_DOC_ID and CODA_FAQ_TABLE_ID are set.");
  process.exit(1);
}

async function getColumnMap() {
  const url = `https://coda.io/apis/v1/docs/${DOC_ID}/tables/${TABLE_ID}/columns`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CODA_API_KEY}` },
  });
  const data = await res.json();
  const map = {};
  for (const col of data.items) map[col.id] = col.name;
  return map;
}

async function dump() {
  const columnMap = await getColumnMap();
  console.log("📌 Column map:", columnMap);

  const url = `https://coda.io/apis/v1/docs/${DOC_ID}/tables/${TABLE_ID}/rows`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CODA_API_KEY}` },
  });
  const data = await res.json();

  // Build friendly output: map col IDs -> names and include raw values
  const out = data.items.map(row => {
    const friendly = { rowId: row.id, values: {} };
    for (const [colId, val] of Object.entries(row.values || {})) {
      const name = columnMap[colId] || colId;
      friendly.values[name] = val;
    }
    return friendly;
  });

  // Write file
  const file = "coda_canvas_dump.json";
  fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
  console.log(`✅ Wrote ${file} (${out.length} rows).`);

  // Print the "Next Step" raw value for the first 3 rows (if present)
  for (let i = 0; i < Math.min(3, out.length); i++) {
    console.log(`\n--- Row ${i + 1} (id=${out[i].rowId}) ---`);
    if (out[i].values["Next Step"] === undefined) {
      console.log("No `Next Step` column found in this row.");
    } else {
      // pretty-print the raw JSON for the Next Step cell
      console.log(JSON.stringify(out[i].values["Next Step"], null, 2));
    }
  }

  console.log("\nIf you want only a single row, open coda_canvas_dump.json or run this script and search for the row id.");
}

dump().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});

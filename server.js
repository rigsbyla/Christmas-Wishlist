// server.js
const express = require('express');
const fs = require('fs');
const path = require('path');
// Note: Optional dependencies (multer/csv-parse) were previously attempted,
// but to keep the admin upload working without installing new packages,
// provide a simple CSV text parser and a JSON/text upload endpoint below.

const app = express();

const DATA_PATH = path.join(__dirname, 'data.json');

// --- helpers to load/save data ---

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    // if no data file exists yet, create an empty structure
    const initial = {
      people: [],
      items: []
    };
    fs.writeFileSync(DATA_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  const raw = fs.readFileSync(DATA_PATH, 'utf8');
  const data = JSON.parse(raw);

  // Normalize item fields so front-end and back-end agree.
  // Old data files used fields like `itemId`, `notes`, and `tag` (string).
  // Newer front-end expects numeric `id`, `details`, and `tags` (array).
  if (Array.isArray(data.items)) {
    // find current max id to avoid collisions
    let maxId = data.items.reduce((m, it) => Math.max(m, Number(it.id) || 0, Number(it.itemId) || 0), 0);

    data.items.forEach((it, idx) => {
      // Ensure numeric `id` exists
      if (!it.id) {
        // prefer numeric `itemId` if present
        const asNum = Number(it.itemId);
        if (asNum) {
          it.id = asNum;
          if (asNum > maxId) maxId = asNum;
        } else {
          maxId += 1;
          it.id = maxId;
        }
      }

      // Map legacy `notes` to `details` for the front-end
      if (!('details' in it) || it.details === undefined) {
        it.details = (it.notes !== undefined && it.notes !== null) ? String(it.notes) : '';
      }

      // Normalize tags: prefer `tags` array, else convert `tag` string into array
      if (!Array.isArray(it.tags)) {
        if (typeof it.tag === 'string' && it.tag.trim() !== '') {
          // split on common separators: slash, comma, or pipe
          it.tags = it.tag.split(/[\/|,]+/).map(s => s.trim()).filter(Boolean);
        } else {
          it.tags = [];
        }
      }

      // Ensure claimedByCode exists (null or string)
      if (!('claimedByCode' in it)) it.claimedByCode = null;
    });
  }

  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// --- middleware ---

app.use(express.json());

// Serve static files (front-end) from /public
app.use(express.static(path.join(__dirname, 'public')));

// --- API endpoints ---

// --- Simple CSV parser (minimal, handles quoted fields and commas) ---
function parseCsvText(text) {
  // Normalize line endings
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split into rows while respecting quoted newlines
  const rows = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      rows.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur !== '') rows.push(cur);

  if (rows.length === 0) return [];

  function splitRow(row) {
    const cols = [];
    let cell = '';
    let iq = false;
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '"') {
        if (iq && row[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          iq = !iq;
        }
      } else if (ch === ',' && !iq) {
        cols.push(cell);
        cell = '';
      } else {
        cell += ch;
      }
    }
    cols.push(cell);
    return cols.map(s => s.trim());
  }

  const header = splitRow(rows[0]).map(h => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    if (!rows[r].trim()) continue;
    const fields = splitRow(rows[r]);
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c] ? header[c].toLowerCase() : (`col${c}`);
      obj[key] = fields[c] !== undefined ? fields[c] : '';
    }
    records.push(obj);
  }

  return records;
}

// POST /api/admin/upload-csv-text
// Accepts JSON body: { csv: "..." }
app.post('/api/admin/upload-csv-text', (req, res) => {
  const body = req.body || {};
  const csv = body.csv;
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ success: false, message: 'Missing csv text in request body (field `csv`).' });
  }

  let records;
  try {
    records = parseCsvText(csv);
  } catch (err) {
    console.error('CSV text parse error', err);
    return res.status(400).json({ success: false, message: 'CSV parse error.' });
  }

  if (!Array.isArray(records) || records.length === 0) {
    return res.json({ success: true, added: 0, message: 'No rows to add.' });
  }

  const data = loadData();
  if (!Array.isArray(data.items)) data.items = [];

  let maxId = data.items.reduce((m, it) => Math.max(m, Number(it.id) || 0, Number(it.itemId) || 0), 0);
  const added = [];

  records.forEach(r => {
    const out = {};
    const idNum = Number(r.itemid || r.id || '');
    if (idNum) {
      out.id = idNum;
      if (idNum > maxId) maxId = idNum;
    } else {
      maxId += 1;
      out.id = maxId;
    }
    out.itemId = out.id;
    out.recipientCode = r.recipientcode || r.recipient || '';
    out.recipientName = r.recipientname || r.recipient || '';
    out.itemName = r.itemname || r.name || '';
    out.details = r.details || r.notes || '';
    out.url = r.url || '';
    const rawTags = r.tags || r.tag || '';
    if (typeof rawTags === 'string' && rawTags.trim() !== '') {
      out.tags = rawTags.split(/[\/|,;]+/).map(s => s.trim()).filter(Boolean);
    } else {
      out.tags = [];
    }
    out.claimedByCode = (r.claimedbycode || r.claimedby || '') || null;
    out.notes = out.details;
    out.tag = (out.tags && out.tags.join('/')) || '';

    data.items.push(out);
    added.push(out);
  });

  try {
    saveData(data);
  } catch (err) {
    console.error('Error saving data.json after CSV text upload', err);
    return res.status(500).json({ success: false, message: 'Failed to save data.' });
  }

  res.json({ success: true, added: added.length });
  });


// GET /api/recipients?code=LAUREN
app.get('/api/recipients', (req, res) => {
  const { code } = req.query;
  const data = loadData();

  const currentUser = data.people.find(p => p.code === code) || null;

  res.json({
    currentUser,
    recipients: data.people
  });
});

// GET /api/wishlist?viewerCode=X&recipientCode=Y
app.get('/api/wishlist', (req, res) => {
  const { viewerCode, recipientCode } = req.query;
  const data = loadData();

  const items = data.items
    .filter(i => i.recipientCode === recipientCode)
    .map(i => ({
      row: (i.id || Number(i.itemId) || null), // keep the "row" name to match front-end
      recipientCode: i.recipientCode,
      recipientName: i.recipientName,
      itemName: i.itemName,
      details: (i.details || i.notes || ''),
      url: i.url,
      tags: i.tags || [],
      claimed: !!i.claimedByCode,
      claimedByMe: i.claimedByCode === viewerCode
    }));

  res.json({
    viewerCode,
    recipientCode,
    items
  });
});

// GET /api/my-shopping-list?viewerCode=X
app.get('/api/my-shopping-list', (req, res) => {
  const { viewerCode } = req.query;
  const data = loadData();

  const items = data.items
    .filter(i => i.claimedByCode === viewerCode)
    .map(i => ({
      row: (i.id || Number(i.itemId) || null),
      recipientCode: i.recipientCode,
      recipientName: i.recipientName,
      itemName: i.itemName,
      details: (i.details || i.notes || ''),
      url: i.url,
      tags: i.tags || []
    }));

  res.json({
    viewerCode,
    items
  });
});

// POST /api/claim { viewerCode, itemId }
app.post('/api/claim', (req, res) => {
  const { viewerCode, itemId } = req.body;
  const data = loadData();

  const idNum = Number(itemId);
  const item = data.items.find(i => i.id === idNum);

  if (!item) {
    return res.json({ success: false, message: 'Item not found.' });
  }

  // Already claimed by someone else
  if (item.claimedByCode && item.claimedByCode !== viewerCode) {
    return res.json({ success: false, message: 'This item was already claimed.' });
  }

  item.claimedByCode = viewerCode;
  saveData(data);

  res.json({ success: true });
});

// POST /api/unclaim { viewerCode, itemId }
app.post('/api/unclaim', (req, res) => {
  const { viewerCode, itemId } = req.body;
  const data = loadData();

  const idNum = Number(itemId);
  const item = data.items.find(i => i.id === idNum);

  if (!item) {
    return res.json({ success: false, message: 'Item not found.' });
  }

  // Only the person who claimed it can unclaim it
  if (item.claimedByCode !== viewerCode) {
    return res.json({ success: false, message: 'You can only unclaim items you claimed.' });
  }

  item.claimedByCode = null;
  saveData(data);

  res.json({ success: true });
});

// --- start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Family Wishlist server running on http://localhost:' + PORT);
});

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
      // Ensure family field exists for multi-family support
      if (!('family' in it) || !it.family) it.family = 'default';
    });
  }

  // Ensure people have a family attribute (default)
  if (Array.isArray(data.people)) {
    data.people.forEach(p => { if (!('family' in p) || !p.family) p.family = 'default'; });
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
    out.family = r.family || body.family || 'default';
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

// --- Admin: list items (for admin UI) ---
app.get('/api/admin/items', (req, res) => {
  const data = loadData();
  // Optionally filter by family (query param `family`)
  const family = req.query.family || 'default';
  const items = (data.items || []).filter(it => String(it.family || 'default') === String(family));
  res.json({ items });
});

// --- Admin: update an item by id ---
app.put('/api/admin/item/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: 'Invalid id' });

  const data = loadData();
  if (!Array.isArray(data.items)) data.items = [];

  const family = req.query.family || req.body.family || 'default';
  const item = data.items.find(i => (Number(i.id) === id || Number(i.itemId) === id) && String(i.family || 'default') === String(family));
  if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

  const body = req.body || {};
  // Updatable fields
  if ('recipientCode' in body) item.recipientCode = String(body.recipientCode || '');
  if ('recipientName' in body) item.recipientName = String(body.recipientName || '');
  if ('itemName' in body) item.itemName = String(body.itemName || '');
  if ('details' in body) item.details = String(body.details || '');
  if ('notes' in body) item.details = String(body.notes || item.details || '');
  if ('url' in body) item.url = String(body.url || '');
  if ('claimedByCode' in body) item.claimedByCode = body.claimedByCode || null;

  if ('tags' in body) {
    if (Array.isArray(body.tags)) item.tags = body.tags.map(String).map(t => t.trim()).filter(Boolean);
    else if (typeof body.tags === 'string') item.tags = body.tags.split(/[\/|,;]+/).map(s => s.trim()).filter(Boolean);
  }

  // keep legacy fields in sync
  item.notes = item.details;
  item.tag = (item.tags && item.tags.join('/')) || '';
  // ensure family stays set
  if (!item.family) item.family = family;

  try {
    saveData(data);
  } catch (err) {
    console.error('Error saving data.json on admin update', err);
    return res.status(500).json({ success: false, message: 'Failed to save' });
  }

  res.json({ success: true, item });
});

// --- Admin: update a person (preferences, name, family) ---
app.put('/api/admin/person/:code', (req, res) => {
  const code = req.params.code;
  if (!code) {
    return res.status(400).json({ success: false, message: 'Missing person code' });
  }

  const data = loadData();
  if (!Array.isArray(data.people)) data.people = [];

  // This is the *original* family used to find the person
  const lookupFamily = req.query.family || req.body.family || 'default';

  const person = data.people.find(
    p => String(p.code) === String(code) && String(p.family || 'default') === String(lookupFamily)
  );

  if (!person) {
    return res.status(404).json({ success: false, message: 'Person not found' });
  }

  const body = req.body || {};

  // Update fields
  if ('name' in body) {
    person.name = String(body.name || '');
  }

  if ('preferences' in body) {
    person.preferences = body.preferences || '';
  }

  if ('family' in body) {
    // This is the *new* family you typed in the admin UI
    const newFamily = (body.family || '').trim() || 'default';
    person.family = newFamily;
  } else if (!person.family) {
    // Ensure it never ends up blank
    person.family = lookupFamily || 'default';
  }

  try {
    saveData(data);
  } catch (err) {
    console.error('Error saving data.json on person update', err);
    return res.status(500).json({ success: false, message: 'Failed to save' });
  }

  res.json({ success: true, person });
});


// --- Admin: create a person ---
app.post('/api/admin/person', (req, res) => {
  const body = req.body || {};
  const code = (body.code || '').toString().trim();
  const name = (body.name || '').toString().trim();
  const preferences = body.preferences || '';
  const family = body.family || req.query.family || 'default';

  if (!code) return res.status(400).json({ success: false, message: 'Missing code' });

  const data = loadData();
  if (!Array.isArray(data.people)) data.people = [];

  // Ensure code uniqueness (case-insensitive)
  if (data.people.find(p => String(p.code).toLowerCase() === code.toLowerCase())) {
    return res.status(409).json({ success: false, message: 'Person with this code already exists' });
  }

  const person = { code, name, preferences, family };
  data.people.push(person);

  try { saveData(data); } catch (err) {
    console.error('Error saving data.json on person create', err);
    return res.status(500).json({ success: false, message: 'Failed to save' });
  }

  res.json({ success: true, person });
});

// --- Admin: delete a person (and their items) ---
app.delete('/api/admin/person/:code', (req, res) => {
  const code = req.params.code;
  if (!code) return res.status(400).json({ success: false, message: 'Missing code' });

  const data = loadData();
  if (!Array.isArray(data.people)) data.people = [];
  const family = req.query.family || 'default';
  const idx = data.people.findIndex(p => String(p.code) === String(code) && String(p.family || 'default') === String(family));
  if (idx === -1) return res.status(404).json({ success: false, message: 'Person not found' });

  // Remove person
  data.people.splice(idx, 1);

  // Also remove items associated with this person to keep data consistent
  if (Array.isArray(data.items)) {
    data.items = data.items.filter(it => !(String(it.recipientCode) === String(code) && String(it.family || 'default') === String(family)));
  }

  try { saveData(data); } catch (err) {
    console.error('Error saving data.json on person delete', err);
    return res.status(500).json({ success: false, message: 'Failed to save' });
  }

  res.json({ success: true });
});


// GET /api/recipients?code=LAUREN
app.get('/api/recipients', (req, res) => {
  const { code } = req.query;
  const family = req.query.family || 'default';
  const data = loadData();

  const recipients = (data.people || []).filter(p => String(p.family || 'default') === String(family));
  const currentUser = recipients.find(p => p.code === code) || null;

  res.json({ currentUser, recipients });
});

// GET /api/families - list available family keys (from people and items)
app.get('/api/families', (req, res) => {
  const data = loadData();
  const famSet = new Set();
  (data.people || []).forEach(p => famSet.add(p.family || 'default'));
  (data.items || []).forEach(i => famSet.add(i.family || 'default'));
  res.json({ families: Array.from(famSet) });
});

// GET /api/wishlist?viewerCode=X&recipientCode=Y
app.get('/api/wishlist', (req, res) => {
  const { viewerCode, recipientCode } = req.query;
  const family = req.query.family || 'default';
  const data = loadData();

  const items = data.items
    .filter(i => i.recipientCode === recipientCode && String(i.family || 'default') === String(family))
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
  const family = req.query.family || 'default';
  const data = loadData();

  const items = data.items
    .filter(i => i.claimedByCode === viewerCode && String(i.family || 'default') === String(family))
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
  const family = req.body.family || req.query.family || 'default';
  const data = loadData();

  const idNum = Number(itemId);
  const item = data.items.find(i => i.id === idNum && String(i.family || 'default') === String(family));

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
  const family = req.body.family || req.query.family || 'default';
  const data = loadData();

  const idNum = Number(itemId);
  const item = data.items.find(i => i.id === idNum && String(i.family || 'default') === String(family));

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


// --- Ensure API errors return JSON (instead of HTML error pages) ---
// Catch unmatched API routes and return JSON 404
app.use('/api', (req, res, next) => {
  // If we reach here, no API route matched
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// Error handler: convert errors (including body-parser errors) to JSON for API paths
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err && err.stack ? err.stack : err);
  if (req.path && String(req.path).startsWith('/api')) {
    const status = err && err.status ? err.status : 500;
    const message = err && err.message ? err.message : 'Internal server error';
    return res.status(status).json({ success: false, message });
  }
  // For non-API requests, delegate to default handler (will likely return HTML)
  next(err);
});

// --- start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Family Wishlist server running on http://localhost:' + PORT);
});

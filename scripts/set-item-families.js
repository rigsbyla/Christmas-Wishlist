const fs = require('fs');
const path = require('path');
const DATA_PATH = path.join(__dirname, '..', 'data.json');

const raw = fs.readFileSync(DATA_PATH, 'utf8');
const data = JSON.parse(raw);
let changed = false;
if (!Array.isArray(data.items)) data.items = [];
for (let it of data.items) {
  if (!it.family || String(it.family) === 'default') {
    it.family = 'Rigsby';
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log('Updated items to family=Rigsby');
} else {
  console.log('No changes needed');
}

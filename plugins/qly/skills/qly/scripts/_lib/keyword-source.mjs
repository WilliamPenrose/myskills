import { readFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

function parseCsv(text) {
  const rows = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (!lines.length) return rows;
  const header = lines[0].split(',').map((s) => s.trim());
  for (let i = 1; i < lines.length; i++) {
    const fields = [];
    let cur = '';
    let inQ = false;
    for (let j = 0; j < lines[i].length; j++) {
      const c = lines[i][j];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { fields.push(cur); cur = ''; continue; }
      cur += c;
    }
    fields.push(cur);
    const row = {};
    for (let k = 0; k < header.length; k++) row[header[k]] = (fields[k] ?? '').trim();
    rows.push(row);
  }
  return rows;
}

async function parseXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`no worksheet in ${filePath}`);
  const header = [];
  ws.getRow(1).eachCell((cell, col) => { header[col - 1] = String(cell.value ?? '').trim(); });
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const obj = {};
    const row = ws.getRow(r);
    let hasAny = false;
    for (let c = 1; c <= header.length; c++) {
      const v = row.getCell(c).value;
      obj[header[c - 1]] = v == null ? '' : String(v).trim();
      if (v != null && String(v).trim() !== '') hasAny = true;
    }
    if (hasAny) rows.push(obj);
  }
  return rows;
}

/**
 * Load the business keyword source (csv or xlsx).
 * Returns array of rows with is_track == '1', each row is the full parsed object.
 * Throws if required columns key_word or is_track are missing.
 */
export async function loadKeywords(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let rows;
  if (ext === '.csv') {
    rows = parseCsv(readFileSync(filePath, 'utf8'));
  } else if (ext === '.xlsx') {
    rows = await parseXlsx(filePath);
  } else {
    throw new Error(`unsupported keyword source format: ${ext} (need .csv or .xlsx)`);
  }
  if (!rows.length) throw new Error(`keyword source ${filePath} is empty`);

  const required = ['key_word', 'is_track'];
  for (const col of required) {
    if (!(col in rows[0])) {
      throw new Error(`keyword source ${filePath} missing required column "${col}". Found: ${Object.keys(rows[0]).join(', ')}`);
    }
  }
  return rows.filter((r) => String(r.is_track).trim() === '1');
}

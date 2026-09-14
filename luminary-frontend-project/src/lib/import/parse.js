/**
 * Reading a file into rows.
 *
 * The first stage of the import pipeline, and deliberately the only one that
 * knows what a file is. Everything downstream — mapping, validation, staging,
 * publishing — works on plain rows and never learns whether they came from a
 * spreadsheet or a comma-separated export.
 *
 * **On the spreadsheet parser.** The obvious choice is SheetJS via npm, and it
 * is deliberately not used: every published version of that package carries
 * high-severity advisories against the workbook parser itself — prototype
 * pollution and a catastrophic regex, both reachable from a malicious file.
 * That is precisely the code an uploaded schedule runs through, in an
 * application holding patient records. `read-excel-file` is maintained, MIT,
 * scoped to exactly this job, and adds no advisories of its own.
 *
 * It is loaded on demand rather than at start-up, so the parser is fetched the
 * first time somebody actually opens a workbook instead of being carried by
 * every session that never visits the import screen.
 */

/**
 * Split one line of delimited text.
 *
 * Hand-rolled rather than pulled in, because the only hard part of CSV is
 * quoting and the rule is four lines long: a doubled quote inside a quoted
 * field is a literal quote, and a delimiter inside quotes is data. Tariff
 * schedules are full of descriptions like `"ECG, 12 lead"`, so getting this
 * wrong silently shifts every column after it.
 */
export function splitRow(line, delimiter) {
  const out = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { value += '"'; i += 1; } else { quoted = false; }
      } else {
        value += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      out.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  out.push(value);
  return out.map((cell) => cell.trim());
}

/** Comma or tab, whichever appears more in the header. Exports use both. */
export function detectDelimiter(headerLine) {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const tabs = (headerLine.match(/\t/g) ?? []).length;
  return tabs > commas ? '\t' : ',';
}

/**
 * Turn a grid of cells into `{ headers, rows }`.
 *
 * Shared by both formats on purpose, so a schedule cannot behave differently
 * depending on whether it arrived as a workbook or as text. Rows are padded to
 * the header width because exports routinely end short when trailing cells are
 * empty, and treating that as malformed would reject most real uploads.
 */
export function fromMatrix(matrix = []) {
  const grid = matrix.filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''));
  if (grid.length === 0) return { headers: [], rows: [] };

  const headers = grid[0].map((cell) => String(cell ?? '').trim());
  const rows = grid.slice(1).map((cells, index) => {
    const row = {};
    headers.forEach((header, column) => {
      row[header] = String(cells[column] ?? '').trim();
    });
    // Kept so every later stage can point at the line in the user's own file.
    row.__line = index + 2;
    return row;
  });

  return { headers, rows };
}

/** Parse delimited text — CSV, TSV, or anything a spreadsheet exported. */
export function parseDelimited(text) {
  const lines = String(text ?? '')
    .replace(/^\ufeff/, '')   // Excel writes a BOM; it is not a column name
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return { headers: [], rows: [] };

  const delimiter = detectDelimiter(lines[0]);
  return fromMatrix(lines.map((line) => splitRow(line, delimiter)));
}

/**
 * A workbook cell as the rest of the pipeline wants it.
 *
 * The parser types cells for us, which is mostly a gift and occasionally a
 * trap: a date arrives as a `Date` and would stringify to a locale-dependent
 * sentence, and a rate typed as a float would carry binary noise through
 * `toString`. Both are normalised here so the validators downstream see the
 * same text they would have seen had the file been a CSV.
 */
export function cellToText(cell) {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === 'number') return String(Math.round(cell * 1e6) / 1e6);
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  return String(cell).trim();
}

/**
 * Parse the first sheet of a workbook.
 *
 * A workbook can hold several sheets and a payer schedule almost always has
 * its data on the first. Guessing between them here would be a silent choice
 * about which prices to apply; the review screen is the right place for a
 * person to notice they uploaded the wrong tab.
 */
export async function parseSpreadsheet(file) {
  let readXlsxFile;
  try {
    ({ default: readXlsxFile } = await import('read-excel-file/browser'));
  } catch {
    return {
      headers: [],
      rows: [],
      error: 'The spreadsheet reader could not be loaded. In Excel choose File → Save As → CSV and upload that — the columns and the mapping are identical.',
    };
  }

  try {
    const matrix = await readXlsxFile(file);
    if (!matrix || matrix.length === 0) {
      return { headers: [], rows: [], error: 'The first sheet of that workbook is empty.' };
    }
    return fromMatrix(matrix.map((row) => row.map(cellToText)));
  } catch (error) {
    // A corrupt or password-protected workbook is an ordinary thing to be
    // handed, and it must not reach the user as a stack trace.
    return {
      headers: [],
      rows: [],
      error: `That file could not be read as a spreadsheet (${error?.message ?? 'unknown error'}). If it is password protected, remove the password or save it as CSV.`,
    };
  }
}

const SPREADSHEET = /\.(xlsx|xlsm)$/i;
const LEGACY_EXCEL = /\.xls$/i;

/** Read any supported file into the same `{ headers, rows }` shape. */
export async function parseFile(file) {
  if (LEGACY_EXCEL.test(file.name)) {
    // .xls is a different, much older binary format. Saying so is more use
    // than a parser error about an unexpected byte.
    return {
      headers: [],
      rows: [],
      error: 'That is the older .xls format. Open it in Excel and save as .xlsx or CSV, then upload again.',
    };
  }
  if (SPREADSHEET.test(file.name)) return parseSpreadsheet(file);
  return parseDelimited(await file.text());
}

/**
 * Streaming RFC 4180 CSV parser
 *
 * Yields one plain-object record per data row as an AsyncGenerator.
 * Handles:
 *   - Multi-line quoted fields  (critical: Etsy DESCRIPTION spans many lines)
 *   - Escaped double-quotes     ("" inside a quoted field → single ")
 *   - CRLF and LF line endings
 *   - UTF-8 BOM at file start
 *   - Chunk-boundary edge cases (the "" escape can straddle two stream chunks)
 *
 * Zero external dependencies — uses Node.js built-in fs streams only.
 *
 * @example
 *   for await (const row of parseCsvFile('./data.csv')) {
 *     console.log(row['TITLE']);
 *   }
 */

import { createReadStream } from 'node:fs';

/**
 * Parse a CSV file as an async generator.
 *
 * @param {string} filePath - Absolute or resolvable path to the CSV file
 * @yields {Object} One record per data row, keyed by the header row values
 */
export async function* parseCsvFile(filePath) {
  let headers     = null;
  let row         = [];     // fields collected for the current record
  let field       = '';     // characters collected for the current field
  let inQuotes    = false;  // currently inside a RFC 4180 quoted field
  let prevWasQuote = false; // saw a '"' while inQuotes — resolve on next char
  let isFirstChar  = true;  // used to strip a leading UTF-8 BOM (\uFEFF)

  // Called when a row terminator (\n) is encountered.
  // Finalises `field`, resets state, and returns the completed row array.
  function finaliseRow() {
    row.push(field);
    field = '';
    const completed = row;
    row = [];
    return completed;
  }

  for await (const chunk of createReadStream(filePath, { encoding: 'utf-8' })) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      // ── BOM strip ──────────────────────────────────────────────────────────
      if (isFirstChar) {
        isFirstChar = false;
        if (ch === '\uFEFF') continue;
      }

      // ── Deferred quote resolution ──────────────────────────────────────────
      // We saw a '"' on the previous character while inside a quoted field.
      // Now we know the next character — decide if it was an escape or close.
      if (prevWasQuote) {
        prevWasQuote = false;
        if (ch === '"') {
          // Escaped double-quote: "" → emit one literal "
          field += '"';
          continue;
        }
        // Closing quote: the quoted field has ended. Fall through so the current
        // character is processed in the "not in quotes" branch below.
        inQuotes = false;
      }

      // ── Inside a quoted field ──────────────────────────────────────────────
      if (inQuotes) {
        if (ch === '"') {
          // Could be an escape ("") or a closing quote — defer to next char.
          prevWasQuote = true;
        } else {
          // Literal character inside quotes — newlines included.
          field += ch;
        }
        continue;
      }

      // ── Outside a quoted field ─────────────────────────────────────────────
      switch (ch) {
        case '"':
          inQuotes = true;
          break;

        case ',':
          row.push(field);
          field = '';
          break;

        case '\r':
          // Ignore bare CR; the paired \n will trigger row emission.
          break;

        case '\n': {
          const completed = finaliseRow();
          // Skip blank lines (all empty fields)
          if (completed.some(f => f !== '')) {
            if (headers === null) {
              headers = completed;
            } else {
              const record = Object.create(null);
              headers.forEach((h, idx) => {
                record[h] = completed[idx] ?? '';
              });
              yield record;
            }
          }
          break;
        }

        default:
          field += ch;
      }
    }
  }

  // ── Flush end-of-file state ────────────────────────────────────────────────
  // Files without a trailing newline leave the last record in the buffers.
  if (prevWasQuote) inQuotes = false;

  row.push(field);
  if (headers !== null && row.some(c => c !== '')) {
    const record = Object.create(null);
    headers.forEach((h, idx) => {
      record[h] = row[idx] ?? '';
    });
    yield record;
  }
}

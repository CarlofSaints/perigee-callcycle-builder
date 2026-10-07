import * as XLSX from 'xlsx';
import { ParsedEntry, ReferenceData } from '../types';
import {
  findDayHeaderRow, findDayColumns, extractStoreCode, isStoreCell, addOrMergeEntry,
} from './parserUtils';

/**
 * User Sheets 4wk format: one sheet per user, 4 individual week blocks stacked
 * vertically. Sheet name MUST be the user's Perigee email address.
 *
 * Layout (example — MT February Call Cycle 2026.xlsx):
 *   Row 0     "WEEK: 1,2" general banner (ignored)
 *   Row 1     <email> | ROLE | CELL | ADDRESS
 *   Row 2     MONDAY | TUESDAY | ... | SATURDAY | NO OF CALLS PER WEEK
 *   Row 3–10  "WEEK 1" merged in col A + store cells in cols B–G
 *   Row 11–18 "WEEK 2" merged in col A + stores
 *   Row 19–26 "WEEK 3" merged in col A + stores
 *   Row 27–34 "WEEK 4" merged in col A + stores
 *
 * Column A holds the merged "WEEK N" marker (only populated on the first row
 * of the block). Columns B–G are the six day columns. Column H onwards is
 * ignored — it holds a "no of calls" column and a channel legend.
 *
 * Output cycle starts per individual week ("Week 1" / "Week 2" / ...) then
 * a post-process pass merges rows that share the same (userEmail, storeId,
 * day-pattern) into a single row whose cycle string joins all matching weeks
 * with `&` — e.g. a Norwood store visited every Monday in weeks 1–4 becomes
 * ONE row with cycle "Week 1&2&3&4" instead of four separate rows. This
 * matches the Josh ALT convention ("Week 1&3" / "Week 2&4") and the download
 * route's parseCycleWeeks() regex handles arbitrary digit sets cleanly.
 *
 * Non-email sheets (e.g. a "REP INFO" tab) are skipped silently-with-warning.
 */
export interface Parse4WeekOptions {
  ignoreSheetNames?: boolean;
}

export function parse4Week(
  workbook: XLSX.WorkBook,
  references: ReferenceData,
  options?: Parse4WeekOptions,
): { entries: ParsedEntry[]; warnings: string[] } {
  const entries: ParsedEntry[] = [];
  const warnings: string[] = [];

  // Build name/email lookup from reference data so we can populate
  // firstName + surname on the parsed entries.
  const refLookup = new Map<string, { firstName: string; surname: string }>();
  for (const u of references.users) {
    refLookup.set(u.userEmail.toLowerCase().trim(), {
      firstName: u.firstName,
      surname: u.surname,
    });
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // Resolve the user email for this sheet.
    const trimmed = sheetName.trim();
    let sheetEmail = '';
    let firstName = '';
    let surname = '';

    if (trimmed.includes('@')) {
      // Sheet name IS an email address — use directly.
      sheetEmail = trimmed.toLowerCase();
      const ref = refLookup.get(sheetEmail);
      const localPart = sheetEmail.split('@')[0];
      firstName = ref?.firstName || localPart;
      surname = ref?.surname || '';
    } else if (options?.ignoreSheetNames) {
      // ignoreSheetNames: try to find the email from the sheet content or reference data.
      warnings.push(`Sheet "${sheetName}" — name is not an email address, attempting to resolve...`);

      const sheetData = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, { header: 1, defval: '' });

      // 1. Scan first 10 rows for any cell containing an email address
      let foundEmail = '';
      for (let r = 0; r < Math.min(10, sheetData.length); r++) {
        for (const cell of (sheetData[r] || [])) {
          const cellStr = String(cell || '').trim();
          const emailMatch = cellStr.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
          if (emailMatch) {
            foundEmail = emailMatch[1].toLowerCase();
            break;
          }
        }
        if (foundEmail) break;
      }

      if (foundEmail) {
        sheetEmail = foundEmail;
        const ref = refLookup.get(sheetEmail);
        firstName = ref?.firstName || sheetEmail.split('@')[0];
        surname = ref?.surname || '';
        warnings.push(`Sheet "${sheetName}" — resolved email from content: ${sheetEmail}`);
      } else {
        // 2. Try matching sheet name against reference data (first name or full name)
        const nameLower = trimmed.toLowerCase();
        for (const u of references.users) {
          if (u.firstName.toLowerCase() === nameLower ||
              `${u.firstName} ${u.surname}`.toLowerCase().trim() === nameLower ||
              u.userEmail.split('@')[0].toLowerCase() === nameLower) {
            sheetEmail = u.userEmail.toLowerCase();
            firstName = u.firstName;
            surname = u.surname;
            warnings.push(`Sheet "${sheetName}" — matched to user ${sheetEmail} via reference data`);
            break;
          }
        }
      }

      if (!sheetEmail) {
        warnings.push(`Sheet "${sheetName}" skipped — could not resolve an email address from content or reference data.`);
        continue;
      }
    } else {
      // Default: skip non-email sheets with a warning.
      warnings.push(`Sheet "${sheetName}" skipped — sheet name is not an email address.`);
      continue;
    }

    const data = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
      header: 1,
      defval: '',
    });
    if (data.length < 4) {
      warnings.push(`Sheet "${sheetName}" has too few rows to contain a 4-week block.`);
      continue;
    }

    // Find the day-of-week header row. Scan up to 50 rows to accommodate
    // sheets with preamble blocks (weekly objectives, store name legend,
    // rep name/role/email rows) above the actual day headers.
    const dayResult = findDayHeaderRow(data, 50);
    if (!dayResult) {
      warnings.push(`No day columns found in sheet "${sheetName}"`);
      continue;
    }

    // Constraint: only look at day columns in A–G (0–6). Everything from col H
    // onwards on this format is a "calls" count + channel legend and must be
    // ignored — e.g. a "STORE NAME" header in col I would otherwise register
    // as a misspelled day of the week.
    const dayColumns = dayResult.dayColumns.filter(c => c.col <= 6);
    if (dayColumns.length < 3) {
      warnings.push(`Sheet "${sheetName}" has too few day columns (A–G) to parse.`);
      continue;
    }

    let currentWeek: number | null = null;
    let foundAnyWeek = false;

    // Check if the day header row itself has a week marker in col A.
    // This happens when a merged "WEEK 1" cell starts at the same row
    // as the day headers (e.g. Frederic's sheet in the PTA file).
    const headerRow = data[dayResult.dayRowIdx] || [];
    const headerColA = String(headerRow[0] || '').trim();
    const headerWeekMatch = headerColA.match(/week\s*[:\s]*\s*(\d+)/i);
    if (headerWeekMatch) {
      const weekNum = Number(headerWeekMatch[1]);
      if (weekNum >= 1 && weekNum <= 6) {
        currentWeek = weekNum;
        foundAnyWeek = true;
      }
    }

    // Bosch format: a bare "Week1" label sits in col A on its own row ABOVE
    // the day header. Strict match so MT's "WEEK: 1,2" banner is not taken.
    if (currentWeek === null) {
      for (let r = dayResult.dayRowIdx - 1; r >= 0; r--) {
        const m = String((data[r] || [])[0] || '').trim().match(/^week\s*(\d)$/i);
        if (m && Number(m[1]) >= 1 && Number(m[1]) <= 6) {
          currentWeek = Number(m[1]);
          foundAnyWeek = true;
          break;
        }
      }
    }

    // Bosch format (e.g. KZN): the first block has no label at all, and the
    // next label below is "Week2" — so the unlabelled block is week 1.
    if (currentWeek === null) {
      for (let r = dayResult.dayRowIdx + 1; r < data.length; r++) {
        const m = String((data[r] || [])[0] || '').trim().match(/^week\s*[:\s]*\s*(\d+)$/i);
        if (!m) continue;
        if (Number(m[1]) === 2) {
          currentWeek = 1;
          foundAnyWeek = true;
          warnings.push(`Sheet "${sheetName}": first block has no week label — treated as Week 1.`);
        }
        break;
      }
    }

    for (let rowIdx = dayResult.dayRowIdx + 1; rowIdx < data.length; rowIdx++) {
      const row = data[rowIdx] || [];

      // Column A — week marker (merged cell, only populated on the block's
      // first row). Matches "WEEK 1", "Week: 2", "week 03", etc.
      //
      // IMPORTANT: after detecting the week marker we must NOT `continue` —
      // the same row contains the first line of store data for that week
      // (e.g. row 3 in MT's file has "WEEK 1" in col A AND "PNP NORWOOD - HC05"
      // in col B). Fall through to the store-cell loop below.
      const colAStr = String(row[0] || '').trim();
      if (colAStr) {
        const weekMatch = colAStr.match(/week\s*[:\s]*\s*(\d+)/i);
        if (weekMatch) {
          const weekNum = Number(weekMatch[1]);
          if (weekNum < 1 || weekNum > 6) {
            warnings.push(`Sheet "${sheetName}" row ${rowIdx + 1}: unexpected week number "${colAStr}"`);
            currentWeek = null;
            continue;
          }
          currentWeek = weekNum;
          foundAnyWeek = true;
          // fall through — row may also contain store data in cols B–G
        }
      }

      // Skip rows until we've seen at least one WEEK marker — prevents us
      // picking up stray store cells from garbage rows above the first block.
      if (currentWeek === null) continue;

      // Bosch format repeats the Mon | Tue | ... header under every week label.
      if (findDayColumns(row).length >= 3) continue;

      const cycleLabel = `Week ${currentWeek}`;

      for (const { col, day } of dayColumns) {
        const cellValue = String(row[col] || '').trim();
        if (!isStoreCell(cellValue)) continue;

        const { storeName, storeCode } = extractStoreCode(cellValue);
        if (!storeName) continue;

        addOrMergeEntry(entries, {
          userEmail: sheetEmail,
          firstName,
          surname,
          storeId: storeCode,
          storeName,
          cycle: cycleLabel,
          day,
        });
      }
    }

    if (!foundAnyWeek) {
      warnings.push(`Sheet "${sheetName}" has no "WEEK N" markers in column A — no entries parsed.`);
    }
  }

  return { entries: mergeSameDayPatternWeeks(entries), warnings };
}

/**
 * Post-process: collapse rows with identical (userEmail, storeId, day-pattern)
 * across different weeks into a single row whose cycle string joins the weeks
 * with `&`. Single-week rows and rows with unique day patterns pass through
 * unchanged.
 *
 * Example input:
 *   { ..., storeId: S009, cycle: "Week 1", days: [Mon] }
 *   { ..., storeId: S009, cycle: "Week 2", days: [Mon] }
 *   { ..., storeId: S009, cycle: "Week 3", days: [Mon] }
 *   { ..., storeId: S009, cycle: "Week 4", days: [Mon] }
 * Example output:
 *   { ..., storeId: S009, cycle: "Week 1&2&3&4", days: [Mon] }
 */
function mergeSameDayPatternWeeks(entries: ParsedEntry[]): ParsedEntry[] {
  const groups = new Map<string, ParsedEntry[]>();
  for (const e of entries) {
    const daysKey = [...e.days].sort().join('|');
    const key = `${e.userEmail.toLowerCase()}__${e.storeId.toUpperCase()}__${daysKey}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(e);
    else groups.set(key, [e]);
  }

  const merged: ParsedEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
      continue;
    }
    // Union all week numbers across the group
    const weekSet = new Set<number>();
    for (const e of group) {
      const nums = e.cycle.match(/\d+/g);
      if (nums) for (const n of nums) weekSet.add(Number(n));
    }
    const sortedWeeks = [...weekSet].sort((a, b) => a - b);
    const cycle = sortedWeeks.length > 0 ? `Week ${sortedWeeks.join('&')}` : group[0].cycle;
    merged.push({ ...group[0], cycle });
  }
  return merged;
}

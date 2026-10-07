import * as XLSX from 'xlsx';
import { ParsedEntry, ReferenceData } from '../types';
import {
  findDayHeaderRow, findDayColumns, parseWeekLabel, extractStoreCode, isStoreCell, addOrMergeEntry,
} from './parserUtils';

/** Perigee site the iRam team books admin calls against. */
const ADMIN_SITE_CODE = 'AD2102';

/**
 * "Admin", "Admin Day", "Admin.", "ADMIN/OFFICE", "Admin (office)" — only
 * these words, so "Admin - PnP Norwood" (a real store missing its code) is
 * NOT swallowed into the admin site.
 */
function isAdminLabel(cell: string): boolean {
  const words = cell.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words[0] === 'admin' && words.every(w => w === 'admin' || w === 'day' || w === 'office');
}

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
): { entries: ParsedEntry[]; warnings: string[]; notices: string[] } {
  const entries: ParsedEntry[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];

  // Only map code-less "Admin" calls when THIS tenant's store control has the
  // admin site — the parser is shared by every tenant.
  const adminSite = references.stores.find(s => s.storeCode.trim().toUpperCase() === ADMIN_SITE_CODE);
  const adminSiteCode = adminSite?.storeCode.trim() ?? '';

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
    let dayColumns = dayResult.dayColumns.filter(c => c.col <= 6);
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
    const headerWeek = parseWeekLabel(headerColA);
    if (headerWeek !== null && headerWeek >= 1 && headerWeek <= 6) {
      currentWeek = headerWeek;
      foundAnyWeek = true;
    }

    // Bosch format: a bare "Week1" label sits in col A on its own row just
    // ABOVE the day header. Only look 3 rows up (a preamble further up may
    // list "Week 1".."Week 4" objectives), and strict so MT's "WEEK: 1,2"
    // banner is not taken.
    if (currentWeek === null) {
      for (let r = dayResult.dayRowIdx - 1; r >= Math.max(0, dayResult.dayRowIdx - 3); r--) {
        const w = parseWeekLabel(String((data[r] || [])[0] || ''), { strict: true });
        if (w !== null && w >= 1 && w <= 6) {
          currentWeek = w;
          foundAnyWeek = true;
          break;
        }
      }
    }

    // Bosch format (e.g. KZN): the first block has no label at all. Infer it
    // from the next label below: "Week 2" means the unlabelled block is week 1.
    if (currentWeek === null) {
      for (let r = dayResult.dayRowIdx + 1; r < data.length; r++) {
        const w = parseWeekLabel(String((data[r] || [])[0] || ''));
        if (w === null) continue;
        if (w >= 2 && w <= 6) {
          currentWeek = w - 1;
          foundAnyWeek = true;
          warnings.push(`Sheet "${sheetName}": first block has no week label — treated as Week ${w - 1}.`);
        }
        break;
      }
    }

    const notOnPerigee: string[] = [];
    const adminMapped: string[] = [];

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
        const weekNum = parseWeekLabel(colAStr);
        if (weekNum !== null) {
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
      // Whole-cell match only: findDayColumns() is a prefix match, so a row of
      // stores like "MONTANA…", "THUNDERTOOL…", "SATURN…" would be dropped.
      const pureDayCells = row.filter(c =>
        /^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?\.?$/i
          .test(String(c ?? '').trim())).length;
      if (pureDayCells >= 3) {
        // Re-read the day positions: a later week's header may be laid out
        // differently, and its stores must not inherit week 1's columns.
        const cols = findDayColumns(row).filter(c => c.col <= 6);
        if (cols.length >= 3) dayColumns = cols;
        continue;
      }

      const cycleLabel = `Week ${currentWeek}`;

      for (const { col, day } of dayColumns) {
        const cellValue = String(row[col] || '').trim();
        if (/not on perige+/i.test(cellValue)) {
          notOnPerigee.push(cellValue);
          continue;
        }

        let storeName: string;
        let storeCode: string;
        if (adminSite && isAdminLabel(cellValue)) {
          // Code-less "Admin" / "Admin Day" is the team's admin call — book
          // it against the tenant's admin site and tell the uploader. Checked
          // before isStoreCell(), which skips a bare "Admin".
          storeName = adminSite.storeName;
          storeCode = adminSiteCode;
          adminMapped.push(`${cycleLabel} ${day} ("${cellValue}")`);
        } else {
          if (!isStoreCell(cellValue)) continue;
          ({ storeName, storeCode } = extractStoreCode(cellValue));
          if (!storeName) continue;
          // One name per admin site, else "Admin/New  stores - AD2102" and a
          // mapped "Admin" in the same week split into two rows and the
          // schedule merge keeps only one of them's days.
          if (adminSite && storeCode.toUpperCase() === ADMIN_SITE_CODE) storeName = adminSite.storeName;
        }

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

    if (notOnPerigee.length > 0) {
      const unique = [...new Set(notOnPerigee)];
      warnings.push(`Sheet "${sheetName}": ${unique.length} store(s) marked "not on Perigee" were skipped — set them up in Perigee to include them: ${unique.join('; ')}`);
    }

    if (adminSite && adminMapped.length > 0) {
      notices.push(`${sheetEmail}: ${adminMapped.length} "Admin" call(s) with no store code were assigned to ${adminSite.storeName} (${adminSiteCode}): ${adminMapped.join(', ')}.`);
    }

    if (!foundAnyWeek) {
      warnings.push(`Sheet "${sheetName}" has no "WEEK N" markers in column A — no entries parsed.`);
    }
  }

  return { entries: mergeSameDayPatternWeeks(entries), warnings, notices };
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
    // Code-less stores all have storeId '' — key them by name, or two
    // different code-less stores on the same day collapse into one.
    const storeKey = e.storeId ? e.storeId.toUpperCase() : `name:${e.storeName.toLowerCase()}`;
    const key = `${e.userEmail.toLowerCase()}__${storeKey}__${daysKey}`;
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

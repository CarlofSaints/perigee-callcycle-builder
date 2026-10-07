import * as XLSX from 'xlsx';
import { ParsedEntry, ReferenceData, TeamControlEntry } from '../types';
import { detectFormat, FileFormat } from './detectFormat';
import { parseJoshStandard } from './parseJoshStandard';
import { parseAshFormat } from './parseAshFormat';
import { parseJoshAlt } from './parseJoshAlt';
import { parseEmailSheet } from './parseEmailSheet';
import { parseSimpleName } from './parseSimpleName';
import { parseMarkerFormat } from './parseMarkerFormat';
import { parse4Week } from './parse4Week';

export interface ParseResult {
  format: FileFormat;
  entries: ParsedEntry[];
  warnings: string[];
  /** Changes the parser made to the file that the customer should be told about. */
  notices: string[];
}

export type ParseMode = 'team-leader' | 'user' | 'user-4wk' | 'auto';

export interface ParseOptions {
  ignoreSheetNames?: boolean;
}

export function parseCallCycleFile(
  buffer: Buffer,
  references: ReferenceData,
  teamControl?: TeamControlEntry[],
  parseMode: ParseMode = 'auto',
  options?: ParseOptions,
): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  let entries: ParsedEntry[] = [];
  let warnings: string[] = [];
  let notices: string[] = [];
  let format: FileFormat;

  // Explicit modes skip detectFormat entirely.
  if (parseMode === 'team-leader') {
    format = 'marker';
    const result = parseMarkerFormat(workbook, references);
    entries = result.entries;
    warnings = result.warnings;
    return { format, entries, warnings, notices };
  }

  if (parseMode === 'user') {
    format = 'email-sheet';
    const result = parseEmailSheet(workbook, references, teamControl);
    entries = result.entries;
    warnings = result.warnings;
    return { format, entries, warnings, notices };
  }

  if (parseMode === 'user-4wk') {
    format = 'user-4wk';
    const result = parse4Week(workbook, references, options);
    entries = result.entries;
    warnings = result.warnings;
    notices = result.notices;
    return { format, entries, warnings, notices };
  }

  // parseMode === 'auto' — legacy auto-detect path (backward-compat safety net).
  format = detectFormat(workbook);

  switch (format) {
    case 'marker': {
      const result = parseMarkerFormat(workbook, references);
      entries = result.entries;
      warnings = result.warnings;
      break;
    }
    case 'josh-standard': {
      const result = parseJoshStandard(workbook, references);
      entries = result.entries;
      warnings = result.warnings;
      break;
    }
    case 'ash-region': {
      const result = parseAshFormat(workbook);
      entries = result.entries;
      warnings = result.warnings;
      break;
    }
    case 'josh-alt': {
      const result = parseJoshAlt(workbook, references);
      entries = result.entries;
      warnings = result.warnings;
      break;
    }
    case 'email-sheet': {
      const result = parseEmailSheet(workbook, references, teamControl);
      entries = result.entries;
      warnings = result.warnings;
      break;
    }
    case 'simple-name': {
      const result = parseSimpleName(workbook, references);
      entries = result.entries;
      warnings = result.warnings;
      break;
    }
    default:
      warnings.push('Could not auto-detect file format. Please ensure the file matches one of the expected formats.');
  }

  return { format, entries, warnings, notices };
}

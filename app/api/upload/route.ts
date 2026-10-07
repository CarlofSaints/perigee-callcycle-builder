import { NextRequest, NextResponse } from 'next/server';
import { parseCallCycleFile, ParseMode } from '@/lib/parsers';
import { loadReferences } from '@/lib/referenceData';
import { loadTeamControl } from '@/lib/teamControlData';
import { mergeIntoSchedule } from '@/lib/scheduleData';
import { addActivity } from '@/lib/activityLogData';
import { sendUploadNotification } from '@/lib/email';
import { loadUsers } from '@/lib/userData';
import { getTenantSlug } from '@/lib/getTenantSlug';
import { getTenantEmailConfig } from '@/lib/getTenantConfig';
import { randomUUID } from 'crypto';

const VALID_PARSE_MODES: ParseMode[] = ['team-leader', 'user', 'user-4wk', 'auto'];

export async function POST(req: NextRequest) {
  try {
    const slug = await getTenantSlug();
    const tenant = await getTenantEmailConfig();

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const userName = formData.get('userName') as string || 'Unknown';
    const userEmail = formData.get('userEmail') as string || '';
    const ccEmail = formData.get('ccEmail') as string || '';

    // Enforce Carl's hard rule: default to team-leader if missing or invalid.
    const rawParseMode = (formData.get('parseMode') as string | null) || '';
    const parseMode: ParseMode = VALID_PARSE_MODES.includes(rawParseMode as ParseMode)
      ? (rawParseMode as ParseMode)
      : 'team-leader';

    if (!file) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    const ignoreSheetNames = formData.get('ignoreSheetNames') === '1';
    const ignoreErrorSites = formData.get('ignoreErrorSites') === '1';

    const buffer = Buffer.from(await file.arrayBuffer());
    const references = await loadReferences(slug);
    const teamControlData = await loadTeamControl(slug);
    const teamControlEntries = teamControlData?.teams;

    // Parse the file
    const { format, entries, warnings, notices } = parseCallCycleFile(
      buffer, references, teamControlEntries, parseMode,
      { ignoreSheetNames },
    );

    // Warn if reference data is empty and format requires it
    const needsRefData = ['josh-standard', 'josh-alt', 'email-sheet', 'simple-name'].includes(format);
    if (needsRefData && references.users.length === 0) {
      warnings.unshift(
        '⚠ No control files loaded. Sheets named by person (not email address) cannot be matched to Perigee user emails. Please upload control files first via Admin > Control Files.'
      );
    }

    if (entries.length === 0) {
      // Send failure email
      const adminEmails = (await loadUsers(slug))
        .filter(u => (u.isAdmin || u.role === 'admin') && u.notifyOnUpload !== false)
        .map(u => u.email);
      const notifyEmails = [...new Set([...adminEmails, userEmail, ...(ccEmail ? [ccEmail] : [])])].filter(Boolean);
      try {
        await sendUploadNotification(notifyEmails, {
          userName, userEmail, filename: file.name, timestamp: new Date().toISOString(),
          format, entriesFound: 0, rowsAdded: 0, rowsUpdated: 0, totalRows: 0,
          warnings, status: 'failed',
          errorMessage: 'No data could be extracted from the file.',
        }, tenant);
      } catch (emailErr) {
        console.error('[upload] Failure email failed:', emailErr);
      }

      return NextResponse.json({
        error: 'No data could be extracted from the file',
        format,
        warnings,
      }, { status: 400 });
    }

    // Merge into schedule
    const result = await mergeIntoSchedule(
      slug,
      entries,
      userEmail,
      references.stores.map(s => ({ storeCode: s.storeCode, storeName: s.storeName, channel: s.channel })),
      { ignoreErrorSites },
    );

    // Aborted: error sites found and the user hasn't opted to ignore them.
    // Nothing was saved — tell them to fix the file and reload.
    if (result.aborted) {
      return NextResponse.json({
        ok: false,
        error: `${result.unmatchedDuplicates.length} site(s) have a duplicate site code that could not be matched to a channel. Fix the store name(s) in the file and reload, or tick "Ignore error sites" to load the rest.`,
        format,
        warnings: [...warnings, ...result.warnings],
        unmatchedDuplicates: result.unmatchedDuplicates,
      }, { status: 400 });
    }

    // Log activity
    await addActivity(slug, {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'upload',
      userName,
      userEmail,
      detail: `Uploaded "${file.name}" (${format}): ${result.rowsAdded} added, ${result.rowsUpdated} updated, ${result.totalRows} total`,
    });

    // Determine upload status
    const allWarnings = [...warnings, ...result.warnings];
    const uploadStatus: 'success' | 'partial' = allWarnings.length > 0 ? 'partial' : 'success';

    // Send email notification
    const adminEmails = (await loadUsers(slug))
      .filter(u => (u.isAdmin || u.role === 'admin') && u.notifyOnUpload !== false)
      .map(u => u.email);
    const notifyEmails = [...new Set([...adminEmails, userEmail, ...(ccEmail ? [ccEmail] : [])])].filter(Boolean);

    try {
      await sendUploadNotification(notifyEmails, {
        userName,
        userEmail,
        filename: file.name,
        timestamp: new Date().toISOString(),
        format,
        entriesFound: entries.length,
        rowsAdded: result.rowsAdded,
        rowsUpdated: result.rowsUpdated,
        totalRows: result.totalRows,
        warnings: allWarnings,
        notices,
        status: uploadStatus,
      }, tenant);
    } catch (err) {
      console.error('[upload] Email notification failed:', err);
    }

    return NextResponse.json({
      ok: true,
      format,
      entriesFound: entries.length,
      ...result,
      warnings: allWarnings,
      notices,
    });
  } catch (err) {
    console.error('[upload] Error:', err);
    return NextResponse.json({ error: 'Failed to process file', detail: String(err) }, { status: 500 });
  }
}

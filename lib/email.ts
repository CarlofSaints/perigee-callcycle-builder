import { Resend } from 'resend';

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY!);
  return _resend;
}

export interface EmailTenantConfig {
  name: string;
  subtitle: string;
  primaryColor: string;
  appUrl?: string;
}

function getFrom(tenant: EmailTenantConfig) {
  return `${tenant.name} Call Cycle Builder <report_sender@outerjoin.co.za>`;
}

function getAppUrl(tenant: EmailTenantConfig) {
  return tenant.appUrl || process.env.NEXT_PUBLIC_SITE_URL || 'https://callcycle.fieldgoose.outerjoin.co.za';
}

function emailShell(bodyContent: string, tenant: EmailTenantConfig) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e5e5;">
      <!-- Header -->
      <table width="100%" cellpadding="0" cellspacing="0" style="background:${tenant.primaryColor};">
        <tr>
          <td style="padding:20px 28px;">
            <div style="color:#fff;font-size:20px;font-weight:bold;letter-spacing:1px;margin:0;">${tenant.name.toUpperCase()} ${tenant.subtitle.toUpperCase()}</div>
            <div style="color:#fff;margin:3px 0 0;opacity:0.85;font-size:12px;">Powered by OuterJoin &amp; Perigee</div>
          </td>
        </tr>
      </table>

      <!-- Body -->
      <div style="padding:32px 28px;background:#fff;">
        ${bodyContent}
      </div>

      <!-- Footer -->
      <div style="padding:14px 28px;text-align:center;font-size:11px;color:#999;background:#f9f9f9;border-top:1px solid #eee;">
        ${tenant.name} ${tenant.subtitle} &bull; Powered by OuterJoin &amp; Perigee
      </div>
    </div>
  `;
}

export async function sendWelcomeEmail(to: string, name: string, password: string, tenant: EmailTenantConfig) {
  const appUrl = getAppUrl(tenant);
  const body = `
    <p style="margin:0 0 14px;">Hey <strong>${name}</strong>,</p>
    <p style="margin:0 0 14px;">Welcome to the <strong>${tenant.name} Call Cycle Builder</strong>.</p>
    <p style="margin:0 0 20px;color:#555;font-size:14px;">The site allows you to build your call cycle in a user-friendly format and then load it into the site to be downloaded in the format that Perigee expects.</p>
    <p style="margin:0 0 12px;">Here&apos;s the link to gain access:</p>
    <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Login URL</td><td style="font-size:13px;"><a href="${appUrl}/login" style="color:${tenant.primaryColor};">${appUrl}/login</a></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Your username</td><td style="font-size:13px;">${to}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Your password</td><td style="font-size:13px;font-family:monospace;">${password}</td></tr>
    </table>
    <p style="margin:0 0 20px;color:#666;font-size:13px;">You&apos;ll be asked to change your password on first login.</p>
    <a href="${appUrl}/login" style="background:${tenant.primaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-weight:bold;font-size:14px;display:inline-block;">Login Now</a>
    <p style="margin:24px 0 4px;color:#333;">Thank you,</p>
    <p style="margin:0;color:#333;font-weight:bold;">Team FieldGoose</p>
  `;

  return getResend().emails.send({
    from: getFrom(tenant),
    to,
    subject: `Welcome to ${tenant.name} Call Cycle Builder`,
    html: emailShell(body, tenant),
  });
}

export async function sendPasswordResetEmail(to: string, name: string, password: string, tenant: EmailTenantConfig) {
  const appUrl = getAppUrl(tenant);
  const body = `
    <p style="margin:0 0 14px;">Hi <strong>${name}</strong>,</p>
    <p style="margin:0 0 20px;">Your password has been reset. Use the credentials below to log in.</p>
    <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:20px;">
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">Email</td><td style="font-size:13px;">${to}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px;">New Password</td><td style="font-size:13px;font-family:monospace;">${password}</td></tr>
    </table>
    <a href="${appUrl}/login" style="background:${tenant.primaryColor};color:#fff;text-decoration:none;padding:12px 24px;border-radius:4px;font-weight:bold;font-size:14px;display:inline-block;">Login Now</a>
  `;

  return getResend().emails.send({
    from: getFrom(tenant),
    to,
    subject: `${tenant.name} ${tenant.subtitle} — Password Reset`,
    html: emailShell(body, tenant),
  });
}

export async function sendUploadNotification(
  toEmails: string[],
  entry: {
    userName: string;
    userEmail: string;
    filename: string;
    timestamp: string;
    format: string;
    entriesFound: number;
    rowsAdded: number;
    rowsUpdated: number;
    totalRows: number;
    warnings: string[];
    /** Changes we made to the file that the customer should be told about. */
    notices?: string[];
    status: 'success' | 'partial' | 'failed';
    errorMessage?: string;
  },
  tenant: EmailTenantConfig,
) {
  if (!toEmails.length) return;

  const ts = new Date(entry.timestamp);
  const dateStr = ts.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = ts.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  const statusColor = entry.status === 'success' ? tenant.primaryColor : entry.status === 'partial' ? '#F59E0B' : '#EF4444';
  const statusLabel = entry.status === 'success' ? 'Successful' : entry.status === 'partial' ? 'Partially Loaded' : 'Failed';
  const statusIcon = entry.status === 'success' ? '&#10003;' : entry.status === 'partial' ? '&#9888;' : '&#10007;';

  const warningsHtml = entry.warnings.length > 0
    ? `<div style="margin:16px 0;padding:12px 16px;background:#FFFBEB;border-left:4px solid #F59E0B;border-radius:4px;">
        <p style="margin:0 0 8px;font-weight:bold;color:#92400E;font-size:13px;">Warnings (${entry.warnings.length}):</p>
        <ul style="margin:0;padding:0 0 0 18px;color:#78350F;font-size:12px;">
          ${entry.warnings.map(w => `<li style="margin:0 0 4px;">${w}</li>`).join('')}
        </ul>
      </div>`
    : '';

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const notices = entry.notices ?? [];
  const noticesHtml = notices.length > 0
    ? `<div style="margin:16px 0;padding:12px 16px;background:#EFF6FF;border-left:4px solid #3B82F6;border-radius:4px;">
        <p style="margin:0 0 4px;font-weight:bold;color:#1E3A8A;font-size:13px;">Changes made to this file (${notices.length}). Please let the customer know:</p>
        <ul style="margin:0;padding:0 0 0 18px;color:#1E3A8A;font-size:12px;">
          ${notices.map(n => `<li style="margin:0 0 4px;">${esc(n)}</li>`).join('')}
        </ul>
      </div>`
    : '';

  const errorHtml = entry.errorMessage
    ? `<div style="margin:16px 0;padding:12px 16px;background:#FEF2F2;border-left:4px solid #EF4444;border-radius:4px;">
        <p style="margin:0;font-weight:bold;color:#991B1B;font-size:13px;">Error:</p>
        <p style="margin:4px 0 0;color:#7F1D1D;font-size:12px;">${entry.errorMessage}</p>
      </div>`
    : '';

  const body = `
    <div style="margin:0 0 16px;padding:12px 20px;background:${statusColor};border-radius:6px;text-align:center;">
      <span style="color:#fff;font-size:20px;font-weight:bold;">${statusIcon} Upload ${statusLabel}</span>
    </div>
    <table style="background:#f9f9f9;border:1px solid #eee;border-radius:6px;padding:14px 16px;width:100%;margin-bottom:16px;border-collapse:collapse;">
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Uploaded by</td><td style="font-size:13px;">${entry.userName} &lt;${entry.userEmail}&gt;</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Date</td><td style="font-size:13px;">${dateStr}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Time</td><td style="font-size:13px;">${timeStr}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">File</td><td style="font-size:13px;font-family:monospace;word-break:break-all;">${entry.filename}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Format Detected</td><td style="font-size:13px;">${entry.format}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Entries Found</td><td style="font-size:13px;">${entry.entriesFound}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Rows Added</td><td style="font-size:13px;color:${entry.rowsAdded > 0 ? tenant.primaryColor : '#666'};font-weight:${entry.rowsAdded > 0 ? 'bold' : 'normal'};">${entry.rowsAdded}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Rows Updated</td><td style="font-size:13px;color:${entry.rowsUpdated > 0 ? '#F59E0B' : '#666'};font-weight:${entry.rowsUpdated > 0 ? 'bold' : 'normal'};">${entry.rowsUpdated}</td></tr>
      <tr><td style="padding:5px 12px 5px 0;color:#666;font-size:13px;white-space:nowrap;">Total Schedule Rows</td><td style="font-size:13px;font-weight:bold;">${entry.totalRows}</td></tr>
    </table>
    ${noticesHtml}
    ${warningsHtml}
    ${errorHtml}
    <p style="margin:0;color:#999;font-size:12px;">This is an automated notification from ${tenant.name} ${tenant.subtitle}.</p>
  `;

  const subjectStatus = entry.status === 'success' ? '' : entry.status === 'partial' ? ' [WARNINGS]' : ' [FAILED]';
  return getResend().emails.send({
    from: getFrom(tenant),
    to: toEmails,
    subject: `${tenant.name} CC: Upload by ${entry.userName} — ${entry.filename}${subjectStatus}`,
    html: emailShell(body, tenant),
  });
}

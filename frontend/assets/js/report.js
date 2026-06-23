/**
 * report.js — GeoSentinel Client-Side PDF Report Generator
 *
 * Uses jsPDF (loaded via CDN in dashboard.html) to generate a formatted
 * assessment report entirely in the browser — no backend round-trip required.
 *
 * Public interface:
 *   ReportGenerator.download(assessment)
 *     Generates and triggers a browser download of the PDF.
 *     On any failure, dispatches CustomEvent('report:error') on document.
 *
 * Expected assessment object shape (matches POST /assessments 201 response):
 *   assessment_id       {string}
 *   created_at          {string}   ISO 8601
 *   hazard_score        {number}
 *   risk_category       {string}   Low | Moderate | High | Critical
 *   summary             {string}
 *   risk_explanation    {Array<{ parameter, direction, note }>}
 *   recommendations     {Array<string>}
 *   slope_angle         {number}
 *   rainfall_intensity  {number}
 *   soil_type           {string}
 *   vegetation_cover    {number}
 *   fault_zone_proximity{number}
 *   land_use_type       {string}
 *   drainage_condition  {string}
 *
 * PDF structure (Requirement 8.1, 8.2):
 *   Page 1+:  Header  — GeoSentinel | Assessment Report | timestamp
 *             Divider line
 *             Input Parameters table (7 rows, 2 columns: name | value + unit)
 *             Risk Score section (bold score + colour-coded category)
 *             Hazard Analysis section (7 factor rows: direction icon | name | note)
 *             Recommendations section (numbered list)
 *   Every page footer: disclaimer + page number
 *
 * Filename: GeoSentinel-Report-{assessmentId}.pdf
 */

// ---------------------------------------------------------------------------
// Constants — page geometry (all in mm, jsPDF default unit)
// ---------------------------------------------------------------------------

const PAGE_W      = 210;   // A4 width
const PAGE_H      = 297;   // A4 height
const MARGIN_L    = 18;
const MARGIN_R    = 18;
const MARGIN_T    = 20;
const MARGIN_B    = 20;
const CONTENT_W   = PAGE_W - MARGIN_L - MARGIN_R;  // 174 mm
const FOOTER_Y    = PAGE_H - MARGIN_B;

// Typography scale (pt)
const SIZE_H1     = 18;
const SIZE_H2     = 12;
const SIZE_BODY   = 10;
const SIZE_SMALL  =  8;
const SIZE_LABEL  =  9;

// Colours (RGB)
const COL_NAVY    = [15,  23,  42];   // #0F172A
const COL_CYAN    = [6,  182, 212];   // #06B6D4
const COL_WHITE   = [255,255,255];
const COL_LIGHT   = [241,245,249];    // text-primary
const COL_MUTED   = [100,116,139];    // text-muted
const COL_BORDER  = [51, 65, 85];     // slate-700

const RISK_COLOURS = {
  Low:      [16,185,129],   // #10B981
  Moderate: [245,158, 11],  // #F59E0B
  High:     [249,115, 22],  // #F97316
  Critical: [239, 68, 68],  // #EF4444
};

const DISCLAIMER =
  'This report represents a preliminary assessment and does not replace ' +
  'a professional geotechnical survey. GeoSentinel provides indicative ' +
  'landslide susceptibility scores for informational purposes only.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accesses jsPDF from the UMD global set by the CDN script.
 * Returns null if jsPDF is not loaded yet.
 * @returns {typeof import('jspdf').jsPDF | null}
 */
function getJsPDF() {
  if (typeof window !== 'undefined' && window.jspdf?.jsPDF) {
    return window.jspdf.jsPDF;
  }
  // Fallback: some CDN builds expose it directly as window.jsPDF
  if (typeof window !== 'undefined' && window.jsPDF) {
    return window.jsPDF;
  }
  return null;
}

/**
 * Formats an ISO 8601 timestamp for display in the PDF header.
 * @param {string} isoString
 * @returns {string}
 */
function fmtDate(isoString) {
  if (!isoString) return '—';
  try {
    return new Date(isoString).toLocaleString(undefined, {
      day: '2-digit', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return isoString;
  }
}

/**
 * Returns the direction indicator character for a factor explanation.
 * @param {string} direction  'increasing' | 'reducing' | 'neutral'
 * @returns {string}
 */
function dirIcon(direction) {
  if (direction === 'increasing') return '\u25B2';  // ▲
  if (direction === 'reducing')   return '\u25BC';  // ▼
  return '\u2192';                                   // →
}

/**
 * Returns the RGB colour for a direction.
 * @param {string} direction
 * @returns {number[]}
 */
function dirColour(direction) {
  if (direction === 'increasing') return [239, 68, 68];   // red
  if (direction === 'reducing')   return [16, 185, 129];  // green
  return [100, 116, 139];                                  // muted
}

// ---------------------------------------------------------------------------
// PDF layout engine — cursor-based, auto page breaks
// ---------------------------------------------------------------------------

/**
 * Minimal layout state threaded through all drawing functions.
 * @typedef {{ doc: *, y: number, page: number }} Ctx
 */

/**
 * Advances y by `dy`. If the cursor would exceed the safe area, inserts a
 * new page, re-draws the header strip, and resets y to just below the header.
 *
 * @param {Ctx}    ctx
 * @param {number} dy         — space needed before next content block
 * @param {number} [needed=0] — additional look-ahead (for multi-line blocks)
 */
function advanceY(ctx, dy, needed = 0) {
  ctx.y += dy;
  const safeBottom = FOOTER_Y - SIZE_SMALL - 4;
  if (ctx.y + needed > safeBottom) {
    addPage(ctx);
  }
}

/**
 * Adds a new page and draws the narrow header strip.
 * @param {Ctx} ctx
 */
function addPage(ctx) {
  ctx.doc.addPage();
  ctx.page += 1;
  drawPageHeader(ctx, null);  // null = continuation page (no full header block)
  ctx.y = MARGIN_T + 12;
}

// ---------------------------------------------------------------------------
// Page-level drawing primitives
// ---------------------------------------------------------------------------

/**
 * Draws the dark header band at the top of every page.
 * On page 1 (full=true) it also renders the assessment metadata.
 * On continuation pages it draws a minimal band.
 *
 * @param {Ctx}    ctx
 * @param {Object|null} assessment  — null for continuation pages
 */
function drawPageHeader(ctx, assessment) {
  const doc = ctx.doc;

  // Dark band
  doc.setFillColor(...COL_NAVY);
  doc.rect(0, 0, PAGE_W, assessment ? 38 : 14, 'F');

  // Brand name
  doc.setFontSize(assessment ? SIZE_H1 : SIZE_LABEL);
  doc.setTextColor(...COL_CYAN);
  doc.setFont('helvetica', 'bold');
  doc.text('GeoSentinel', MARGIN_L, assessment ? 13 : 10);

  if (assessment) {
    // Tagline
    doc.setFontSize(SIZE_SMALL);
    doc.setTextColor(...COL_MUTED);
    doc.setFont('helvetica', 'normal');
    doc.text('Landslide Hazard Assessment Report', MARGIN_L, 19);

    // Timestamp (right-aligned)
    const ts = fmtDate(assessment.created_at);
    doc.text(ts, PAGE_W - MARGIN_R, 13, { align: 'right' });

    // Assessment ID (right-aligned, small)
    doc.setFontSize(SIZE_SMALL - 1);
    doc.setTextColor(...COL_MUTED);
    doc.text(`ID: ${assessment.assessment_id ?? '—'}`, PAGE_W - MARGIN_R, 19, { align: 'right' });

    // Horizontal rule
    doc.setDrawColor(...COL_CYAN);
    doc.setLineWidth(0.4);
    doc.line(MARGIN_L, 34, PAGE_W - MARGIN_R, 34);
  }
}

/**
 * Draws the footer on the current page: disclaimer + page number.
 * @param {Ctx} ctx
 */
function drawPageFooter(ctx) {
  const doc = ctx.doc;
  const y   = FOOTER_Y;

  // Thin rule
  doc.setDrawColor(...COL_BORDER);
  doc.setLineWidth(0.2);
  doc.line(MARGIN_L, y - 3, PAGE_W - MARGIN_R, y - 3);

  // Disclaimer
  doc.setFontSize(SIZE_SMALL - 1);
  doc.setTextColor(...COL_MUTED);
  doc.setFont('helvetica', 'italic');
  const lines = doc.splitTextToSize(DISCLAIMER, CONTENT_W - 20);
  doc.text(lines, MARGIN_L, y);

  // Page number
  doc.setFont('helvetica', 'normal');
  doc.text(`Page ${ctx.page}`, PAGE_W - MARGIN_R, y, { align: 'right' });
}

// ---------------------------------------------------------------------------
// Section drawing helpers
// ---------------------------------------------------------------------------

/**
 * Draws a section heading with a left accent bar.
 * @param {Ctx}    ctx
 * @param {string} title
 */
function drawSectionHeading(ctx, title) {
  const doc = ctx.doc;
  advanceY(ctx, 0, 10);

  // Accent bar
  doc.setFillColor(...COL_CYAN);
  doc.rect(MARGIN_L, ctx.y, 2.5, 6.5, 'F');

  doc.setFontSize(SIZE_H2);
  doc.setTextColor(...COL_LIGHT);
  doc.setFont('helvetica', 'bold');
  doc.text(title, MARGIN_L + 5, ctx.y + 5.5);

  advanceY(ctx, 10);
}

/**
 * Draws a single key-value row for the parameters table.
 * Alternates background shading every other row.
 *
 * @param {Ctx}    ctx
 * @param {string} label
 * @param {string} value
 * @param {boolean} shaded
 */
function drawParamRow(ctx, label, value, shaded) {
  const doc = ctx.doc;
  const ROW_H = 7.5;

  advanceY(ctx, 0, ROW_H);

  if (shaded) {
    doc.setFillColor(20, 30, 50);
    doc.rect(MARGIN_L, ctx.y, CONTENT_W, ROW_H, 'F');
  }

  const colBreak = MARGIN_L + CONTENT_W * 0.52;

  doc.setFontSize(SIZE_BODY);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...COL_MUTED);
  doc.text(label, MARGIN_L + 3, ctx.y + 5);

  doc.setTextColor(...COL_LIGHT);
  doc.setFont('helvetica', 'bold');
  doc.text(value, colBreak, ctx.y + 5);

  advanceY(ctx, ROW_H);
}

/**
 * Draws the Risk Score panel: large score number + coloured category badge.
 * @param {Ctx}    ctx
 * @param {number} score
 * @param {string} category
 */
function drawScorePanel(ctx, score, category) {
  const doc    = ctx.doc;
  const colour = RISK_COLOURS[category] ?? RISK_COLOURS.High;
  const panelH = 22;

  advanceY(ctx, 0, panelH + 4);

  // Panel background
  doc.setFillColor(15, 25, 45);
  doc.roundedRect(MARGIN_L, ctx.y, CONTENT_W, panelH, 2, 2, 'F');

  // Score number
  doc.setFontSize(28);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...colour);
  doc.text(String(score), MARGIN_L + 8, ctx.y + 15);

  // "/100" suffix
  doc.setFontSize(SIZE_BODY);
  doc.setTextColor(...COL_MUTED);
  doc.setFont('helvetica', 'normal');
  doc.text('/ 100', MARGIN_L + 8 + doc.getTextWidth(String(score)) + 1, ctx.y + 15);

  // Category badge (right side)
  const badgeX = PAGE_W - MARGIN_R - 36;
  doc.setFillColor(...colour.map(c => Math.round(c * 0.2)));
  doc.roundedRect(badgeX, ctx.y + 5, 34, 12, 2, 2, 'F');
  doc.setFontSize(SIZE_H2);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...colour);
  doc.text(category, badgeX + 17, ctx.y + 13, { align: 'center' });

  // Risk label
  doc.setFontSize(SIZE_SMALL);
  doc.setTextColor(...COL_MUTED);
  doc.setFont('helvetica', 'normal');
  doc.text('RISK CATEGORY', badgeX + 17, ctx.y + 20, { align: 'center' });

  advanceY(ctx, panelH + 4);
}

/**
 * Draws the summary sentence below the score panel.
 * @param {Ctx}    ctx
 * @param {string} summary
 */
function drawSummary(ctx, summary) {
  const doc = ctx.doc;
  advanceY(ctx, 0, 8);
  doc.setFontSize(SIZE_BODY);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...COL_MUTED);
  const lines = doc.splitTextToSize(summary, CONTENT_W);
  lines.forEach((line) => {
    advanceY(ctx, 0, 5.5);
    doc.text(line, MARGIN_L, ctx.y);
    advanceY(ctx, 5.5);
  });
  advanceY(ctx, 3);
}

/**
 * Draws one factor row in the Hazard Analysis section.
 * @param {Ctx}    ctx
 * @param {{ parameter, direction, note }} factor
 * @param {number} idx
 */
function drawFactorRow(ctx, factor, idx) {
  const doc    = ctx.doc;
  const ROW_H  = 9;
  const colour = dirColour(factor.direction);

  advanceY(ctx, 0, ROW_H + 1);

  if (idx % 2 === 0) {
    doc.setFillColor(18, 28, 48);
    doc.rect(MARGIN_L, ctx.y, CONTENT_W, ROW_H, 'F');
  }

  // Direction indicator
  doc.setFontSize(SIZE_BODY);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...colour);
  doc.text(dirIcon(factor.direction), MARGIN_L + 3, ctx.y + 6.5);

  // Parameter name
  const nameX = MARGIN_L + 10;
  doc.setTextColor(...COL_LIGHT);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(SIZE_BODY - 0.5);
  // Strip underscores for readability
  const name = (factor.parameter ?? '').replace(/_/g, ' ');
  doc.text(name, nameX, ctx.y + 6.5);

  // Note text (right column)
  const noteX = MARGIN_L + CONTENT_W * 0.38;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(SIZE_SMALL + 0.5);
  doc.setTextColor(...COL_MUTED);
  const noteLines = doc.splitTextToSize(factor.note ?? '', CONTENT_W - (noteX - MARGIN_L) - 2);
  const lineCount = noteLines.length;
  const rowNeeded = Math.max(ROW_H, lineCount * 4.5);

  // Re-draw background if note wraps
  if (lineCount > 1 && idx % 2 === 0) {
    doc.setFillColor(18, 28, 48);
    doc.rect(MARGIN_L, ctx.y, CONTENT_W, rowNeeded, 'F');
    // Re-draw text already placed
    doc.setFontSize(SIZE_BODY);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...colour);
    doc.text(dirIcon(factor.direction), MARGIN_L + 3, ctx.y + 6.5);
    doc.setTextColor(...COL_LIGHT);
    doc.text(name, nameX, ctx.y + 6.5);
  }

  noteLines.forEach((noteLine, li) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(SIZE_SMALL + 0.5);
    doc.setTextColor(...COL_MUTED);
    doc.text(noteLine, noteX, ctx.y + 5.5 + li * 4.5);
  });

  advanceY(ctx, Math.max(ROW_H, rowNeeded) + 1);
}

/**
 * Draws the numbered recommendations list.
 * @param {Ctx}           ctx
 * @param {Array<string>} recs
 */
function drawRecommendations(ctx, recs) {
  const doc = ctx.doc;
  recs.forEach((rec, i) => {
    advanceY(ctx, 0, 8);

    // Number bubble
    doc.setFillColor(...COL_CYAN);
    doc.circle(MARGIN_L + 3.5, ctx.y + 3.5, 3.5, 'F');
    doc.setFontSize(SIZE_SMALL);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...COL_NAVY);
    doc.text(String(i + 1), MARGIN_L + 3.5, ctx.y + 5, { align: 'center' });

    // Recommendation text
    doc.setFontSize(SIZE_BODY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COL_LIGHT);
    const lines = doc.splitTextToSize(rec, CONTENT_W - 12);
    lines.forEach((line, li) => {
      if (li > 0) advanceY(ctx, 0, 5.5);
      doc.text(line, MARGIN_L + 10, ctx.y + 5);
      if (li < lines.length - 1) advanceY(ctx, 5.5);
    });

    advanceY(ctx, 8);
  });
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Generates and triggers download of a PDF assessment report.
 *
 * @param {Object} assessment  — Full assessment record (see data contract above)
 */
function download(assessment) {
  try {
    const JsPDF = getJsPDF();
    if (!JsPDF) {
      throw new Error('jsPDF library is not loaded. Cannot generate PDF.');
    }

    const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });

    // Set document metadata
    doc.setProperties({
      title:    `GeoSentinel Assessment Report — ${assessment.assessment_id ?? ''}`,
      subject:  'Landslide Hazard Assessment',
      author:   'GeoSentinel Platform',
      keywords: 'landslide, hazard, geology, risk assessment',
      creator:  'GeoSentinel',
    });

    // Page 1 background
    doc.setFillColor(...COL_NAVY);
    doc.rect(0, 0, PAGE_W, PAGE_H, 'F');

    // Threading context
    /** @type {Ctx} */
    const ctx = { doc, y: MARGIN_T, page: 1 };

    // ── Header
    drawPageHeader(ctx, assessment);
    ctx.y = 40;

    // ── Input Parameters
    drawSectionHeading(ctx, 'Input Parameters');

    const params = [
      ['Slope Angle',          `${assessment.slope_angle ?? '—'}°`,            false],
      ['Rainfall Intensity',   `${assessment.rainfall_intensity ?? '—'} mm/h`,  true],
      ['Soil Type',            assessment.soil_type ?? '—',                     false],
      ['Vegetation Cover',     `${assessment.vegetation_cover ?? '—'}%`,         true],
      ['Fault Zone Proximity', `${assessment.fault_zone_proximity ?? '—'} km`,   false],
      ['Land Use Type',        (assessment.land_use_type ?? '—').replace(/_/g,' '), true],
      ['Drainage Condition',   assessment.drainage_condition ?? '—',            false],
    ];

    params.forEach(([label, value, shaded]) => drawParamRow(ctx, label, value, shaded));
    advanceY(ctx, 6);

    // ── Risk Score
    drawSectionHeading(ctx, 'Risk Score');
    drawScorePanel(ctx, assessment.hazard_score ?? 0, assessment.risk_category ?? 'Low');
    if (assessment.summary) {
      drawSummary(ctx, assessment.summary);
    }

    // ── Hazard Analysis
    drawSectionHeading(ctx, 'Hazard Analysis');

    const explanations = Array.isArray(assessment.risk_explanation)
      ? assessment.risk_explanation
      : [];

    if (explanations.length === 0) {
      doc.setFontSize(SIZE_BODY);
      doc.setTextColor(...COL_MUTED);
      doc.text('No factor breakdown available.', MARGIN_L, ctx.y);
      advanceY(ctx, 7);
    } else {
      explanations.forEach((factor, i) => drawFactorRow(ctx, factor, i));
    }

    advanceY(ctx, 4);

    // ── Recommendations
    drawSectionHeading(ctx, 'Mitigation Recommendations');

    const recs = Array.isArray(assessment.recommendations)
      ? assessment.recommendations
      : [];

    if (recs.length === 0) {
      doc.setFontSize(SIZE_BODY);
      doc.setTextColor(...COL_MUTED);
      doc.text('No recommendations available.', MARGIN_L, ctx.y);
      advanceY(ctx, 7);
    } else {
      drawRecommendations(ctx, recs);
    }

    // ── Draw footer on every page
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      ctx.page = p;
      drawPageFooter(ctx);
    }

    // ── Trigger download
    const safeId  = (assessment.assessment_id ?? 'unknown').replace(/[^a-zA-Z0-9-_]/g, '');
    const filename = `GeoSentinel-Report-${safeId}.pdf`;
    doc.save(filename);

  } catch (err) {
    console.error('[ReportGenerator] PDF generation failed:', err);
    document.dispatchEvent(new CustomEvent('report:error', { detail: err, bubbles: true }));
  }
}

// ---------------------------------------------------------------------------
// Named export (matches design spec: ReportGenerator.download)
// ---------------------------------------------------------------------------

export const ReportGenerator = { download };
export default ReportGenerator;

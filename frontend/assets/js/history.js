/**
 * history.js — GeoSentinel Assessment History Table
 *
 * Renders the Assessment_History table from a list of assessment records,
 * manages the "no records" empty state, and dispatches a custom event
 * when the user selects a row.
 *
 * Targets these DOM elements (all present in dashboard.html):
 *   #history-tbody      — <tbody> to populate
 *   #history-empty-row  — default empty state row (hidden when records exist)
 *   #history-count      — record count badge in the table header
 *
 * Public interface:
 *   HistoryTable.render(items)   — replace table with up to 50 records
 *   HistoryTable.prepend(item)   — insert one new record at the top
 *
 * Events dispatched on document:
 *   CustomEvent('assessment:selected', { detail: <full assessment record> })
 *
 * Data contract — each item must have at minimum:
 *   assessment_id    {string}
 *   created_at       {string}  ISO 8601 timestamp
 *   slope_angle      {number}
 *   rainfall_intensity {number}
 *   soil_type        {string}
 *   hazard_score     {number}
 *   risk_category    {string}  'Low' | 'Moderate' | 'High' | 'Critical'
 *
 * Full assessment fields (used when a row is clicked):
 *   risk_explanation  {Array}
 *   summary           {string}
 *   recommendations   {Array<string>}
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of rows kept in the table at one time (design spec). */
const MAX_ROWS = 50;

// ---------------------------------------------------------------------------
// Risk badge HTML helpers
// ---------------------------------------------------------------------------

/**
 * Returns the CSS class name for a risk category badge.
 * @param {string} category
 * @returns {string}
 */
function badgeClass(category) {
  const map = {
    Low:      'badge badge-low',
    Moderate: 'badge badge-moderate',
    High:     'badge badge-high',
    Critical: 'badge badge-critical',
  };
  return map[category] ?? 'badge';
}

// ---------------------------------------------------------------------------
// Date formatting
// ---------------------------------------------------------------------------

/**
 * Formats an ISO 8601 timestamp into a compact, human-readable string.
 * e.g. "23 Jun 2026, 10:30"
 *
 * @param {string} isoString
 * @returns {string}
 */
function formatTimestamp(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return d.toLocaleString(undefined, {
      day:    '2-digit',
      month:  'short',
      year:   'numeric',
      hour:   '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/** @returns {HTMLElement|null} */
const el = (id) => document.getElementById(id);

/**
 * Updates the record count badge text.
 * @param {number} count
 */
function updateCount(count) {
  const countEl = el('history-count');
  if (countEl) {
    countEl.textContent = count === 1 ? '1 record' : `${count} records`;
  }
}

/**
 * Shows or hides the empty-state row.
 * @param {boolean} visible
 */
function setEmptyRowVisible(visible) {
  const emptyRow = el('history-empty-row');
  if (emptyRow) {
    emptyRow.style.display = visible ? '' : 'none';
  }
}

// ---------------------------------------------------------------------------
// Row creation
// ---------------------------------------------------------------------------

/**
 * Creates a fully populated <tr> element for one assessment record.
 * Attaches a click handler that dispatches the 'assessment:selected' event.
 *
 * @param {Object} item  — Assessment record (see data contract above)
 * @param {number} index — Row index (used for accessible labelling)
 * @returns {HTMLTableRowElement}
 */
function createRow(item, index) {
  const tr = document.createElement('tr');
  tr.dataset.assessmentId = item.assessment_id ?? '';

  // Accessible label for screen readers
  tr.setAttribute(
    'aria-label',
    `Assessment ${index + 1}: ${item.risk_category} risk, score ${item.hazard_score}, ` +
    `recorded ${formatTimestamp(item.created_at)}`
  );
  tr.setAttribute('tabindex', '0');
  tr.setAttribute('role', 'row');

  // ── Timestamp
  const tdTime = document.createElement('td');
  tdTime.textContent = formatTimestamp(item.created_at);
  tr.appendChild(tdTime);

  // ── Slope Angle
  const tdSlope = document.createElement('td');
  tdSlope.textContent = item.slope_angle != null ? `${item.slope_angle}°` : '—';
  tr.appendChild(tdSlope);

  // ── Rainfall Intensity
  const tdRain = document.createElement('td');
  tdRain.textContent = item.rainfall_intensity != null ? `${item.rainfall_intensity}` : '—';
  tr.appendChild(tdRain);

  // ── Soil Type
  const tdSoil = document.createElement('td');
  tdSoil.textContent = item.soil_type ?? '—';
  tr.appendChild(tdSoil);

  // ── Hazard Score (coloured)
  const tdScore = document.createElement('td');
  tdScore.style.fontWeight = '700';
  tdScore.style.color = _riskColour(item.risk_category);
  tdScore.textContent = item.hazard_score != null ? String(item.hazard_score) : '—';
  tr.appendChild(tdScore);

  // ── Risk Category badge
  const tdCat = document.createElement('td');
  if (item.risk_category) {
    const span = document.createElement('span');
    span.className   = badgeClass(item.risk_category);
    span.textContent = item.risk_category;
    tdCat.appendChild(span);
  } else {
    tdCat.textContent = '—';
  }
  tr.appendChild(tdCat);

  // ── View button
  const tdAction = document.createElement('td');
  const viewBtn  = document.createElement('button');
  viewBtn.className   = 'btn btn-ghost';
  viewBtn.style.cssText = 'padding:4px 12px;font-size:0.78rem;';
  viewBtn.textContent = 'View';
  viewBtn.setAttribute('aria-label', `View details for assessment from ${formatTimestamp(item.created_at)}`);
  viewBtn.type = 'button';
  tdAction.appendChild(viewBtn);
  tr.appendChild(tdAction);

  // ── Click / keyboard handlers
  function handleSelect() {
    // Highlight active row
    _clearActiveRow();
    tr.classList.add('active-row');
    // Dispatch event carrying the full assessment record
    document.dispatchEvent(
      new CustomEvent('assessment:selected', { detail: item, bubbles: true })
    );
  }

  tr.addEventListener('click', handleSelect);

  // Keyboard: activate on Enter or Space (row is focusable via tabindex)
  tr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSelect();
    }
  });

  viewBtn.addEventListener('click', (e) => {
    // Prevent the row's own click from firing twice
    e.stopPropagation();
    handleSelect();
  });

  return tr;
}

/**
 * Returns the inline colour value for a risk category.
 * Matches the design tokens.
 * @param {string} category
 * @returns {string}
 */
function _riskColour(category) {
  const colours = {
    Low:      '#10B981',
    Moderate: '#F59E0B',
    High:     '#F97316',
    Critical: '#EF4444',
  };
  return colours[category] ?? '#F1F5F9';
}

/**
 * Removes the active-row highlight from all rows in the table.
 */
function _clearActiveRow() {
  const tbody = el('history-tbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr.active-row').forEach((r) => r.classList.remove('active-row'));
}

// ---------------------------------------------------------------------------
// Internal row-count tracking
// ---------------------------------------------------------------------------

/** Number of actual data rows currently rendered (excludes the empty-state row). */
let _rowCount = 0;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Replaces the table body with up to MAX_ROWS records from `items`.
 * Items are expected to be already ordered newest-first (server responsibility).
 * If items is empty, the empty-state row is shown.
 *
 * @param {Array<Object>} items  — Array of assessment records
 */
function render(items) {
  const tbody = el('history-tbody');
  if (!tbody) return;

  // Remove all rows except the hidden empty-state row (keep the element)
  Array.from(tbody.querySelectorAll('tr:not(#history-empty-row)')).forEach((r) => r.remove());

  _rowCount = 0;

  if (!Array.isArray(items) || items.length === 0) {
    setEmptyRowVisible(true);
    updateCount(0);
    return;
  }

  setEmptyRowVisible(false);

  const capped = items.slice(0, MAX_ROWS);
  // Insert each row before the (hidden) empty-state row so DOM order is stable
  const emptyRow = el('history-empty-row');
  capped.forEach((item, idx) => {
    const row = createRow(item, idx);
    tbody.insertBefore(row, emptyRow);
  });

  _rowCount = capped.length;
  updateCount(_rowCount);
}

/**
 * Inserts a single new record at the top of the table.
 * If the table now exceeds MAX_ROWS, the last data row is removed.
 * Used after a successful assessment submission to add the new result instantly
 * without a full re-render.
 *
 * @param {Object} item  — A single assessment record
 */
function prepend(item) {
  const tbody   = el('history-tbody');
  const emptyRow = el('history-empty-row');
  if (!tbody) return;

  // Hide empty state
  setEmptyRowVisible(false);

  // Create and insert at top (before the first data row, or before emptyRow)
  const firstDataRow = tbody.querySelector('tr:not(#history-empty-row)');
  const newRow       = createRow(item, 0);

  if (firstDataRow) {
    tbody.insertBefore(newRow, firstDataRow);
  } else {
    tbody.insertBefore(newRow, emptyRow);
  }

  _rowCount += 1;

  // Trim excess rows from the bottom if we exceed the cap
  if (_rowCount > MAX_ROWS) {
    const allDataRows = tbody.querySelectorAll('tr:not(#history-empty-row)');
    const excess      = allDataRows.length - MAX_ROWS;
    for (let i = 0; i < excess; i++) {
      const last = tbody.querySelector('tr:not(#history-empty-row):last-child');
      if (last) last.remove();
    }
    _rowCount = MAX_ROWS;
  }

  updateCount(_rowCount);
}

// ---------------------------------------------------------------------------
// Named export object (matches design spec: HistoryTable.render / .prepend)
// ---------------------------------------------------------------------------

export const HistoryTable = { render, prepend };
export default HistoryTable;

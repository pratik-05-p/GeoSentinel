/**
 * app.js — GeoSentinel Dashboard Controller
 *
 * Orchestrates the full dashboard lifecycle:
 *   1. On DOMContentLoaded: load assessment history from the API
 *   2. Handle form submission: validate → call API → render all result panels
 *   3. Handle history row selection: reload result panels for historical records
 *   4. Handle PDF download button
 *   5. Handle error/warning toasts and banners
 *
 * Imports (ES modules):
 *   api            from './api.js'
 *   GaugeRenderer  from './gauge.js'
 *   HistoryTable   from './history.js'
 *   ReportGenerator from './report.js'
 *
 * DOM IDs targeted (all present in dashboard.html):
 *   Form:          #assessment-form, #analyze-btn, #analyze-btn-text, #analyze-spinner
 *   Fields:        #slope-angle, #rainfall-intensity, #soil-type, #vegetation-cover,
 *                  #fault-proximity, #land-use-type, #drainage-condition
 *   Field errors:  #slope-angle-error, #rainfall-error, #soil-type-error,
 *                  #vegetation-error, #fault-error, #land-use-error, #drainage-error
 *   Results:       #gauge-placeholder, #gauge-result, #category-placeholder,
 *                  #category-result, #category-badge, #category-summary,
 *                  #analysis-placeholder, #factor-list, #analysis-summary,
 *                  #rec-placeholder, #rec-list, #pdf-btn
 *   History:       #history-tbody, #history-empty-row, #history-count
 *   Notifications: #warning-banner, #warning-banner-text, #toast-container
 */

import api              from './api.js';
import GaugeRenderer    from './gauge.js';
import HistoryTable     from './history.js';
import ReportGenerator  from './report.js';

// ---------------------------------------------------------------------------
// Session cache — assessments fetched or submitted this session
// Used as fallback when the history API call fails on init.
// ---------------------------------------------------------------------------

/** @type {Array<Object>} */
let _sessionCache = [];

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

/** @param {string} id @returns {HTMLElement|null} */
const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Validation rules — mirrors validator.py exactly (Requirements 1.2–1.8)
// ---------------------------------------------------------------------------

/**
 * Field descriptor used by the client-side validator.
 * @typedef {{ id: string, name: string, errorId: string, type: 'number'|'select',
 *             min?: number, max?: number, enums?: string[], unit?: string }} FieldSpec
 */

/** @type {FieldSpec[]} */
const FIELD_SPECS = [
  {
    id: 'slope-angle',     name: 'Slope Angle',
    errorId: 'slope-angle-error',
    apiKey: 'slope_angle',
    type: 'number', min: 0, max: 90,
    unit: 'degrees (0–90)',
  },
  {
    id: 'rainfall-intensity', name: 'Rainfall Intensity',
    errorId: 'rainfall-error',
    apiKey: 'rainfall_intensity',
    type: 'number', min: 0, max: 1000,
    unit: 'mm/h (0–1000)',
  },
  {
    id: 'soil-type',       name: 'Soil Type',
    errorId: 'soil-type-error',
    apiKey: 'soil_type',
    type: 'select', enums: ['Clay', 'Silt', 'Loam', 'Sandy', 'Rocky'],
  },
  {
    id: 'vegetation-cover', name: 'Vegetation Cover',
    errorId: 'vegetation-error',
    apiKey: 'vegetation_cover',
    type: 'number', min: 0, max: 100,
    unit: '% (0–100)',
  },
  {
    id: 'fault-proximity', name: 'Fault Zone Proximity',
    errorId: 'fault-error',
    apiKey: 'fault_zone_proximity',
    type: 'number', min: 0, max: 500,
    unit: 'km (0–500)',
  },
  {
    id: 'land-use-type',   name: 'Land Use Type',
    errorId: 'land-use-error',
    apiKey: 'land_use_type',
    type: 'select', enums: ['Forest', 'Agricultural', 'Urban', 'Bare_Ground'],
  },
  {
    id: 'drainage-condition', name: 'Drainage Condition',
    errorId: 'drainage-error',
    apiKey: 'drainage_condition',
    type: 'select', enums: ['Good', 'Moderate', 'Poor'],
  },
];

// ---------------------------------------------------------------------------
// Client-side form validation
// ---------------------------------------------------------------------------

/**
 * Validates all seven form fields.
 * Sets or clears error messages for each field.
 * Returns either the valid body object (ready to POST) or null if any field fails.
 *
 * @returns {{ body: Object, valid: boolean }}
 */
function validateForm() {
  let valid = true;
  const body = {};

  FIELD_SPECS.forEach((spec) => {
    const input   = el(spec.id);
    const errorEl = el(spec.errorId);
    const raw     = input?.value?.trim() ?? '';

    let errMsg = '';

    if (raw === '') {
      errMsg = `${spec.name} is required.`;
    } else if (spec.type === 'number') {
      const num = parseFloat(raw);
      if (isNaN(num)) {
        errMsg = `${spec.name} must be a number.`;
      } else if (num < spec.min || num > spec.max) {
        errMsg = `${spec.name} must be between ${spec.min} and ${spec.max} ${spec.unit ?? ''}.`.trim();
      } else {
        body[spec.apiKey] = num;
      }
    } else if (spec.type === 'select') {
      if (!spec.enums.includes(raw)) {
        errMsg = `${spec.name}: please select a valid option (${spec.enums.join(', ')}).`;
      } else {
        body[spec.apiKey] = raw;
      }
    }

    if (errMsg) {
      valid = false;
      if (input)   input.classList.add('error');
      if (errorEl) errorEl.textContent = errMsg;
    } else {
      if (input)   input.classList.remove('error');
      if (errorEl) errorEl.textContent = '';
    }
  });

  return { valid, body };
}

/**
 * Clears all field-level validation errors.
 */
function clearValidationErrors() {
  FIELD_SPECS.forEach((spec) => {
    const input   = el(spec.id);
    const errorEl = el(spec.errorId);
    if (input)   input.classList.remove('error');
    if (errorEl) errorEl.textContent = '';
  });
}

// ---------------------------------------------------------------------------
// Submit button state helpers
// ---------------------------------------------------------------------------

/** Puts the Analyze button into loading state. */
function setButtonLoading() {
  const btn      = el('analyze-btn');
  const spinner  = el('analyze-spinner');
  const btnText  = el('analyze-btn-text');
  if (btn)     { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  if (spinner) spinner.style.display = 'inline-block';
  if (btnText) btnText.textContent   = 'Analyzing…';
}

/** Restores the Analyze button to its default state. */
function setButtonReady() {
  const btn      = el('analyze-btn');
  const spinner  = el('analyze-spinner');
  const btnText  = el('analyze-btn-text');
  if (btn)     { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  if (spinner) spinner.style.display = 'none';
  if (btnText) btnText.textContent   = '🔍 Analyze Risk';
}

// ---------------------------------------------------------------------------
// Result panel rendering
// ---------------------------------------------------------------------------

/**
 * Direction icons used in the Hazard Analysis card.
 * @type {Record<string, string>}
 */
const DIR_ICONS = {
  increasing: '▲',
  reducing:   '▼',
  neutral:    '→',
};

const DIR_CSS_CLASSES = {
  increasing: 'factor-dir-increasing',
  reducing:   'factor-dir-reducing',
  neutral:    'factor-dir-neutral',
};

/**
 * Renders the Risk Category badge panel.
 * @param {string} category
 * @param {string} summary
 */
function renderCategory(category, summary) {
  const placeholder = el('category-placeholder');
  const resultEl    = el('category-result');
  const badgeEl     = el('category-badge');
  const summaryEl   = el('category-summary');

  if (placeholder) placeholder.style.display = 'none';
  if (resultEl)    resultEl.style.display     = 'block';

  if (badgeEl) {
    // Remove previous risk class
    badgeEl.className = 'category-badge-large';
    badgeEl.classList.add(`risk-${category.toLowerCase()}`);
    badgeEl.textContent = category;
  }

  if (summaryEl) summaryEl.textContent = summary ?? '';
}

/**
 * Renders the Hazard Analysis card with 7 factor rows + summary.
 * @param {Array<{ parameter, direction, note }>} explanation
 * @param {string} summary
 */
function renderAnalysis(explanation, summary) {
  const placeholder  = el('analysis-placeholder');
  const factorList   = el('factor-list');
  const summaryEl    = el('analysis-summary');

  if (placeholder) placeholder.style.display = 'none';

  if (factorList) {
    factorList.style.display = 'flex';
    factorList.innerHTML     = '';

    const factors = Array.isArray(explanation) ? explanation : [];
    factors.forEach((factor) => {
      const row = document.createElement('div');
      row.className   = 'factor-row';
      row.setAttribute('role', 'listitem');

      const dir      = factor.direction ?? 'neutral';
      const dirClass = DIR_CSS_CLASSES[dir] ?? DIR_CSS_CLASSES.neutral;
      const dirIcon  = DIR_ICONS[dir] ?? '→';
      const paramName = (factor.parameter ?? '').replace(/_/g, ' ');

      row.innerHTML = `
        <div class="factor-direction ${dirClass}" aria-label="${dir} risk factor" aria-hidden="true">
          ${dirIcon}
        </div>
        <div>
          <div class="factor-name">${paramName}</div>
          <div class="factor-note">${factor.note ?? ''}</div>
        </div>
      `;

      factorList.appendChild(row);
    });
  }

  if (summaryEl && summary) {
    summaryEl.style.display  = 'block';
    summaryEl.textContent    = summary;
  }
}

/**
 * Renders the Recommendations panel.
 * @param {Array<string>} recommendations
 */
function renderRecommendations(recommendations) {
  const placeholder = el('rec-placeholder');
  const recList     = el('rec-list');

  if (placeholder) placeholder.style.display = 'none';

  if (recList) {
    recList.style.display = 'flex';
    recList.innerHTML     = '';

    const recs = Array.isArray(recommendations) ? recommendations : [];

    // Icon map for known recommendations; falls back to a generic wrench
    const iconMap = {
      'Improve drainage systems':              '💧',
      'Increase vegetation cover':             '🌿',
      'Conduct geotechnical surveys':          '🔬',
      'Install retaining structures':          '🏗',
      'Restrict construction in vulnerable areas': '🚫',
      'Continue routine site monitoring':      '📊',
    };

    recs.forEach((rec) => {
      const li   = document.createElement('li');
      li.className = 'rec-item';
      li.setAttribute('role', 'listitem');

      const icon = iconMap[rec] ?? '🛠';

      li.innerHTML = `
        <div class="rec-icon" aria-hidden="true">${icon}</div>
        <div class="rec-text">${rec}</div>
      `;

      recList.appendChild(li);
    });
  }
}

/**
 * Enables the PDF download button and binds it to the given assessment.
 * @param {Object} assessment
 */
function enablePdfButton(assessment) {
  const btn = el('pdf-btn');
  if (!btn) return;

  btn.disabled = false;
  btn.setAttribute('aria-disabled', 'false');

  // Clone node to remove any old listeners before re-binding
  const fresh = btn.cloneNode(true);
  btn.replaceWith(fresh);

  fresh.addEventListener('click', () => {
    ReportGenerator.download(assessment);
  });
}

/**
 * Renders all result panels from a single assessment record.
 * Called both after a fresh submission and when a history row is selected.
 *
 * @param {Object}  result
 * @param {boolean} [animate=true]  — whether to animate the gauge
 */
function renderResult(result, animate = true) {
  if (animate) {
    GaugeRenderer.render(result.hazard_score, result.risk_category);
  } else {
    GaugeRenderer.render(result.hazard_score, result.risk_category);
  }
  renderCategory(result.risk_category, result.summary);
  renderAnalysis(result.risk_explanation, result.summary);
  renderRecommendations(result.recommendations);
  enablePdfButton(result);
}

// ---------------------------------------------------------------------------
// Toast notification system
// ---------------------------------------------------------------------------

/**
 * Displays a dismissible toast notification.
 * @param {string} message
 * @param {'warning'|'error'|'success'} type
 * @param {number} [durationMs=6000]  — 0 = sticky until dismissed
 */
function showToast(message, type = 'warning', durationMs = 6000) {
  const container = el('toast-container');
  if (!container) return;

  const icons = { warning: '⚠️', error: '❌', success: '✅' };
  const toast  = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] ?? '💬'}</span>
    <span class="toast-msg">${message}</span>
    <button class="toast-close" aria-label="Dismiss notification">×</button>
  `;

  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  container.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(() => { if (toast.isConnected) toast.remove(); }, durationMs);
  }
}

/**
 * Shows the persistent warning banner above the dashboard content.
 * @param {string} message
 */
function showWarningBanner(message) {
  const banner  = el('warning-banner');
  const textEl  = el('warning-banner-text');
  if (!banner) return;
  if (textEl)  textEl.textContent   = message;
  banner.style.display = 'block';
}

// ---------------------------------------------------------------------------
// History initialisation
// ---------------------------------------------------------------------------

/**
 * Fetches assessment history on dashboard init.
 * On success: renders the table.
 * On failure: shows any session-cached items and displays warning banner.
 */
async function initHistory() {
  try {
    const data = await api.get('/assessments', { limit: 50 });
    const items = data?.items ?? [];
    // Merge session cache into items if any exist (shouldn't overlap, but
    // if the page was navigated without a full reload the cache may be populated)
    _sessionCache = items;
    HistoryTable.render(items);
  } catch (err) {
    console.warn('[GeoSentinel] Failed to load assessment history:', err.message);
    // Show whatever was accumulated in the session cache this page load
    HistoryTable.render(_sessionCache);
    showWarningBanner(
      'Assessment history could not be loaded from the server. ' +
      'Showing locally cached results from this session.'
    );
  }
}

// ---------------------------------------------------------------------------
// Form submission handler
// ---------------------------------------------------------------------------

/**
 * Handles the assessment form submit event.
 * @param {SubmitEvent} e
 */
async function handleFormSubmit(e) {
  e.preventDefault();

  const { valid, body } = validateForm();
  if (!valid) return;  // errors already displayed inline

  clearValidationErrors();
  setButtonLoading();

  try {
    const result = await api.post('/assessments', body);

    // Render all result panels
    renderResult(result, true);

    // Add to history table (top) and session cache
    HistoryTable.prepend(result);
    _sessionCache.unshift(result);
    if (_sessionCache.length > 50) _sessionCache = _sessionCache.slice(0, 50);

    // Show save warning if DynamoDB write failed but computation succeeded
    if (result.save_warning) {
      showToast(
        'Assessment computed successfully, but could not be saved to history. ' +
        result.save_warning,
        'warning',
        8000
      );
    }

  } catch (err) {
    // If the API returned a 400 with field-level errors, show them inline
    if (err.status === 400 && err.fields) {
      Object.entries(err.fields).forEach(([apiKey, msg]) => {
        const spec    = FIELD_SPECS.find((s) => s.apiKey === apiKey);
        if (!spec) return;
        const input   = el(spec.id);
        const errorEl = el(spec.errorId);
        if (input)   input.classList.add('error');
        if (errorEl) errorEl.textContent = msg;
      });
    } else {
      // Generic user-safe toast — no internals exposed
      showToast(err.message ?? 'An unexpected error occurred. Please try again.', 'error');
    }
  } finally {
    setButtonReady();
  }
}

// ---------------------------------------------------------------------------
// assessment:selected event handler (from HistoryTable row click)
// ---------------------------------------------------------------------------

/**
 * Reloads all result panels when the user selects a history row.
 * @param {CustomEvent} e
 */
function handleAssessmentSelected(e) {
  const assessment = e.detail;
  if (!assessment) return;
  renderResult(assessment, true);
  // Scroll to the results column on mobile
  const gaugePanel = el('gauge-panel');
  if (gaugePanel) {
    gaugePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ---------------------------------------------------------------------------
// report:error event handler (from ReportGenerator)
// ---------------------------------------------------------------------------

function handleReportError() {
  showToast('Could not generate report. Please try again.', 'error');
}

// ---------------------------------------------------------------------------
// Real-time field validation (clear error on user input)
// ---------------------------------------------------------------------------

/**
 * Attaches an input/change listener to each field that clears its own error
 * as soon as the user starts correcting it.
 */
function attachFieldClearListeners() {
  FIELD_SPECS.forEach((spec) => {
    const input   = el(spec.id);
    const errorEl = el(spec.errorId);
    if (!input) return;

    const eventType = spec.type === 'select' ? 'change' : 'input';
    input.addEventListener(eventType, () => {
      if (input.classList.contains('error')) {
        input.classList.remove('error');
        if (errorEl) errorEl.textContent = '';
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  // Wire form submission
  const form = el('assessment-form');
  if (form) form.addEventListener('submit', handleFormSubmit);

  // Wire real-time field error clearing
  attachFieldClearListeners();

  // Wire custom events
  document.addEventListener('assessment:selected', handleAssessmentSelected);
  document.addEventListener('report:error',        handleReportError);

  // Load history (non-blocking — failures are handled gracefully inside)
  initHistory();
});

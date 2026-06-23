/**
 * api.js — GeoSentinel Browser-Local Mock API
 *
 * Replaces HTTP fetch() calls with a fully in-browser implementation.
 * The assessment engine runs the same weighted scoring algorithm defined
 * in design.md. Assessment records are persisted in localStorage so history
 * survives page reloads.
 *
 * Public interface (unchanged — app.js requires no modifications):
 *   api.post(path, body)      → Promise<Object>
 *   api.get(path, params?)    → Promise<Object>
 *   export class ApiError
 *
 * Supported routes:
 *   POST /assessments          → run assessment, persist, return full record
 *   GET  /assessments          → return stored records (newest-first, limit=50)
 *   GET  /assessments/:id      → return single record by id
 */

// ---------------------------------------------------------------------------
// ApiError  (kept identical — app.js imports this class)
// ---------------------------------------------------------------------------

/**
 * Normalised error thrown by all api.* methods.
 * @property {number}      status
 * @property {string}      message
 * @property {Object|null} fields
 * @property {string}      code
 */
export class ApiError extends Error {
  constructor(message, status = 0, fields = null, code = 'UnknownError') {
    super(message);
    this.name   = 'ApiError';
    this.status = status;
    this.fields = fields;
    this.code   = code;
  }
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------

const LS_KEY = 'geosentinel_assessments';

/** @returns {Array<Object>} */
function loadRecords() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** @param {Array<Object>} records */
function saveRecords(records) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(records));
  } catch {
    // Storage quota exceeded — silently ignore; the result is still returned
  }
}

/** Generates a sortable pseudo-ULID (timestamp prefix + random suffix). */
function generateId() {
  const ts   = Date.now().toString(36).toUpperCase().padStart(10, '0');
  const rand = Math.random().toString(36).substring(2, 14).toUpperCase().padEnd(12, '0');
  return `${ts}${rand}`.substring(0, 26);
}

// ---------------------------------------------------------------------------
// Assessment Engine  (mirrors assessment_engine.py from design.md exactly)
// ---------------------------------------------------------------------------

// ── Parameter weights (sum = 1.0) ──────────────────────────────────────────
const WEIGHTS = {
  slope_angle:          0.25,
  rainfall_intensity:   0.20,
  soil_type:            0.18,
  drainage_condition:   0.15,
  fault_zone_proximity: 0.10,
  vegetation_cover:     0.07,
  land_use_type:        0.05,
};

// ── Categorical lookup tables ──────────────────────────────────────────────
const SOIL_SCORES = {
  Clay: 1.00, Silt: 0.75, Loam: 0.50, Sandy: 0.35, Rocky: 0.10,
};

const LAND_USE_SCORES = {
  Urban: 1.00, Bare_Ground: 0.80, Agricultural: 0.40, Forest: 0.10,
};

const DRAINAGE_SCORES = {
  Poor: 1.00, Moderate: 0.50, Good: 0.10,
};

/**
 * Normalises each input parameter to a [0, 1] risk sub-score.
 * Returns an object keyed by parameter name.
 *
 * @param {Object} p — validated input parameters
 * @returns {Record<string, number>}
 */
function normalise(p) {
  return {
    slope_angle:          p.slope_angle / 90.0,
    rainfall_intensity:   Math.min(p.rainfall_intensity / 150.0, 1.0),
    soil_type:            SOIL_SCORES[p.soil_type] ?? 0.5,
    vegetation_cover:     1.0 - (p.vegetation_cover / 100.0),      // inverted
    fault_zone_proximity: Math.max(0.0, 1.0 - (p.fault_zone_proximity / 50.0)),
    land_use_type:        LAND_USE_SCORES[p.land_use_type] ?? 0.5,
    drainage_condition:   DRAINAGE_SCORES[p.drainage_condition] ?? 0.5,
  };
}

/**
 * Computes the weighted hazard score from normalised sub-scores.
 * @param {Record<string, number>} subs
 * @returns {number}  — [0, 100] rounded to 1 decimal place
 */
function computeScore(subs) {
  const raw = Object.entries(WEIGHTS).reduce(
    (sum, [key, w]) => sum + (subs[key] ?? 0) * w, 0
  );
  return Math.round(raw * 1000) / 10;  // round to 1 dp
}

/**
 * Maps a hazard score to a risk category.
 * @param {number} score
 * @returns {'Low'|'Moderate'|'High'|'Critical'}
 */
function classifyRisk(score) {
  if (score >= 75) return 'Critical';
  if (score >= 50) return 'High';
  if (score >= 25) return 'Moderate';
  return 'Low';
}

// ── Factor notes — one sentence per parameter per direction ────────────────

/** @type {Record<string, { increasing: string, reducing: string, neutral: string }>} */
const FACTOR_NOTES = {
  slope_angle: {
    increasing: 'Steep slope significantly elevates gravitational stress on slope material.',
    neutral:    'Moderate slope angle contributes a baseline level of gravitational stress.',
    reducing:   'Gentle slope angle minimises gravitational driving forces on the slope.',
  },
  rainfall_intensity: {
    increasing: 'High rainfall intensity increases pore-water pressure, reducing effective soil strength.',
    neutral:    'Moderate rainfall may intermittently elevate pore pressure.',
    reducing:   'Low rainfall intensity limits pore-water pressure build-up.',
  },
  soil_type: {
    increasing: `${0}-type soil has low cohesion when saturated, greatly increasing failure potential.`,
    neutral:    'Loam soil has moderate cohesion; behaviour is sensitive to saturation level.',
    reducing:   'Soil type provides relatively high cohesion and resistance to shear failure.',
  },
  vegetation_cover: {
    increasing: 'Low vegetation cover provides minimal root reinforcement and allows high surface runoff.',
    neutral:    'Partial vegetation cover offers some root reinforcement and runoff interception.',
    reducing:   'High vegetation cover provides significant root reinforcement and reduces runoff.',
  },
  fault_zone_proximity: {
    increasing: 'Close proximity to a fault zone pre-conditions slopes through seismic shaking and rock fracturing.',
    neutral:    'Moderate fault distance contributes some seismic pre-conditioning influence.',
    reducing:   'Large distance from fault zones minimises seismic pre-conditioning.',
  },
  land_use_type: {
    increasing: 'Land use adds significant surface loading and reduces natural slope protection.',
    neutral:    'Land use has a moderate effect on slope loading and surface runoff.',
    reducing:   'Land use type provides natural ground cover that stabilises surface soils.',
  },
  drainage_condition: {
    increasing: 'Poor drainage concentrates water at the slope base, amplifying pore-water pressure.',
    neutral:    'Moderate drainage partially mitigates rainfall-driven saturation.',
    reducing:   'Good drainage effectively dissipates pore-water pressure build-up.',
  },
};

/**
 * Generates a per-parameter factor explanation from the normalised sub-scores.
 *
 * Direction thresholds (from design.md):
 *   sub_score > 0.6  → increasing  (▲)
 *   sub_score < 0.4  → reducing    (▼)
 *   otherwise        → neutral     (→)
 *
 * @param {Object} params — raw input params
 * @param {Record<string, number>} subs — normalised sub-scores
 * @returns {Array<{ parameter: string, direction: string, note: string }>}
 */
function buildExplanation(params, subs) {
  const paramNames = {
    slope_angle:          'Slope_Angle',
    rainfall_intensity:   'Rainfall_Intensity',
    soil_type:            'Soil_Type',
    vegetation_cover:     'Vegetation_Cover',
    fault_zone_proximity: 'Fault_Zone_Proximity',
    land_use_type:        'Land_Use_Type',
    drainage_condition:   'Drainage_Condition',
  };

  return Object.keys(WEIGHTS).map((key) => {
    const sub  = subs[key];
    const dir  = sub > 0.6 ? 'increasing' : sub < 0.4 ? 'reducing' : 'neutral';
    const notes = FACTOR_NOTES[key] ?? {};
    let note = notes[dir] ?? '';

    // Personalise soil_type and land_use_type notes with actual value
    if (key === 'soil_type' && dir === 'increasing') {
      note = `${params.soil_type} soil has low cohesion when saturated, greatly increasing failure potential.`;
    }
    if (key === 'land_use_type' && dir === 'increasing') {
      const label = (params.land_use_type ?? '').replace(/_/g, ' ');
      note = `${label} land use adds significant surface loading and reduces natural slope protection.`;
    }
    if (key === 'land_use_type' && dir === 'neutral') {
      const label = (params.land_use_type ?? '').replace(/_/g, ' ');
      note = `${label} land use has a moderate effect on slope loading and surface runoff.`;
    }

    return { parameter: paramNames[key], direction: dir, note };
  });
}

/**
 * Builds the plain-language summary sentence.
 * @param {number} score
 * @param {string} category
 * @param {Array}  explanation
 * @returns {string}
 */
function buildSummary(score, category, explanation) {
  const increasing = explanation.filter((f) => f.direction === 'increasing').length;
  const reducing   = explanation.filter((f) => f.direction === 'reducing').length;
  return (
    `The site presents ${category} landslide susceptibility (score: ${score}/100). ` +
    `${increasing} factor(s) are contributing to elevated risk and ` +
    `${reducing} factor(s) are providing stabilising influence.`
  );
}

/**
 * Generates mitigation recommendations from the rule set in design.md.
 * At least one recommendation is always returned (fallback rule).
 *
 * @param {Object} params
 * @param {string} category
 * @returns {Array<string>}
 */
function buildRecommendations(params, category) {
  const recs = [];

  if (params.drainage_condition === 'Poor') {
    recs.push('Improve drainage systems');
  }
  if (params.vegetation_cover < 30) {
    recs.push('Increase vegetation cover');
  }
  if (category === 'High' || category === 'Critical') {
    recs.push('Conduct geotechnical surveys');
  }
  if (params.slope_angle > 35 && (category === 'High' || category === 'Critical')) {
    recs.push('Install retaining structures');
  }
  if (category === 'Critical') {
    recs.push('Restrict construction in vulnerable areas');
  }
  if (recs.length === 0) {
    recs.push('Continue routine site monitoring');
  }

  return recs;
}

/**
 * Runs the full assessment pipeline in the browser.
 * Returns a record shaped identically to the Lambda API response.
 *
 * @param {Object} params — validated 7-parameter input object
 * @returns {Object}      — full assessment record
 */
function runAssessment(params) {
  const subs         = normalise(params);
  const hazardScore  = computeScore(subs);
  const riskCategory = classifyRisk(hazardScore);
  const explanation  = buildExplanation(params, subs);
  const summary      = buildSummary(hazardScore, riskCategory, explanation);
  const recommendations = buildRecommendations(params, riskCategory);
  const assessmentId = generateId();
  const createdAt    = new Date().toISOString();

  return {
    assessment_id:       assessmentId,
    created_at:          createdAt,
    // Input parameters (camelCase mirror stored; snake_case for API shape)
    slope_angle:          params.slope_angle,
    rainfall_intensity:   params.rainfall_intensity,
    soil_type:            params.soil_type,
    vegetation_cover:     params.vegetation_cover,
    fault_zone_proximity: params.fault_zone_proximity,
    land_use_type:        params.land_use_type,
    drainage_condition:   params.drainage_condition,
    // Outputs
    hazard_score:         hazardScore,
    risk_category:        riskCategory,
    risk_explanation:     explanation,
    summary,
    recommendations,
    save_warning:         null,
  };
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * POST /assessments
 * Runs the assessment engine, persists the record, returns it.
 *
 * @param {Object} body
 * @returns {Object}
 */
function handlePostAssessments(body) {
  const record  = runAssessment(body);
  const records = loadRecords();
  records.unshift(record);                          // newest first
  if (records.length > 200) records.length = 200;  // cap storage
  saveRecords(records);
  return record;
}

/**
 * GET /assessments
 * Returns stored records newest-first, capped by limit param.
 *
 * @param {Object} params  — query params, e.g. { limit: '50' }
 * @returns {{ items: Array, count: number }}
 */
function handleGetAssessments(params) {
  const limit   = Math.min(parseInt(params?.limit ?? '50', 10) || 50, 100);
  const records = loadRecords().slice(0, limit);
  return { items: records, count: records.length };
}

/**
 * GET /assessments/:id
 * Returns a single record or throws 404.
 *
 * @param {string} id
 * @returns {Object}
 */
function handleGetAssessmentById(id) {
  const record = loadRecords().find((r) => r.assessment_id === id);
  if (!record) {
    throw new ApiError(
      `Assessment with id '${id}' was not found.`,
      404, null, 'NotFound'
    );
  }
  return record;
}

// ---------------------------------------------------------------------------
// Router  — parses path strings and dispatches to handlers
// ---------------------------------------------------------------------------

// Match /assessments/{id}
const RE_ASSESSMENT_ID = /^\/assessments\/([^/]+)$/;

/**
 * Routes a method + path to the correct handler.
 * Simulates a ~120 ms network round-trip to make the loading spinner visible.
 *
 * @param {string} method   'POST' | 'GET'
 * @param {string} path     e.g. '/assessments'
 * @param {Object} body     request body (POST only)
 * @param {Object} params   query params (GET only)
 * @returns {Promise<Object>}
 */
async function route(method, path, body, params) {
  // Simulate realistic async latency (80–180 ms)
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 100));

  if (method === 'POST' && path === '/assessments') {
    return handlePostAssessments(body);
  }

  if (method === 'GET' && path === '/assessments') {
    return handleGetAssessments(params);
  }

  const idMatch = path.match(RE_ASSESSMENT_ID);
  if (method === 'GET' && idMatch) {
    return handleGetAssessmentById(idMatch[1]);
  }

  throw new ApiError(
    `Route not found: ${method} ${path}`,
    404, null, 'NotFound'
  );
}

// ---------------------------------------------------------------------------
// Public API  (identical signatures to the original fetch-based version)
// ---------------------------------------------------------------------------

/**
 * Simulates POST request — runs the assessment engine and persists the record.
 *
 * @param {string} path   e.g. '/assessments'
 * @param {Object} body
 * @returns {Promise<Object>}
 * @throws {ApiError}
 */
async function post(path, body) {
  return route('POST', path, body, null);
}

/**
 * Simulates GET request — retrieves stored assessments.
 *
 * @param {string} path     e.g. '/assessments'
 * @param {Object} [params] e.g. { limit: 50 }
 * @returns {Promise<Object>}
 * @throws {ApiError}
 */
async function get(path, params) {
  return route('GET', path, null, params);
}

// ---------------------------------------------------------------------------
// Default export  (unchanged interface)
// ---------------------------------------------------------------------------

const api = { post, get };
export default api;

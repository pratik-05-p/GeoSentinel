# Design Document — GeoSentinel

## Overview

GeoSentinel is a fully serverless web application for preliminary landslide risk assessment. Users enter seven geological and environmental parameters; the system computes a hazard score (0–100), assigns a risk category (Low / Moderate / High / Critical), generates a factor-level explanation, and produces actionable mitigation recommendations. All assessments are persisted for later review and can be downloaded as a PDF report.

The platform is deployed entirely on AWS: static assets are served from S3 via CloudFront, a REST API on API Gateway proxies requests to a single Lambda function, and assessment records are stored in DynamoDB. No servers are managed; all components scale automatically.

**Design Goals**

- Zero server management — fully serverless, pay-per-use
- Sub-3-second end-to-end assessment response
- Premium dark-themed SPA UI with animated risk gauge and glassmorphism styling
- Client-side PDF report generation (no backend round-trip)
- Structured CloudWatch logging for every assessment request

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                           │
│   Landing Page (index.html)  +  Dashboard SPA (dashboard.html)      │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTPS
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│               Amazon CloudFront (CDN + HTTPS termination)           │
│   Origin 1: S3 Static Website (/* paths)                            │
│   Origin 2: API Gateway (/api/* paths)                              │
└──────────────┬──────────────────────────────┬───────────────────────┘
               │ S3 fetch                      │ API proxy
               ▼                              ▼
┌─────────────────────────┐    ┌──────────────────────────────────────┐
│  Amazon S3              │    │  Amazon API Gateway (REST, HTTPS)    │
│  Static Website Hosting │    │  POST /assessments                   │
│  index.html             │    │  GET  /assessments                   │
│  dashboard.html         │    │  GET  /assessments/{id}              │
│  app.js / styles.css    │    │  Throttle: 500 burst / 200 steady    │
└─────────────────────────┘    └─────────────────┬────────────────────┘
                                                  │ Lambda proxy
                                                  ▼
                               ┌──────────────────────────────────────┐
                               │  AWS Lambda — geosentinel-api        │
                               │  Python 3.12 | 512 MB | 10 s timeout │
                               │  router | validator | engine | db    │
                               └─────────────────┬────────────────────┘
                                                  │ DynamoDB SDK
                                                  ▼
                               ┌──────────────────────────────────────┐
                               │  Amazon DynamoDB                     │
                               │  GeoSentinelAssessments table        │
                               │  PK: assessmentId (ULID)             │
                               │  GSI: CreatedAt-index                │
                               └──────────────────────────────────────┘
                                        Logs ──► Amazon CloudWatch
```

### Data Flow — Submit Assessment

```
Browser
  1. POST /api/v1/assessments { 7 input parameters }
  2. API Gateway: throttle check → Lambda proxy invocation
  3. Lambda::validator: schema validation → 400 on failure
  4. Lambda::assessment_engine:
       compute_score()         → hazard_score [0-100]
       classify_risk()         → risk_category
       build_explanation()     → risk_explanation[]
       build_recommendations() → recommendations[]
  5. Lambda::db_client: DynamoDB PutItem
  6. Lambda: 201 response { assessmentId, score, category, explanation, recommendations }
  7. Dashboard: renders gauge animation, badge, analysis card, recommendations panel
```

### Data Flow — Load History

```
Browser (on Dashboard init)
  1. GET /api/v1/assessments?limit=50
  2. Lambda::db_client: DynamoDB Query on CreatedAt-index (ScanIndexForward=False)
  3. Lambda: 200 { items: [...], count: N }
  4. Dashboard: renders Assessment_History table
```

---

## Components and Interfaces

### Frontend Components

**`index.html` — Landing Page**
- Hero section with tagline and CTA button linking to `dashboard.html`
- Feature cards describing the 7 input parameters and 4 output types
- Dark Navy background (#0F172A), Cyan accent (#06B6D4)

**`dashboard.html` — Main SPA**
- Layout: two-column on desktop (≥768 px), single-column stacked on mobile
- Left column: 7-field input form + Analyze button
- Right column: Risk Score Gauge, Risk Category Badge, Hazard Analysis Card, Recommendations Panel, Download PDF button
- Bottom: Assessment History Table (50 records max, newest first)

**`gauge.js` — SVG Arc Gauge**
- Renders a semicircular SVG arc representing [0, 100]
- Animates from 0 to `hazard_score` over 800–1200 ms using `requestAnimationFrame`
- Arc colour driven by `risk_category` design token
- Interface: `GaugeRenderer.render(score, category)` | `GaugeRenderer.reset()`

**`api.js` — HTTP Client**
- Wraps `fetch()` with base URL, JSON serialisation, and error normalisation
- 30-second request timeout via `AbortController`
- Interface: `api.post(path, body)` | `api.get(path, params)` → Promise<Response>

**`report.js` — PDF Generator**
- Uses jsPDF (CDN) to generate a PDF client-side
- Sections: Header (GeoSentinel logo text + timestamp), Inputs table, Score + Category, Explanation list, Recommendations list, Disclaimer footer
- Interface: `ReportGenerator.download(assessment)` → triggers browser file download

**`history.js` — History Table**
- Renders `<tbody>` rows from assessment list
- Emits `assessment:selected` custom event on row click
- Interface: `HistoryTable.render(items)` | `HistoryTable.prepend(item)`

**`app.js` — Dashboard Controller**
- Orchestrates all component interactions
- On init: calls `api.get('/assessments')`, passes result to `HistoryTable.render()`
- On form submit: validates, calls `api.post('/assessments', body)`, updates all result components
- Listens for `assessment:selected` to reload historical results

### Backend Modules (Lambda — Python 3.12)

**`handler.py`**
- Entry point: `lambda_handler(event, context)`
- Calls `router.route(event)`, wraps unhandled exceptions with structured error response
- Emits start/end log entries with `assessmentId`, `riskCategory`, `durationMs`

**`router.py`**
- `route(event)` → dispatches by `httpMethod` + `resource` to handler function
- Returns 405 for unrecognised method/resource combinations

**`validator.py`**
- `validate_input(body: dict)` → `InputParameters` dataclass | raises `ValidationError`
- Validates all 7 fields: range checks for numerics, enum membership for categoricals
- Returns structured `fields` error map on failure (used in 400 response)

**`assessment_engine.py`**
- `compute_score(params: InputParameters) → float`
  - Normalises each parameter to [0, 1] sub-score using documented functions
  - Returns weighted sum × 100, rounded to 1 decimal place
- `classify_risk(score: float) → str` — threshold lookup
- `build_explanation(params, score) → list[FactorExplanation]`
  - For each parameter: computes sub-score, compares to 0.4/0.6 thresholds, assigns direction
  - Generates summary string from template
- `build_recommendations(params, category) → list[str]` — rule-based conditional logic

**`db_client.py`**
- `put_assessment(record: dict) → str` — DynamoDB PutItem, returns `assessmentId`
- `get_assessment(assessment_id: str) → dict | None` — DynamoDB GetItem
- `list_assessments(limit: int = 50) → list[dict]` — DynamoDB Query on GSI

**`logger.py`**
- Thin wrapper over Python `logging`, outputs JSON to stdout (CloudWatch)
- Fields: `timestamp`, `level`, `assessmentId`, `message`, `riskCategory`, `durationMs`

### API Interface

| Method | Path | Purpose | Auth |
|---|---|---|---|
| POST | `/api/v1/assessments` | Submit new assessment | None (open) |
| GET | `/api/v1/assessments` | List assessments (limit=50) | None (open) |
| GET | `/api/v1/assessments/{id}` | Get single assessment detail | None (open) |

**POST /api/v1/assessments — Request Body**

```json
{
  "slope_angle":           45.0,
  "rainfall_intensity":    80.0,
  "soil_type":             "Clay",
  "vegetation_cover":      20.0,
  "fault_zone_proximity":  2.5,
  "land_use_type":         "Urban",
  "drainage_condition":    "Poor"
}
```

**POST /api/v1/assessments — 201 Response**

```json
{
  "assessment_id":    "01HZ1234ABCDEFGHIJKLMNOP",
  "hazard_score":     72.4,
  "risk_category":    "High",
  "risk_explanation": [
    { "parameter": "Slope_Angle",          "direction": "increasing", "note": "Steep slope (45°) significantly elevates instability." },
    { "parameter": "Rainfall_Intensity",   "direction": "increasing", "note": "High rainfall (80 mm/h) increases pore pressure." },
    { "parameter": "Soil_Type",            "direction": "increasing", "note": "Clay soil has low cohesion when saturated." },
    { "parameter": "Vegetation_Cover",     "direction": "increasing", "note": "Low vegetation (20%) provides minimal root reinforcement." },
    { "parameter": "Fault_Zone_Proximity", "direction": "neutral",    "note": "Distance (2.5 km) has moderate seismic influence." },
    { "parameter": "Land_Use_Type",        "direction": "increasing", "note": "Urban land use adds surcharge loading." },
    { "parameter": "Drainage_Condition",   "direction": "increasing", "note": "Poor drainage amplifies rainfall-driven instability." }
  ],
  "summary":          "The site presents High landslide susceptibility (score: 72.4/100). 6 factor(s) are contributing to elevated risk and 0 factor(s) are providing stabilising influence.",
  "recommendations":  ["Improve drainage systems", "Increase vegetation cover", "Conduct geotechnical surveys", "Install retaining structures"],
  "created_at":       "2026-06-23T10:30:00Z",
  "save_warning":     null
}
```

**Error Responses**

| Status | `error` field | Trigger |
|---|---|---|
| 400 | `ValidationError` | Missing / out-of-range / invalid enum field |
| 404 | `NotFound` | `GET /assessments/{id}` with unknown id |
| 429 | `ThrottlingError` | API Gateway burst/steady-state limit exceeded |
| 500 | `InternalError` | Unhandled Lambda exception |

---

## Data Models

### DynamoDB Table: GeoSentinelAssessments

**Key Design**

| Attribute | Type | Role |
|---|---|---|
| `assessmentId` | String (ULID) | Table Partition Key |
| `createdAt` | String (ISO 8601) | GSI Sort Key |
| `gsiPk` | String (static `"ASSESSMENT"`) | GSI Partition Key |

ULIDs are used as primary keys because they are lexicographically sortable by creation time and universally unique, enabling efficient time-ordered queries.

**Full DynamoDB Item**

```json
{
  "assessmentId":       "01HZ1234ABCDEFGHIJKLMNOP",
  "gsiPk":              "ASSESSMENT",
  "createdAt":          "2026-06-23T10:30:00.000Z",
  "slopeAngle":         45.0,
  "rainfallIntensity":  80.0,
  "soilType":           "Clay",
  "vegetationCover":    20.0,
  "faultZoneProximity": 2.5,
  "landUseType":        "Urban",
  "drainageCondition":  "Poor",
  "hazardScore":        72.4,
  "riskCategory":       "High",
  "riskExplanation":    [ { "parameter": "Slope_Angle", "direction": "increasing", "note": "..." } ],
  "summary":            "The site presents High...",
  "recommendations":    ["Improve drainage systems", "Conduct geotechnical surveys"]
}
```

**Global Secondary Index: CreatedAt-index**

| Attribute | Role |
|---|---|
| `gsiPk` (value: `"ASSESSMENT"`) | GSI Partition Key |
| `createdAt` | GSI Sort Key (descending queries) |

**DynamoDB Settings**

| Setting | Value |
|---|---|
| Billing mode | PAY_PER_REQUEST (on-demand) |
| Encryption | AWS-managed SSE (default) |
| Point-in-time recovery | Enabled |
| TTL | Not enabled |

### Assessment Score Model

**Parameter Normalisation Functions**

| Parameter | Formula | Notes |
|---|---|---|
| `slope_angle` | `value / 90.0` | Linear |
| `rainfall_intensity` | `min(value / 150.0, 1.0)` | Caps at 150 mm/h |
| `soil_type` | Clay=1.0, Silt=0.75, Loam=0.5, Sandy=0.35, Rocky=0.1 | Lookup table |
| `vegetation_cover` | `1.0 - (value / 100.0)` | Inverted — higher cover = lower risk |
| `fault_zone_proximity` | `max(0.0, 1.0 - (value / 50.0))` | Caps to 0 beyond 50 km |
| `land_use_type` | Urban=1.0, Bare_Ground=0.8, Agricultural=0.4, Forest=0.1 | Lookup table |
| `drainage_condition` | Poor=1.0, Moderate=0.5, Good=0.1 | Lookup table |

**Parameter Weights**

| Parameter | Weight |
|---|---|
| slope_angle | 0.25 |
| rainfall_intensity | 0.20 |
| soil_type | 0.18 |
| drainage_condition | 0.15 |
| fault_zone_proximity | 0.10 |
| vegetation_cover | 0.07 |
| land_use_type | 0.05 |
| **Total** | **1.00** |

`hazard_score = round(weighted_sum * 100, 1)`

---

## Correctness Properties

### Property 1: Score Bounds
`compute_score()` can only return values in [0.0, 100.0] given valid normalised sub-scores each in [0.0, 1.0] and weights summing to 1.0. Any out-of-range result is a computation error and must not be persisted.

**Validates: Requirements 2.1, 2.2, 2.5**

### Property 2: High-Risk Factor Floor
Any input set containing at least one of {Slope_Angle > 45°, Rainfall_Intensity > 100 mm/h, Soil_Type = Clay, Drainage_Condition = Poor, Fault_Zone_Proximity < 1 km} has at least one sub-score > 0, producing a Hazard_Score > 0.

**Validates: Requirements 2.6**

### Property 3: Category Completeness
The thresholds [0,24], [25,49], [50,74], [75,100] are exhaustive and mutually exclusive for all integer and floating-point scores in [0,100].

**Validates: Requirements 2.4**

### Property 4: Recommendation Coverage
At least one recommendation always fires because the fallback "Continue routine site monitoring" is appended when no conditional rule matches.

**Validates: Requirements 4.1**

### Property 5: ULID Uniqueness
ULIDs are 128-bit pseudo-random values with millisecond timestamp prefix; collision probability is negligible for this application's expected throughput.

**Validates: Requirements 5.2**

---

## Error Handling

### Frontend

| Scenario | Behaviour |
|---|---|
| Form field invalid | Inline validation message adjacent to field; form blocked from submission |
| API call fails (4xx/5xx/timeout) | Loading indicator dismissed; re-enable submit button; user-facing error toast (no internal details exposed) |
| History load fails on init | Show any session-cached history; display non-blocking warning banner |
| PDF generation fails | Toast error: "Could not generate report. Please try again." |

### Backend (Lambda)

| Scenario | Behaviour |
|---|---|
| Schema validation failure | Return 400 with `ValidationError` and per-field messages; do not persist |
| Computation error (score out of bounds) | Return 500 with `InternalError`; log full exception; do not persist |
| DynamoDB write failure | Return 201 with computed result + `save_warning` field set; log warning |
| DynamoDB read failure (history) | Return 500; log exception |
| Unhandled exception | `handler.py` catch-all returns 500 `InternalError`; logs exception type, message, and stack trace to CloudWatch |

### API Gateway

| Scenario | Behaviour |
|---|---|
| Throttle limit exceeded | 429 response with `ThrottlingError` |
| HTTP (non-HTTPS) request | 403 response |
| Payload too large (>1 MB) | 413 response |

---

## Testing Strategy

### Unit Tests (Lambda — pytest)

- `test_validator.py`: boundary values for all 7 parameters (min, max, just-outside-range, invalid enum)
- `test_assessment_engine.py`:
  - Monotonicity: worst-case inputs score higher than best-case inputs
  - Category boundaries: scores at 24, 25, 49, 50, 74, 75 map to correct categories
  - Recommendation rules: each conditional rule fires when its condition is met and not otherwise
  - Fallback recommendation fires when no rule matches
- `test_db_client.py`: mock DynamoDB responses for put/get/query (moto library)

### Integration Tests

- End-to-end POST → DynamoDB PutItem → GET `/assessments` returns the record
- GET `/assessments/{id}` returns full item matching POST response

### Frontend Tests (manual / browser)

- Form validation: each field's boundary error messages render correctly
- Gauge animation: transitions from 0 to score in 800–1200 ms
- PDF download: file is non-empty; contains score, category, disclaimer
- Responsive layout: no horizontal scroll at 320 px, 375 px, 768 px viewport widths
- History row click: reloads gauge, badge, analysis card, and recommendations panel

### Infrastructure

- CloudWatch log groups exist with 30-day retention
- API Gateway throttling: 429 returned after burst limit in load test
- CloudFront serves HTTPS; HTTP requests return 403

---

## Infrastructure & Deployment Reference

### AWS Resource Summary

| Resource | Name | Purpose |
|---|---|---|
| S3 Bucket | `geosentinel-frontend-{account}` | Static website assets |
| CloudFront Distribution | `geosentinel-cdn` | HTTPS CDN, SPA routing |
| API Gateway REST API | `geosentinel-api` | HTTP routing and throttling |
| Lambda Function | `geosentinel-api` | All backend logic |
| DynamoDB Table | `GeoSentinelAssessments` | Assessment persistence |
| IAM Role | `geosentinel-lambda-role` | Lambda execution permissions (least privilege) |
| CloudWatch Log Group | `/aws/lambda/geosentinel-api` | Lambda logs, 30-day retention |
| CloudWatch Log Group | `geosentinel-api-access-logs` | API Gateway access logs, 30-day retention |

### Lambda Environment Variables

| Variable | Value |
|---|---|
| `DYNAMODB_TABLE_NAME` | `GeoSentinelAssessments` |
| `CORS_ALLOWED_ORIGIN` | CloudFront distribution domain |
| `LOG_LEVEL` | `INFO` |

### Design Tokens (CSS)

```css
:root {
  --color-bg-primary:     #0F172A;  /* Deep Navy */
  --color-accent-cyan:    #06B6D4;  /* Cyan */
  --color-accent-emerald: #10B981;  /* Emerald */
  --color-risk-low:       #10B981;  /* green */
  --color-risk-moderate:  #F59E0B;  /* yellow */
  --color-risk-high:      #F97316;  /* orange */
  --color-risk-critical:  #EF4444;  /* red */
  --glass-bg:             rgba(255,255,255,0.05);
  --glass-border:         rgba(255,255,255,0.10);
  --glass-blur:           blur(12px);
}
```

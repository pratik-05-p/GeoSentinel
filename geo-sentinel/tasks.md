# Implementation Plan: GeoSentinel

## Overview

This plan breaks the GeoSentinel implementation into 5 sequential phases. Phases 1–2 establish the AWS serverless backend (S3, CloudFront, API Gateway, Lambda, DynamoDB, CloudWatch). Phases 3–4 build the frontend SPA (landing page, dashboard, gauge animation, PDF report). Phase 5 covers deployment, integration testing, and verification.

Each task is tagged with the requirements it satisfies. Tasks within a phase can generally run in parallel except where explicit dependencies are noted in the dependency graph below.

## Tasks

### Phase 1: AWS Infrastructure Setup

- [ ] 1. Create S3 bucket and enable static website hosting
  - Create bucket `geosentinel-frontend-{account-id}` with public access block disabled for website hosting
  - Enable static website hosting with `index.html` as index document and error document
  - Add bucket policy allowing CloudFront OAC (Origin Access Control) read access
  - **Implements:** Requirements 10.2, 11.4

- [ ] 2. Create DynamoDB table with GSI
  - Create table `GeoSentinelAssessments` with partition key `assessmentId` (String)
  - Add attribute `gsiPk` (String) and `createdAt` (String)
  - Create GSI `CreatedAt-index` with partition key `gsiPk` and sort key `createdAt`
  - Set billing mode to PAY_PER_REQUEST, enable point-in-time recovery, enable SSE
  - **Implements:** Requirements 5.1, 5.2, 6.1

- [ ] 3. Create IAM role for Lambda execution
  - Create role `geosentinel-lambda-role` with Lambda trust policy
  - Attach inline policy: `dynamodb:PutItem`, `dynamodb:GetItem`, `dynamodb:Query` on `GeoSentinelAssessments` and its GSI only
  - Attach `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents` on the Lambda log group ARN
  - **Implements:** Requirements 9.1 (least-privilege security)

- [ ] 4. Create Lambda function skeleton
  - Create function `geosentinel-api` with Python 3.12 runtime, 512 MB memory, 10-second timeout
  - Assign `geosentinel-lambda-role` as execution role
  - Set environment variables: `DYNAMODB_TABLE_NAME=GeoSentinelAssessments`, `LOG_LEVEL=INFO`
  - Upload placeholder `handler.py` that returns `{"statusCode": 200, "body": "ok"}`
  - **Implements:** Requirements 10.3

- [ ] 5. Create API Gateway REST API and configure routes
  - Create REST API `geosentinel-api` with Regional endpoint type
  - Create resource `/assessments` with methods POST and GET; Lambda proxy integration
  - Create resource `/assessments/{id}` with method GET; Lambda proxy integration
  - Enable CORS on all resources (OPTIONS method, headers: Content-Type)
  - Set throttling: burst limit 500, steady-state 200 on the default stage
  - Deploy to stage `v1`
  - **Implements:** Requirements 9.2, 9.4

- [ ] 6. Create CloudFront distribution
  - Create distribution with two origins: S3 bucket (OAC) for `/*` and API Gateway for `/api/*`
  - Enforce HTTPS-only viewer protocol policy; redirect HTTP to HTTPS
  - Set default root object to `index.html`
  - Add custom error response: 403/404 → `/index.html`, 200 status (SPA routing)
  - **Implements:** Requirements 9.2, 10.2, 11.4

- [ ] 7. Create CloudWatch Log Groups with retention policy
  - Create log group `/aws/lambda/geosentinel-api` with 30-day retention
  - Create log group `geosentinel-api-access-logs` with 30-day retention
  - Configure API Gateway stage to send access logs to `geosentinel-api-access-logs`
  - **Implements:** Requirements 12.1, 12.3, 12.4


### Phase 2: Backend Lambda Implementation

- [ ] 8. Implement `logger.py` — structured JSON CloudWatch logger
  - Create `backend/logger.py` wrapping Python `logging` module
  - Output JSON lines to stdout with fields: `timestamp`, `level`, `assessmentId`, `message`, `riskCategory`, `durationMs`
  - Respect `LOG_LEVEL` environment variable
  - **Implements:** Requirements 12.1, 12.2

- [ ] 9. Implement `validator.py` — input schema validation
  - Create `backend/validator.py` with `ValidationError` exception class and `fields` dict payload
  - Implement `validate_input(body: dict) -> InputParameters` dataclass
  - Validate `slope_angle`: float, range [0, 90]
  - Validate `rainfall_intensity`: float, range [0, 1000]
  - Validate `soil_type`: enum {Clay, Sandy, Loam, Rocky, Silt}
  - Validate `vegetation_cover`: float, range [0, 100]
  - Validate `fault_zone_proximity`: float, range [0, 500]
  - Validate `land_use_type`: enum {Forest, Agricultural, Urban, Bare_Ground}
  - Validate `drainage_condition`: enum {Good, Moderate, Poor}
  - Collect all field errors before raising; return structured `fields` map
  - **Implements:** Requirements 1.2–1.9, 9.3

- [ ] 10. Implement `assessment_engine.py` — scoring, explanation, recommendations
  - Create `backend/assessment_engine.py`
  - Implement `compute_score(params)`: normalise each parameter using lookup tables and formulas from design; apply weights (sum=1.0); return `round(weighted_sum * 100, 1)`; raise `ComputationError` if result outside [0, 100]
  - Implement `classify_risk(score)`: return Low/Moderate/High/Critical per threshold table
  - Implement `build_explanation(params, score)`: for each of 7 parameters compute sub-score, classify as increasing (>0.6) / reducing (<0.4) / neutral; generate summary string from template
  - Implement `build_recommendations(params, category)`: apply 5 conditional rules in order; append fallback "Continue routine site monitoring" if list empty
  - **Implements:** Requirements 2.1–2.7, 3.1–3.4, 4.1–4.6

- [ ] 11. Implement `db_client.py` — DynamoDB persistence and retrieval
  - Create `backend/db_client.py` using `boto3` DynamoDB resource
  - Implement `put_assessment(record: dict) -> str`: generate ULID as `assessmentId`, set `gsiPk="ASSESSMENT"`, call PutItem; return `assessmentId`
  - Implement `get_assessment(assessment_id: str) -> dict | None`: call GetItem; return item or None
  - Implement `list_assessments(limit: int = 50) -> list[dict]`: Query `CreatedAt-index` with `ScanIndexForward=False`, `Limit=limit`; return items list
  - **Implements:** Requirements 5.1–5.4, 6.1–6.5

- [ ] 12. Implement `router.py` and `handler.py` — Lambda entry point
  - Create `backend/router.py`: dispatch table keyed by `(httpMethod, resource)`; return 405 for unknown combinations
  - Create `backend/handler.py` with `lambda_handler(event, context)`:
    - Log request start (assessmentId placeholder, method, path)
    - Call `router.route(event)` to get handler function
    - Invoke handler; catch `ValidationError` → 400 response with fields map; catch all other exceptions → 500 response with `InternalError`
    - Log request end with `assessmentId`, `riskCategory`, `durationMs`
    - Add CORS headers to all responses
  - Implement `handle_create_assessment`: validate → compute → persist (catch DynamoDB error → add `save_warning`) → return 201
  - Implement `handle_list_assessments`: call `list_assessments(limit)` → return 200
  - Implement `handle_get_assessment`: call `get_assessment(id)` → return 200 or 404
  - **Implements:** Requirements 2.5, 2.7, 5.4, 12.1, 12.2

- [ ] 13. Write unit tests for backend modules
  - Create `backend/tests/test_validator.py`: test each field at min, max, just-outside-range, invalid enum, missing key
  - Create `backend/tests/test_assessment_engine.py`: test score monotonicity (worst > best inputs); test category boundaries at 24/25, 49/50, 74/75; test each recommendation rule fires and does not fire; test fallback recommendation
  - Create `backend/tests/test_db_client.py`: mock DynamoDB with `moto`; test PutItem sets ULID and gsiPk; test GetItem returns None for unknown id; test Query returns items in descending order
  - Run `pytest backend/tests/` and confirm all tests pass
  - **Implements:** Design Testing Strategy

- [ ] 14. Package and deploy Lambda; smoke-test with curl
  - Zip `backend/` directory (exclude `tests/`) and upload to Lambda function `geosentinel-api`
  - Test `POST /api/v1/assessments` with valid payload via curl; confirm 201 response with score and recommendations
  - Test `POST /api/v1/assessments` with invalid payload; confirm 400 with `fields` map
  - Test `GET /api/v1/assessments`; confirm history item appears
  - Test `GET /api/v1/assessments/{id}`; confirm full record returned
  - **Implements:** Requirements 1–6, 9, 12


### Phase 3: Frontend — Core Structure and Styling

- [x] 15. Create project file structure and CSS design tokens
  - Create `frontend/` directory with subdirectories `assets/css/` and `assets/js/`
  - Create `frontend/assets/css/styles.css` with CSS custom properties (design tokens) for all colour values: `--color-bg-primary: #0F172A`, `--color-accent-cyan: #06B6D4`, `--color-accent-emerald: #10B981`, risk colours, glassmorphism variables
  - Add base resets, dark background, font stack (system-ui / Inter), and utility classes for glassmorphism cards (`backdrop-filter: blur(12px)`, semi-transparent border)
  - **Implements:** Requirements 7.4

- [x] 16. Build `index.html` — professional landing page
  - Create `frontend/index.html` with dark Navy background and Cyan/Emerald accents
  - Hero section: GeoSentinel logo/name, tagline, brief description of the platform
  - Features section: grid of cards describing the 7 input parameters
  - Outputs section: cards for Score, Category, Explanation, Recommendations outputs
  - Prominent CTA button linking to `dashboard.html`
  - Responsive: single-column below 768 px, two-column above
  - **Implements:** Requirements 11.1–11.4

- [x] 17. Build `dashboard.html` — SPA structural layout
  - Create `frontend/dashboard.html` with two-column desktop grid (left: form, right: results)
  - Left column: assessment input form with all 7 fields, field labels with units, and "Analyze Risk" button
  - Right column placeholder panels: gauge container, badge container, hazard analysis card, recommendations panel, download PDF button (disabled until assessment loaded)
  - Bottom: assessment history table with columns: Timestamp, Slope (°), Rainfall (mm/h), Soil Type, Score, Category
  - Mobile: all sections stack vertically per design spec
  - Link Tailwind CSS CDN and `styles.css`; include `<script type="module">` tags for all JS modules
  - **Implements:** Requirements 1.1, 6.1–6.2, 7.4–7.5


### Phase 4: Frontend — JavaScript Modules

- [x] 18. Implement `api.js` — HTTP client with timeout and error normalisation
  - Create `frontend/assets/js/api.js`
  - Read `API_BASE_URL` from a config constant (set to CloudFront `/api/v1`)
  - Implement `api.post(path, body)`: JSON serialize body, set `Content-Type: application/json`, use `AbortController` with 30-second timeout, return parsed response JSON
  - Implement `api.get(path, params)`: append query string from params object, same timeout/error handling
  - On non-2xx response: parse error body and throw `ApiError` with `status`, `message`, and `fields` properties
  - On network/timeout error: throw `ApiError` with user-friendly message (no stack traces)
  - **Implements:** Requirements 1.10–1.11, 9.1

- [x] 19. Implement `gauge.js` — animated SVG arc gauge
  - Create `frontend/assets/js/gauge.js`
  - Render a 180° semicircular SVG arc inside a designated `<div id="gauge-container">`
  - Implement `GaugeRenderer.render(score, category)`: animate arc from 0 to `score` using `requestAnimationFrame`; duration randomly sampled in [800, 1000] ms; colour arc using risk category CSS token
  - Implement `GaugeRenderer.reset()`: snap arc to 0, remove score label, show placeholder text
  - Display numeric score value at centre of arc, updating during animation
  - **Implements:** Requirements 7.1–7.2, 7.6–7.7

- [x] 20. Implement `history.js` — assessment history table renderer
  - Create `frontend/assets/js/history.js`
  - Implement `HistoryTable.render(items)`: clear `<tbody>` and render up to 50 rows; each row shows timestamp (formatted), slope angle, rainfall intensity, soil type, hazard score, risk category badge; clicking a row dispatches `CustomEvent('assessment:selected', { detail: item })` on `document`
  - Implement `HistoryTable.prepend(item)`: insert new row at top; remove last row if count exceeds 50
  - Show "No previous assessments available." message row when `items` is empty
  - Apply risk category colour to the score/category cells using CSS token classes
  - **Implements:** Requirements 6.1–6.5

- [x] 21. Implement `report.js` — client-side PDF generation
  - Create `frontend/assets/js/report.js`; load jsPDF from CDN
  - Implement `ReportGenerator.download(assessment)`:
    - Page 1: GeoSentinel header, assessment timestamp, horizontal rule
    - Input Parameters section: two-column table of all 7 parameters with units
    - Risk Score section: bold score and colour-coded category label
    - Hazard Analysis section: list of all 7 factors with direction indicator (▲/▼/→) and note text
    - Recommendations section: numbered list of all recommendations
    - Footer on each page: disclaimer text ("This report represents a preliminary assessment and does not replace a professional geotechnical survey")
    - Trigger browser download as `GeoSentinel-Report-{assessmentId}.pdf`
  - If jsPDF throws, catch and dispatch `CustomEvent('report:error')` on `document`
  - **Implements:** Requirements 8.1–8.4

- [x] 22. Implement `app.js` — dashboard controller and form validation
  - Create `frontend/assets/js/app.js` as ES module
  - On DOMContentLoaded: call `api.get('/assessments')` and pass result to `HistoryTable.render()`; on failure show non-blocking warning banner and display any session-cached items
  - Implement client-side form validation matching `validator.py` rules (same ranges, same enums); display inline error messages adjacent to each invalid field; block submission until all valid
  - On valid form submit: disable button, show spinner, call `api.post('/assessments', body)`, then:
    - Call `GaugeRenderer.render(result.hazard_score, result.risk_category)`
    - Update risk category badge text and colour class
    - Render hazard analysis card with 7 factor rows (parameter name, direction icon, note)
    - Render recommendations panel items
    - Enable and show "Download PDF" button; attach `ReportGenerator.download(result)` to click handler
    - Call `HistoryTable.prepend(result)`
    - If `result.save_warning` is set, show non-blocking warning toast
  - On API error: dismiss spinner, re-enable button, show error toast (no internal details)
  - Listen for `assessment:selected` event: reload all result panels with historical record; re-animate gauge
  - Listen for `report:error` event: show "Could not generate report. Please try again." toast
  - **Implements:** Requirements 1.9–1.11, 3.3, 4.7, 6.3–6.5, 7.1–7.3, 7.6, 8.3–8.4


### Phase 5: Deployment and Verification

- [ ] 23. Upload frontend assets to S3 and invalidate CloudFront cache
  - Sync `frontend/` directory to S3 bucket with correct `Content-Type` headers (`.html → text/html`, `.js → application/javascript`, `.css → text/css`)
  - Set `Cache-Control: max-age=31536000` for JS/CSS assets; `no-cache` for HTML files
  - Create CloudFront invalidation for `/*` to flush stale cache
  - Verify landing page loads at CloudFront domain root URL over HTTPS
  - **Implements:** Requirements 10.2, 11.4

- [ ] 24. Set Lambda `CORS_ALLOWED_ORIGIN` to CloudFront domain and redeploy
  - Update Lambda environment variable `CORS_ALLOWED_ORIGIN` with the CloudFront distribution domain
  - Redeploy Lambda package
  - Verify `Access-Control-Allow-Origin` header in API responses matches CloudFront domain
  - **Implements:** Requirements 9.1

- [ ] 25. End-to-end integration test
  - Open dashboard in browser at CloudFront URL
  - Submit a valid assessment (slope=60°, rainfall=120, soil=Clay, vegetation=15, fault=0.5, landUse=Urban, drainage=Poor) and verify: score is in High/Critical range, gauge animates, all 7 factors listed with direction indicators, at least 3 recommendations shown
  - Submit form with invalid values (slope=100, rainfall=-5) and verify inline error messages appear
  - Click "Download PDF" and verify file downloads within 5 seconds and contains score, disclaimer
  - Reload page and verify history table shows the submitted assessment
  - Click history row and verify gauge and panels reload with that assessment's data
  - **Implements:** Requirements 1–8 end-to-end verification

- [ ] 26. Responsive layout verification
  - Test at 320 px viewport width: no horizontal scroll, all components stack vertically, gauge and badge visible
  - Test at 375 px (mobile): same checks
  - Test at 768 px (tablet breakpoint): verify transition to two-column layout
  - Test at 1440 px (desktop): full two-column layout with history table at bottom
  - **Implements:** Requirements 7.5

- [ ] 27. CloudWatch logging and monitoring verification
  - Submit an assessment and open CloudWatch Logs for `/aws/lambda/geosentinel-api`
  - Verify log entry contains `assessmentId`, `riskCategory`, and `durationMs` fields in JSON format
  - Check `geosentinel-api-access-logs` for an entry with method, path, status code, and latency
  - Verify both log groups show 30-day retention policy
  - **Implements:** Requirements 12.1–12.4

- [ ] 28. API throttling and security verification
  - Send an HTTP (not HTTPS) request to API Gateway directly and verify 403 response
  - Send a POST with a missing field (e.g., no `slope_angle`) and verify 400 with `ValidationError` and `fields` map
  - Confirm API Gateway default stage has burst limit 500 and rate limit 200 set
  - **Implements:** Requirements 9.2–9.4

- [ ] 29. Accessibility and polish pass
  - Add `aria-label` attributes to all form inputs, gauge SVG, and icon-only buttons
  - Ensure all interactive elements are keyboard-focusable and have visible focus rings
  - Verify colour contrast ratios for risk category colours against dark background (WCAG AA minimum 4.5:1 for text)
  - Add `lang="en"` to all HTML documents; add `<meta name="viewport" ...>` tag
  - **Implements:** Requirements 7.4–7.5 (accessibility baseline)


## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": [1, 2, 3, 15],
      "description": "Foundational AWS resources (S3, DynamoDB, IAM) and frontend CSS tokens — all independent, run in parallel"
    },
    {
      "wave": 2,
      "tasks": [4, 5, 6, 7, 16, 17],
      "description": "Lambda skeleton, API Gateway, CloudFront, CloudWatch log groups (depend on wave 1 resources); landing page and dashboard HTML (depend on CSS tokens)"
    },
    {
      "wave": 3,
      "tasks": [8, 9, 10, 11, 18, 19, 20, 21],
      "description": "Lambda modules (logger, validator, engine, db_client) and frontend JS modules (api, gauge, history, report) — can run in parallel"
    },
    {
      "wave": 4,
      "tasks": [12, 13, 22],
      "description": "Lambda handler/router (depends on all modules), unit tests (depends on modules), app.js controller (depends on all JS modules)"
    },
    {
      "wave": 5,
      "tasks": [14, 23, 24],
      "description": "Deploy Lambda package, upload frontend to S3, set CloudFront CORS origin"
    },
    {
      "wave": 6,
      "tasks": [25, 26, 27, 28, 29],
      "description": "End-to-end integration tests, responsive layout checks, CloudWatch verification, security checks, accessibility pass"
    }
  ],
  "dependencies": {
    "4":  ["3"],
    "5":  ["4"],
    "6":  ["1", "5"],
    "7":  ["6"],
    "8":  ["4"],
    "9":  ["8"],
    "10": ["9"],
    "11": ["2", "8"],
    "12": ["8", "10", "11"],
    "13": ["9", "10", "11"],
    "14": ["12", "13"],
    "16": ["15"],
    "17": ["15"],
    "18": ["17"],
    "19": ["17"],
    "20": ["17"],
    "21": ["17"],
    "22": ["18", "19", "20", "21"],
    "23": ["14", "22"],
    "24": ["6", "14"],
    "25": ["23", "24"],
    "26": ["25"],
    "27": ["25"],
    "28": ["25"],
    "29": ["25", "26"]
  },
  "criticalPath": [3, 4, 5, 6, 9, 10, 12, 14, 23, 25, 29]
}
```

## Notes

- All AWS resource names follow the convention `geosentinel-{component}` for easy identification and IAM scoping.
- The backend Lambda function handles all three API routes in a single deployment package; no separate functions per route.
- Frontend uses only CDN-loaded libraries (Tailwind CSS, jsPDF) to avoid a build step, keeping S3 deployment a simple file sync.
- ULID generation in `db_client.py` requires the `python-ulid` package to be included in the Lambda deployment zip.
- The `moto` library is only needed for tests and must not be included in the Lambda deployment package.
- Phase 1 tasks (1–7) can be completed in AWS Console or via CLI/IaC; the order within the phase matters only where dependencies exist: IAM role (Task 3) must exist before Lambda (Task 4); Lambda (Task 4) and S3 (Task 1) must exist before API Gateway (Task 5) and CloudFront (Task 6).
- Tasks 15–22 (frontend phases 3–4) are independent of backend tasks and can be developed in parallel with Phase 2.
- For local frontend development, set `API_BASE_URL` in `api.js` to a localhost API Gateway SAM local endpoint before switching to the CloudFront domain for production.

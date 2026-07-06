# Security Review — MojeSaldoo Backend

**Date:** 2026-07-06
**Scope:** Application code (`backend/apps/`, DRF config). Deployment/config hardening
(DEBUG, ALLOWED_HOSTS, CORS, CSRF/session cookies, HSTS/SSL) is **out of scope** by request,
except where a setting is part of a crypto/application design (noted inline).
**Method:** Static analysis + full read of auth, tenancy, KSeF, and upload code paths. Every
finding below was confirmed by reading the actual code path, not grep alone.

---

## Summary

| # | Severity | Area | Finding | Location |
|---|----------|------|---------|----------|
| 1 | **High** | Crypto | KSeF private keys encrypted with a key derived from `SECRET_KEY` | `apps/users/ksef_crypto.py:16,26` |
| 2 | **High** | XML/XXE | KSeF XML parsed with entity-resolving parsers (`lxml` default, stdlib `ET`) | `apps/ksef/ssapi_client.py:160`, `apps/ksef/views.py:591` |
| 3 | **Medium** | AuthZ | KSeF certificate management uses divergent legacy role check | `apps/users/certificate_views.py:33` |
| 4 | **Medium** | DoS/Auth | No rate limiting / throttling on any endpoint | DRF config; login/google/reset/OCR |
| 5 | **Medium** | Upload | Unvalidated image handed to Pillow (decompression bomb) | `apps/ksef/views.py:927,1145` |
| 6 | **Medium** | DoS/SSRF | Unbounded synchronous KSeF sync in one request | `apps/ksef/views.py:225,267` |
| 7 | **Low** | Auth | `BasicAuthentication` enabled globally over the API | `config/settings.py:120` |
| 8 | **Low** | Auth | Google login links accounts by email; Google `sub` never persisted | `apps/users/google_auth_views.py:88,91` |
| 9 | **Low** | Auth | Weak password policy for admin-created / edited member accounts | `apps/users/serializers.py:254`, `apps/users/views.py:428` |
| 10 | **Low** | API | `fields = "__all__"` on `InvoiceSerializer` | `apps/invoices/serializers.py:61` |
| 11 | **Low** | Info-leak | Company existence enumerable via 404-vs-403 | `apps/users/views.py:136` (pattern) |
| 12 | **Info** | Deps | Outdated dependencies with known CVEs | `pyproject.toml` |
| 13 | **Info** | Tests | No cross-tenant / authz regression tests | `apps/*/tests.py` |
| 14 | **Medium** | Segregation | `StockMovementViewSet` lacks membership/permission check | `apps/products/views.py:330` |
| 15 | **Medium** | AuthZ | `can_view_reports` flag defined but never enforced (all reports open to any member) | `apps/reporting/views.py` |
| 16 | **Low** | Onboarding | Register does not create company/admin; invariant relies on separate call | `apps/users/serializers.py:161` |
| 17 | **Low** | AuthZ | Any member can PATCH company profile | `apps/users/views.py:63` |
| 18 | **Info** | Auth | Deactivation doesn't clear `current_company` / invalidate JWTs | `apps/users/views.py:407` |
| 19 | **Info** | Info-leak | Global username uniqueness enables cross-tenant enumeration | `apps/users/serializers.py:257` |

(Findings #14–#19 come from the detailed HTTP-endpoint / tenant-segregation review — see that section below.)

**What is solid (verified):** Tenant isolation is applied consistently — every audited ViewSet
scopes `get_queryset` via `filter_queryset_for_current_company()` (`apps/users/tenant.py:6`) or an
explicit `.filter(company=...)`, `perform_create` always stamps `company=request.user.current_company`,
and serializer FK inputs are re-scoped to the current company (e.g. `apps/invoices/serializers.py:64-79`).
Company endpoints in `apps/users/views.py` enforce membership after the object lookup. JWT uses rotation
+ blacklist. Password reset guards against user enumeration and registration runs Django's
`validate_password`. `apps/ksef/crypto.py:260` already uses a hardened XML parser — the pattern exists,
it's just not applied everywhere (see #2).

---

## Findings

### 1. [High] KSeF private keys are encrypted with a key derived from `SECRET_KEY`
**Files:** `apps/users/ksef_crypto.py:16-27`; `SECRET_KEY` at `config/settings.py:9`.

The Fernet key that encrypts stored KSeF certificate private keys is
`PBKDF2(SECRET_KEY, static_salt)`. Two problems, one of which is a code-design flaw independent of
deployment:

- The salt is a hardcoded constant (`_FERNET_SALT`) and the master secret is `SECRET_KEY`, which in
  this repo is the committed placeholder `'django-insecure-your-secret-key-here'`. Anyone with source
  or settings access can derive the key and decrypt **every company's KSeF private key** in the DB,
  then sign/submit invoices to the Polish tax authority as that company.
- Even with a strong, secret `SECRET_KEY`, **coupling the KSeF key to `SECRET_KEY` is a design flaw**:
  `SECRET_KEY` is used broadly (sessions, signing) and cannot be rotated without silently making all
  stored KSeF ciphertext undecryptable, and any `SECRET_KEY` disclosure now also compromises signing
  key material.

**Scenario:** Repo access (or any `SECRET_KEY` leak via error page, backup, log) → decrypt
`KSeFCertificate.encrypted_key` for all tenants → impersonate them to KSeF.

**Remediation:** Introduce a dedicated, env-provided encryption key (e.g. `KSEF_ENCRYPTION_KEY`) that
is independent of `SECRET_KEY` and rotatable; use a per-record random salt stored alongside the
ciphertext. Consider an envelope-encryption / KMS approach. Re-encrypt existing rows on migration.

---

### 2. [High] XXE / entity expansion in KSeF XML parsing
**Files:** `apps/ksef/ssapi_client.py:160` (`etree.fromstring(xml_data.encode())`),
`apps/ksef/views.py:591` (`ET.fromstring(xml_bytes)`).

`lxml.etree.fromstring` with the **default parser** resolves external entities and allows network
access — classic XXE (local file disclosure, SSRF, entity-expansion DoS). `xml_data` in the submit
path derives from `invoice_base64` (base64-decoded input); downloaded/stored invoice XML is parsed the
same way in `views.py`. The stdlib `xml.etree` sink is lower risk (no external-entity resolution by
default) but still not hardened. Notably, `apps/ksef/crypto.py:260` already does this correctly:
`etree.XMLParser(ns_clean=True, resolve_entities=False, no_network=True)` — the fix is to apply that
same parser everywhere.

**Scenario:** A malicious or MITM'd invoice XML containing a `<!DOCTYPE ... SYSTEM "file:///etc/passwd">`
entity is parsed by `lxml` with default settings → file read / SSRF / billion-laughs memory blowup.

**Remediation:** Parse all XML with a hardened parser
(`etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=False)`), or use `defusedxml`
for the stdlib `ET` sink. Reuse the existing safe parser from `crypto.py`.

---

### 3. [Medium] KSeF certificate management uses a divergent legacy authorization check
**File:** `apps/users/certificate_views.py:33-39`.

`_can_manage_certificate` authorizes on the **legacy** `CompanyMembership.role` string
(`role__in=["admin","manager"]`) and ignores `company_role` — the fine-grained system the rest of the
app uses via `is_admin_member()` / `get_permissions()` (`apps/users/models.py:191-209`). The two
sources can drift:

- A user whose `company_role.is_admin` is True but whose legacy `role` is `"viewer"` is **denied**
  (fail-closed, but broken UX).
- A user with legacy `role="admin"`/`"manager"` but a restrictive `company_role` is **granted**
  certificate upload/delete despite the flag system denying them — privilege drift on a highly
  sensitive operation (control of the KSeF signing identity / private key material).

**Scenario:** An account left with a stale legacy `role="manager"` (e.g. from bootstrap/import) but
assigned a locked-down `company_role` can upload or delete the company's KSeF certificate.

**Remediation:** Replace `_can_manage_certificate` with the standard resolution —
`membership.get_permissions().get("can_manage_settings")` (or `is_admin_member()`), matching
`CompanyModuleEnableView`/`CompanyWorkflowSettingsView`. Reconcile or retire the legacy `role` field.

---

### 4. [Medium] No rate limiting anywhere
**Files:** DRF config (no `DEFAULT_THROTTLE_*`); endpoints in `apps/users/views.py`,
`apps/users/google_auth_views.py`, `apps/ksef/views.py`.

No throttle classes are configured or applied. Unauthenticated, unlimited attempts are possible
against: login / token obtain, `POST /api/auth/google/`, password-reset request (also an enumeration
oracle if timing differs), registration, and the OCR + KSeF-sync endpoints (resource abuse).

**Remediation:** Configure DRF `DEFAULT_THROTTLE_CLASSES` (AnonRateThrottle/UserRateThrottle) with
sane rates, and add tighter `ScopedRateThrottle` on login, Google auth, password reset, and OCR.

---

### 5. [Medium] Unvalidated image upload handed directly to Pillow
**Files:** `apps/ksef/views.py:927` (`Image.open(image_file)` in `_ocr_image`), view `PaperScanView`
at `:1145`.

`request.FILES["image"]` is passed straight to `PIL.Image.open` with no content-type, dimension, or
pixel-count validation and no `Image.MAX_IMAGE_PIXELS` guard, then to Tesseract. This is the classic
decompression-bomb / malformed-image DoS surface (and exposure to Pillow image-parsing CVEs). Note the
5MB `DATA_UPLOAD_MAX_MEMORY_SIZE` does **not** bound multipart file uploads, and a small compressed
file can decode to enormous pixel dimensions.

**Remediation:** Validate content-type/extension, cap upload size explicitly, set a conservative
`Image.MAX_IMAGE_PIXELS`, call `Image.verify()` / reject on decode error before OCR, and keep Pillow
patched. Apply the same size/type validation to the certificate/key upload
(`apps/users/certificate_views.py:140`).

---

### 6. [Medium] Unbounded synchronous KSeF sync in a single request
**Files:** `apps/ksef/views.py:225` (`_sync_from_ksef`), `:267` (`ReceivedInvoicesSyncView`).

`POST /api/ksef/inbox/sync/` loops **all** KSeF result pages, downloading and XML-parsing every
invoice synchronously inside the request. Unthrottled, it ties up a worker for the full duration,
makes many outbound calls, and (per #2) parses untrusted XML with an unsafe parser.

**Remediation:** Move to a background job/queue with pagination limits and per-request caps; throttle
the trigger endpoint; ensure the KSeF base URL is fixed server-side (confirmed taken from settings /
company record, not client — good).

---

### 7. [Low] `BasicAuthentication` enabled globally
**File:** `config/settings.py:120-124`.

`DEFAULT_AUTHENTICATION_CLASSES` includes `BasicAuthentication` (and `SessionAuthentication`) alongside
JWT. HTTP Basic accepts raw username/password on every API request — an unnecessary credential surface
that, combined with #4 (no throttle), enables offline-speed credential brute forcing over the API.

**Remediation:** Remove `BasicAuthentication` from the default classes; keep JWT (+ Session only if the
browsable API is needed in dev).

---

### 8. [Low] Google login links accounts by email; Google `sub` never persisted
**File:** `apps/users/google_auth_views.py:88,91`.

`get_or_create(email__iexact=email, ...)` links a Google login to any existing local account sharing
that email, and the Google `sub` (stable account identifier) is read but never stored, so there is no
durable binding — linking is re-decided by email on every login. `email_verified` is checked (good,
blocks the obvious takeover). Residual risk: local registration does **not** verify email, so an
attacker can pre-register an account with a victim's email; when the victim later uses Google sign-in
they are silently merged into (or inherit) that pre-seeded account.

**Remediation:** Persist and match on Google `sub` (store on the user or a linked-identity row); only
fall back to email match when `sub` is unknown, and require app-side email verification before
auto-linking an existing password account.

---

### 9. [Low] Weak password policy for admin-created and admin-edited member accounts
**Files:** `apps/users/serializers.py:254` (`AddMemberSerializer.password`, `min_length=8` only),
`apps/users/views.py:428` (member-edit password sets on `len >= 8`).

These paths bypass `validate_password` (Common/Numeric/Similarity validators). Registration correctly
uses `validate_password` (`serializers.py:145`), so the policy is inconsistent. Verify the
password-reset-confirm path also enforces validators.

**Remediation:** Apply `validate_password` to `AddMemberSerializer` and the member-edit/reset-confirm
password fields.

---

### 10. [Low] `fields = "__all__"` on `InvoiceSerializer`
**File:** `apps/invoices/serializers.py:61`.

Currently mitigated by `read_only_fields` covering `company`/`user`/`status` etc., so no live
mass-assignment. But `__all__` auto-exposes any field added to the model later, including sensitive
ones, and auto-includes them as writable unless remembered in `read_only_fields`.

**Remediation:** Enumerate fields explicitly.

---

### 11. [Low] Company existence enumerable (404 vs 403)
**File:** pattern across `apps/users/views.py` (e.g. `:136`, `:154`).

Company endpoints call `get_object_or_404(Company, uuid=...)` before the membership check, so a
non-member gets 404 for a nonexistent company but 403 for a real one they don't belong to — a minor
existence oracle over UUIDs (low practical value given UUIDs are unguessable).

**Remediation:** Optional — return 404 uniformly for both non-existent and non-member companies.

---

### 12. [Info] Outdated dependencies with known CVEs
**File:** `pyproject.toml`.

`Django==4.2.7` (many 4.2.x security releases since), `requests==2.31.0` (CVE-2024-35195),
`gunicorn==21.2.0` (request-smuggling CVEs), `djangorestframework==3.14.0`. Deployment-adjacent but
worth an app-level bump.

**Remediation:** Add `pip-audit` to CI; upgrade to current patched releases.

---

### 13. [Info] Missing security regression tests
**Files:** `apps/*/tests.py`.

No tests assert cross-tenant isolation (member of company A gets 404/403 fetching B's object by UUID),
KSeF certificate authorization, Google account-linking behavior, or upload validation.
`apps/suppliers/tests.py` is a stub.

**Remediation:** Add negative-path tests for tenant isolation on each ViewSet and for findings #3, #5,
#8, #9 so regressions are caught.

---

## HTTP Endpoint Review — Tenant Segregation Constraints

Reviewed every HTTP endpoint against the four stated invariants. Verdict per constraint, then the
new endpoint-level findings (#14–#19).

| Constraint | Verdict | Notes |
|-----------|---------|-------|
| 1. Register → company created → user is admin | ⚠️ **Partial** | Registration creates **only** the User. Company + admin membership is created by a *separate* authenticated call to `CompanyCreateView` (`POST /api/companies/`), which does correctly make the creator an admin. Not enforced atomically at registration (#16). |
| 2. Users cannot view other companies' data | ✅ **Holds, one exception** | `current_company` can only ever point to a company the user is/was a member of (`SwitchCompanyView` re-checks membership; it is the only setter). All ViewSets scope `get_queryset` to `current_company`. Exception: `StockMovementViewSet` (#14). |
| 3. Invited users can be added as non-admins | ✅ **Holds** | `AddMemberSerializer` requires a `company_role_id`; admins choose a non-admin role. Only admins can invite (`_require_admin_membership`). But least-privilege for non-admins is leaky (#14, #15, #17). |
| 4. Application data never shared between companies | ✅ **Holds, same exception** | Data isolation enforced by per-request `current_company` filtering + `IsCompanyMember`/`HasCompanyPermission` (both re-query active membership from the DB each request, so removal takes effect immediately). Exception: `StockMovementViewSet` (#14). |

### 14. [Medium] `StockMovementViewSet` has no membership/permission check
**File:** `apps/products/views.py:321-359`.

Unlike every other business ViewSet, this one declares `permission_classes = [IsAuthenticated]` only —
no `IsCompanyMember`, no `HasCompanyPermission`. `get_queryset` filters
`StockMovement.objects.filter(company=self.request.user.current_company)` but nothing verifies the
requester still has an **active** membership in that company. Two consequences:

- **Cross-company / stale access (constraints #2, #4):** deactivating a member (`CompanyMemberDetailView`
  sets `is_active=False`) does **not** clear their `current_company` (only company delete/leave does).
  A deactivated ex-member therefore keeps reading the company's full stock-movement ledger here, even
  though every membership-checked endpoint correctly blocks them.
- **Least-privilege within the company (constraint #3):** any authenticated member — including an
  invited "viewer"/"driver" with no stock permissions — can read the entire stock ledger, whereas
  `ProductViewSet`/`WarehouseViewSet` require membership.

Cross-tenant data leak via the `?product=`/`?warehouse=` filters is *not* possible (they are applied
on top of the `company=current_company` bound), so the exposure is confined to the current company —
but the membership gate is missing.

**Remediation:** `permission_classes = [IsAuthenticated, IsCompanyMember, HasCompanyPermission]` with
`required_permission = 'can_manage_stock_moves'` (and `read_permission` as appropriate), matching the
sibling ViewSets.

### 15. [Medium] `can_view_reports` permission is defined but never enforced
**Files:** flag at `apps/users/models.py:135,160`; all reporting endpoints in `apps/reporting/views.py`
use `permission_classes = [IsAuthenticated, IsCompanyMember]` (e.g. `:116, :408, :492, :1512`).

The `can_view_reports` flag exists specifically to gate analytics, but no reporting view checks it. Any
active member — regardless of role — can read sales summaries, profit/loss, product & customer margins,
payment aging, supplier costs, and **JPK/EWP tax exports** (`JpkEwpExportView:1504`). This violates the
least-privilege intent for invited non-admin members (constraint #3). Data stays within the company
(company-scoped querysets), so it is not a cross-tenant leak, but it is a broken authorization control.

**Remediation:** Add `HasCompanyPermission` with `read_permission = 'can_view_reports'` to the reporting
views (or a shared base view).

### 16. [Low] "Register → own company → admin" is not enforced at registration
**Files:** `apps/users/serializers.py:161-164` (creates only the User); `apps/users/views.py:85-108`
(`CompanyCreateView` does the real work); dead bootstrap `apps/users/tenant.py:16` (`get_request_company`
is defined but **called nowhere**).

After `POST /api/auth/register/` the user has `current_company = None` and belongs to no company, so
they see no data (fail-safe for segregation) but are also not yet an admin of anything. The invariant
holds only if the client then calls `CompanyCreateView`. Nothing enforces one-company-per-user or
prevents a user from creating many companies (each making them admin). The abandoned
`get_request_company` auto-bootstrap suggests this flow was meant to be automatic.

**Remediation:** Either create the company + admin membership atomically inside registration, or
document that `CompanyCreateView` is the required second step and remove the dead `get_request_company`.

### 17. [Low] Any member (not just admins) can edit the company profile
**File:** `apps/users/views.py:63-82` (`CompanyDetailView`, `RetrieveUpdateAPIView`,
`permission_classes = [IsAuthenticated]`, queryset scoped to member companies).

`PATCH /api/companies/<uuid>/` lets **any** active member update company profile fields (name, NIP,
address, …). Segregation is fine (only member companies are in the queryset), but an invited non-admin
"viewer" editing the company's legal identity violates least-privilege (constraint #3).

**Remediation:** Require `can_manage_settings` (or admin) for `PATCH`; keep `GET` open to members.

### 18. [Info] Member deactivation does not clear `current_company` or invalidate JWTs
**Files:** `apps/users/views.py:407-409` (deactivate sets `is_active=False` only);
`apps/users/deletion_views.py` (only delete/leave clear `current_company`).

Because `IsCompanyMember`/`HasCompanyPermission` re-query active membership from the DB on every
request, a deactivated member is blocked immediately on all membership-checked endpoints regardless of
their still-valid JWT — good. The residual exposure is exactly the one un-checked endpoint (#14).
Clearing `current_company` on deactivation would defense-in-depth this.

### 19. [Info] Global username uniqueness enables cross-tenant username enumeration
**Files:** `apps/users/serializers.py:257-260` (`AddMemberSerializer.validate_username`),
`google_auth_views.py:132` (`_unique_username`).

Usernames are unique globally, and the add-member/registration validators reveal whether a username
already exists (across all companies). A company admin (or registrant) can probe for the existence of
usernames belonging to other tenants. Low impact.

---

## Suggested remediation order
1. #1 KSeF key derivation and #2 XXE — highest blast radius (tax-authority impersonation, file/SSRF).
2. #3 certificate authorization, #5 image validation, #4 throttling, #6 sync — exploitable DoS / privilege drift.
3. #7–#11 hardening; #12 dependency bumps; #13 regression tests to lock in fixes.

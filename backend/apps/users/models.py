import uuid

from django.contrib.auth.models import AbstractUser, UserManager
from django.db import models


class NullableEmailUserManager(UserManager):
    @classmethod
    def normalize_email(cls, email):
        return super().normalize_email(email) or None


class User(AbstractUser):
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    email = models.EmailField(unique=True, null=True, blank=True)

    objects = NullableEmailUserManager()
    phone_number = models.CharField(max_length=20, blank=True, null=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    current_company = models.ForeignKey(
        "Company",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )

    def __str__(self):
        return self.username


class Company(models.Model):
    COMPANY_TYPE_INVOICING = "invoicing"
    COMPANY_TYPE_VAN = "van_selling"
    COMPANY_TYPE_WAREHOUSE = "warehouse"
    COMPANY_TYPE_PRODUCTION = "production"
    COMPANY_TYPE_MIXED = "mixed"
    COMPANY_TYPE_CHOICES = [
        (COMPANY_TYPE_INVOICING,  "Tylko fakturowanie"),
        (COMPANY_TYPE_VAN,        "Van Selling"),
        (COMPANY_TYPE_WAREHOUSE,  "Magazyn i handel"),
        (COMPANY_TYPE_PRODUCTION, "Produkcja"),
        (COMPANY_TYPE_MIXED,      "Mieszany"),
    ]

    TAXATION_KPIR = "kpir"
    TAXATION_RYCZALT = "ryczalt"
    TAXATION_FORM_CHOICES = [
        (TAXATION_KPIR,    "KPiR (Podatkowa Księga Przychodów i Rozchodów)"),
        (TAXATION_RYCZALT, "Ryczałt ewidencjonowany"),
    ]

    RYCZALT_ROLNICZE   = "rolnicze"
    RYCZALT_HANDEL     = "handel"
    RYCZALT_BUDOWNICTWO = "budownictwo"
    RYCZALT_USLUGI     = "uslugi"
    RYCZALT_IT         = "it"
    RYCZALT_MEDYCZNE   = "medyczne"
    RYCZALT_FINANSOWE  = "finansowe"
    RYCZALT_WOLNE_ZAWODY = "wolne_zawody"
    RYCZALT_CATEGORY_CHOICES = [
        (RYCZALT_ROLNICZE,     "2% — Sprzedaż produktów rolnych"),
        (RYCZALT_HANDEL,       "3% — Handel (zakup i odsprzedaż)"),
        (RYCZALT_BUDOWNICTWO,  "5,5% — Budownictwo"),
        (RYCZALT_USLUGI,       "8,5% — Usługi"),
        (RYCZALT_IT,           "12% — Usługi IT i pośrednictwo finansowe"),
        (RYCZALT_MEDYCZNE,     "14% — Usługi medyczne, architektoniczne, inżynieryjne"),
        (RYCZALT_FINANSOWE,    "15% — Doradztwo finansowe i rachunkowość"),
        (RYCZALT_WOLNE_ZAWODY, "17% — Wolne zawody (prawnicy, lekarze itp.)"),
    ]

    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    name = models.CharField(max_length=255)
    nip = models.CharField(max_length=10, unique=True, blank=True, null=True)
    address = models.TextField(blank=True)
    city = models.CharField(max_length=100, blank=True)
    postal_code = models.CharField(max_length=10, blank=True)
    phone = models.CharField(max_length=20, blank=True)
    email = models.EmailField(blank=True)
    is_active = models.BooleanField(default=True)
    # Income tax form — determines which JPK reports are needed.
    taxation_form = models.CharField(
        max_length=10,
        choices=TAXATION_FORM_CHOICES,
        default=TAXATION_KPIR,
        blank=True,
    )
    # Ryczałt rate category — required when taxation_form='ryczalt'.
    ryczalt_category = models.CharField(
        max_length=20,
        choices=RYCZALT_CATEGORY_CHOICES,
        blank=True,
        null=True,
    )
    # Set during onboarding tile selection; used for analytics and UI hints.
    company_type = models.CharField(
        max_length=20,
        choices=COMPANY_TYPE_CHOICES,
        default=COMPANY_TYPE_INVOICING,
        blank=True,
    )
    # True once the user completes the tile-based onboarding wizard.
    onboarding_completed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    deleted_at = models.DateTimeField(null=True, blank=True)


class CompanyRole(models.Model):
    """
    A company-defined role with fine-grained permission flags.
    Admins create roles (e.g. "Kierowca", "Magazynier") and configure
    which parts of the app each role can access.
    The system auto-creates one role named "Administrator" (is_admin=True)
    for every company — it has all permissions and cannot be deleted.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="roles")
    name = models.CharField(max_length=100)
    # is_admin=True means "all permissions, always" — cannot be edited by users
    is_admin = models.BooleanField(default=False)

    # --- Team & Settings ---
    can_manage_team = models.BooleanField(default=False, help_text="Zarządzanie pracownikami i rolami")
    can_manage_settings = models.BooleanField(default=False, help_text="Ustawienia firmy, moduły, przepływ dokumentów")

    # --- Cross-cutting ---
    can_see_prices = models.BooleanField(default=True, help_text="Widoczność cen i kwot we wszystkich dokumentach")

    # --- Per-module ---
    can_manage_products = models.BooleanField(default=False, help_text="Produkty — katalog produktów i ceny")
    can_manage_warehouses = models.BooleanField(default=False, help_text="Magazyny — zarządzanie magazynami")
    can_manage_inventory = models.BooleanField(default=False, help_text="Inwentaryzacja — dokumenty INW")
    can_manage_customers = models.BooleanField(default=False, help_text="Klienci")
    can_manage_orders = models.BooleanField(default=False, help_text="Zamówienia")
    can_manage_delivery = models.BooleanField(default=False, help_text="Dokumenty WZ/ZW, dostawa")
    can_access_routes = models.BooleanField(default=False, help_text="Trasy vana")
    can_manage_invoices = models.BooleanField(default=False, help_text="Faktury")
    can_manage_purchasing = models.BooleanField(default=False, help_text="Zakupy, dostawcy, dokumenty PZ")
    can_manage_production = models.BooleanField(default=False, help_text="Produkcja, receptury")
    can_view_reports = models.BooleanField(default=False, help_text="Raporty i analizy")
    can_access_ksef_inbox = models.BooleanField(default=False, help_text="Odebrane faktury KSeF (przychodzące od dostawców)")
    can_manage_stock_moves = models.BooleanField(default=False, help_text="Przesunięcia magazynowe (MM)")
    can_manage_accounting = models.BooleanField(default=False, help_text="Adnotacje kosztowe — opisywanie faktur i projekty kosztowe")

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("company", "name")

    def __str__(self):
        return f"{self.company.name} / {self.name}"

    def get_permissions(self) -> dict:
        """Return a dict of all permission flags (True for everything if is_admin)."""
        if self.is_admin:
            return {f: True for f in PERMISSION_FLAGS}
        return {f: getattr(self, f) for f in PERMISSION_FLAGS}


PERMISSION_FLAGS = [
    "can_manage_team", "can_manage_settings", "can_see_prices",
    "can_manage_products", "can_manage_warehouses", "can_manage_inventory",
    "can_manage_customers", "can_manage_orders",
    "can_manage_delivery", "can_access_routes", "can_manage_invoices",
    "can_manage_purchasing", "can_manage_production", "can_view_reports",
    "can_access_ksef_inbox", "can_manage_stock_moves", "can_manage_accounting",
]


class CompanyMembership(models.Model):
    ROLE_CHOICES = [
        ("admin", "Admin"),
        ("manager", "Manager"),
        ("driver", "Driver"),
        ("viewer", "Viewer"),
    ]
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="memberships")
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="memberships")
    # Legacy role field — kept for backwards compat; new code uses company_role
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default="viewer")
    # New fine-grained role; None means fall back to legacy role field
    company_role = models.ForeignKey(
        CompanyRole,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="members",
    )
    is_active = models.BooleanField(default=True)
    joined_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("user", "company")

    def get_permissions(self) -> dict:
        """Return resolved permissions: company_role if set, else derive from legacy role."""
        if self.company_role_id:
            return self.company_role.get_permissions()
        # Legacy fallback
        all_true = {f: True for f in PERMISSION_FLAGS}
        if self.role == "admin":
            return all_true
        if self.role == "manager":
            return {**all_true, "can_manage_team": False}
        if self.role == "driver":
            return {f: f in ("can_manage_delivery", "can_access_routes") for f in PERMISSION_FLAGS}
        # viewer
        return {f: False for f in PERMISSION_FLAGS}

    def is_admin_member(self) -> bool:
        if self.company_role_id:
            return self.company_role.is_admin
        return self.role == "admin"


class CompanyWorkflowSettings(models.Model):
    """Per-company document flow configuration — enforced by the backend."""

    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    company = models.OneToOneField(
        Company,
        on_delete=models.CASCADE,
        related_name="workflow_settings",
    )
    orders_required = models.BooleanField(
        default=False,
        help_text=(
            "If True, WZ documents must reference an Order. "
            "Standalone WZ creation is blocked at the API level."
        ),
    )
    wz_required_before_invoice = models.BooleanField(
        default=True,
        help_text=(
            "If True, at least one delivered WZ must exist before an invoice "
            "can be issued for an order. Disable for service companies that "
            "invoice directly from the order without physical delivery."
        ),
    )
    track_supplier_payments = models.BooleanField(
        default=False,
        help_text=(
            "If True, show payment tracking fields (due_date, paid_at, is_paid) "
            "on received supplier invoices (ReceivedKSeFInvoice). "
            "Disable for companies that do not track when they pay suppliers."
        ),
    )

    class Meta:
        verbose_name = "Company workflow settings"
        verbose_name_plural = "Company workflow settings"

    def __str__(self):
        return f"WorkflowSettings({self.company.name})"


def get_workflow_settings(company) -> "CompanyWorkflowSettings":
    """Return (or create with defaults) the workflow settings for a company."""
    obj, _ = CompanyWorkflowSettings.objects.get_or_create(company=company)
    return obj


class CompanyModule(models.Model):
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    MODULE_CHOICES = [
        # --- Core (always enabled) ---
        ("products",        "Products & Inventory"),
        ("customers",       "Customers"),
        ("warehouses",      "Warehouse Management"),
        ("orders",          "Orders"),
        ("delivery",        "Delivery & WZ/ZW Documents"),
        ("invoicing",       "Invoicing"),
        # --- Optional ---
        ("van_routes",      "Van Routes & Mobile Delivery"),
        ("purchasing",      "Purchasing & Suppliers (PZ)"),
        ("production",      "Own Production (PW/RW)"),
        ("ksef_inbox",      "KSeF Inbox (Received Invoices)"),
        # --- Integrations ---
        ("ksef",            "KSeF Integration"),
        ("reporting",       "Reporting & Analytics"),
        ("cost_allocation", "Cost Allocation & Accounting Notes"),
        ("fixed_costs",     "Fixed Costs & Personnel"),
    ]
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name="modules")
    module = models.CharField(max_length=50, choices=MODULE_CHOICES)
    is_enabled = models.BooleanField(default=False)
    enabled_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        unique_together = ("company", "module")


class WebPushSubscription(models.Model):
    """
    Browser Web Push subscription for a user's device.
    Stored as the raw fields from PushManager.subscribe() — contains
    `endpoint`, `keys.p256dh`, and `keys.auth` needed by pywebpush.
    One user may have multiple browsers/devices.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="push_subscriptions")
    endpoint = models.TextField(unique=True)
    p256dh = models.TextField()   # browser public key
    auth = models.TextField()     # auth secret
    user_agent = models.CharField(max_length=255, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "Web Push Subscription"
        verbose_name_plural = "Web Push Subscriptions"

    def __str__(self):
        return f"{self.user.username} — {self.endpoint[:60]}…"


class FCMDeviceToken(models.Model):
    """
    FCM push notification token for a user's device.
    One user may have multiple devices (phone + tablet), and tokens expire/rotate,
    so we store them by (user, token) and keep the last-seen timestamp for cleanup.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name="fcm_tokens")
    token = models.TextField(unique=True)
    device_name = models.CharField(max_length=100, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    last_used_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "FCM Device Token"
        verbose_name_plural = "FCM Device Tokens"

    def __str__(self):
        return f"{self.user.username} — {self.token[:20]}…"


class KSeFCertificate(models.Model):
    uuid = models.UUIDField(default=uuid.uuid4, editable=False, unique=True)
    company = models.OneToOneField(
        Company,
        on_delete=models.CASCADE,
        related_name="ksef_certificate",
    )
    uploaded_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    # Public certificate (.pem) — not encrypted
    certificate_pem = models.TextField()
    # Private key encrypted with server-derived key (see ksef_crypto)
    encrypted_key = models.TextField()
    subject_name = models.CharField(max_length=255, blank=True)
    valid_from = models.DateField(null=True, blank=True)
    valid_until = models.DateField(null=True, blank=True)
    is_active = models.BooleanField(default=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)

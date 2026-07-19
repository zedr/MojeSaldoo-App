import uuid
from datetime import date
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.db.models.deletion import ProtectedError
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient, APIRequestFactory

from apps.customers.models import Customer
from apps.delivery.models import DeliveryDocument, DeliveryItem
from apps.delivery.serializers import DeliveryDocumentSerializer
from apps.delivery.services import (
    build_delivery_document_preview_data,
    generate_delivery_from_order,
)
from apps.orders.models import Order, OrderItem
from apps.products.models import Product, ProductStock, StockMovement, Warehouse
from apps.suppliers.models import Supplier
from apps.users.models import Company, CompanyMembership, CompanyModule


class DeliveryDocumentModelTests(TestCase):
    """Document numbering, uniqueness, and basic persistence."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="delivery-model-user",
            email="delivery-model@test.com",
            password="test12345",
        )
        self.company = Company.objects.create(name="Comp A")
        self.company_b = Company.objects.create(name="Comp B")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.company,
            role="admin",
            is_active=True,
        )
        self.customer = Customer.objects.create(name="Cust A", company=self.company)
        self.customer_b = Customer.objects.create(name="Cust B", company=self.company_b)
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status=Order.STATUS_DRAFT,
        )
        self.order_b = Order.objects.create(
            user=self.user,
            customer=self.customer_b,
            company=self.company_b,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status=Order.STATUS_DRAFT,
        )

    def _make_doc(self, company=None, order=None, **kwargs):
        return DeliveryDocument.objects.create(
            company=company or self.company,
            order=order or self.order,
            user=self.user,
            document_type=kwargs.pop("document_type", DeliveryDocument.DOC_TYPE_WZ),
            issue_date=kwargs.pop("issue_date", date(2026, 4, 1)),
            **kwargs,
        )

    def test_new_document_receives_sequential_number_per_company_and_type(self):
        d1 = self._make_doc()
        d2 = self._make_doc()
        self.assertEqual(d1.document_number, "WZ/2026/0001")
        self.assertEqual(d2.document_number, "WZ/2026/0002")

    def test_different_document_types_have_independent_sequences(self):
        wz = self._make_doc(document_type=DeliveryDocument.DOC_TYPE_WZ)
        mm = self._make_doc(document_type=DeliveryDocument.DOC_TYPE_MM)
        pz = self._make_doc(document_type=DeliveryDocument.DOC_TYPE_PZ)
        self.assertEqual(wz.document_number, "WZ/2026/0001")
        self.assertEqual(mm.document_number, "MM/2026/0001")
        self.assertEqual(pz.document_number, "PZ/2026/0001")

    def test_different_companies_may_reuse_number_pattern(self):
        a = self._make_doc()
        b = self._make_doc(company=self.company_b, order=self.order_b)
        self.assertEqual(a.document_number, "WZ/2026/0001")
        self.assertEqual(b.document_number, "WZ/2026/0001")

    def test_year_is_taken_from_issue_date(self):
        d = self._make_doc(issue_date=date(2025, 6, 15))
        self.assertEqual(d.document_number, "WZ/2025/0001")

    def test_explicit_document_number_is_not_replaced(self):
        d = self._make_doc(document_number="MANUAL-WZ-1")
        self.assertEqual(d.document_number, "MANUAL-WZ-1")

    def test_duplicate_document_number_per_company_fails(self):
        first = self._make_doc()
        with self.assertRaises(IntegrityError):
            DeliveryDocument.objects.create(
                company=self.company,
                order=self.order,
                user=self.user,
                document_type=DeliveryDocument.DOC_TYPE_WZ,
                issue_date=date(2026, 4, 1),
                document_number=first.document_number,
            )

    def test_id_is_uuid(self):
        d = self._make_doc()
        self.assertEqual(len(str(d.uuid)), 36)

    def test_default_status_is_draft(self):
        d = self._make_doc()
        self.assertEqual(d.status, DeliveryDocument.STATUS_DRAFT)

    def test_str_uses_document_number_when_set(self):
        d = self._make_doc()
        self.assertEqual(str(d), "WZ/2026/0001")


class DeliveryItemModelTests(TestCase):
    """Line items: FK behavior and defaults."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="delivery-item-user",
            email="delivery-item@test.com",
            password="test12345",
        )
        self.company = Company.objects.create(name="Item Co")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.company,
            role="admin",
            is_active=True,
        )
        self.customer = Customer.objects.create(name="C1", company=self.company)
        self.product = Product.objects.create(
            name="Widget",
            company=self.company,
            price_net=Decimal("10.00"),
            price_gross=Decimal("12.30"),
        )
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status=Order.STATUS_DRAFT,
        )
        self.order_item = OrderItem.objects.create(
            order=self.order,
            product=self.product,
            quantity=Decimal("5.00"),
            unit_price_net=Decimal("10.00"),
            unit_price_gross=Decimal("12.30"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("0.00"),
        )
        self.doc = DeliveryDocument.objects.create(
            company=self.company,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
        )

    def test_create_sets_defaults_and_optional_actual(self):
        line = DeliveryItem.objects.create(
            delivery_document=self.doc,
            order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("3.50"),
        )
        self.assertEqual(line.quantity_planned, Decimal("3.50"))
        self.assertIsNone(line.quantity_actual)
        self.assertEqual(line.quantity_returned, Decimal("0"))
        self.assertEqual(line.return_reason, "")
        self.assertFalse(line.is_damaged)
        self.assertEqual(len(str(line.uuid)), 36)

    def test_delete_delivery_document_cascades_to_items(self):
        line = DeliveryItem.objects.create(
            delivery_document=self.doc,
            order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("1.00"),
        )
        pk = line.pk
        self.doc.delete()
        self.assertFalse(DeliveryItem.objects.filter(pk=pk).exists())

    def test_delete_order_item_blocked_while_referenced(self):
        DeliveryItem.objects.create(
            delivery_document=self.doc,
            order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("1.00"),
        )
        with self.assertRaises(ProtectedError):
            self.order_item.delete()


class DeliveryDocumentSerializerTests(TestCase):
    """Serializer validation with request / current company context."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="delivery-serializer-user",
            email="delivery-ser@test.com",
            password="test12345",
        )
        self.company = Company.objects.create(name="Ser Co")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.company,
            role="admin",
            is_active=True,
        )
        self.user.current_company = self.company
        self.user.save(update_fields=["current_company"])
        self.customer = Customer.objects.create(name="C1", company=self.company)
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status=Order.STATUS_DRAFT,
        )
        self.factory = APIRequestFactory()
        self.request = self.factory.post("/api/delivery/")
        self.request.user = self.user

    def test_valid_minimal_payload(self):
        ser = DeliveryDocumentSerializer(
            data={
                "order_id": str(self.order.uuid),
                "document_type": DeliveryDocument.DOC_TYPE_WZ,
                "issue_date": "2026-04-20",
            },
            context={"request": self.request},
        )
        self.assertTrue(ser.is_valid(), ser.errors)

    def test_validate_order_rejects_other_company_when_in_context(self):
        other_co = Company.objects.create(name="Other")
        foreign_c = Customer.objects.create(name="FC", company=other_co)
        foreign_o = Order.objects.create(
            user=self.user,
            customer=foreign_c,
            company=other_co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 2, 1),
            status=Order.STATUS_DRAFT,
        )
        ser = DeliveryDocumentSerializer(
            data={
                "order_id": str(foreign_o.uuid),
                "document_type": DeliveryDocument.DOC_TYPE_WZ,
                "issue_date": "2026-04-20",
            },
            context={"request": self.request},
        )
        self.assertFalse(ser.is_valid())
        self.assertIn("order_id", ser.errors)


class DeliveryDocumentAPITests(TestCase):
    """ViewSet: auth, tenant scope, CRUD."""

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="delivery-api-user",
            email="delivery-api@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Delivery tenant")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.co,
            role="admin",
            is_active=True,
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)
        self.customer = Customer.objects.create(name="Buyer", company=self.co)
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status=Order.STATUS_DRAFT,
        )
        self.wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.product = Product.objects.create(
            name="Line product",
            company=self.co,
            price_net=Decimal("10.00"),
            price_gross=Decimal("12.30"),
        )
        self.product_b = Product.objects.create(
            name="Other line product",
            company=self.co,
            price_net=Decimal("5.00"),
            price_gross=Decimal("6.00"),
        )

    def test_delivery_document_list_url_resolves(self):
        self.assertEqual(reverse("delivery-document-list"), "/api/delivery/")

    def test_list_requires_authentication(self):
        r = self.client.get(reverse("delivery-document-list"))
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_preview_requires_authentication(self):
        r = self.client.get(
            reverse(
                "delivery-document-preview",
                kwargs={"uuid": str(uuid.uuid4())},
            )
        )
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_list_authenticated_returns_results(self):
        DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 15),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.get(reverse("delivery-document-list"))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIn("results", r.data)
        self.assertGreaterEqual(r.data["count"], 1)

    def test_list_includes_order_number_and_customer_name(self):
        self.client.force_authenticate(user=self.user)
        DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 20),
        )
        r = self.client.get(reverse("delivery-document-list"))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        row = r.data["results"][0]
        self.assertEqual(row["order_number"], self.order.order_number)
        self.assertEqual(row["customer_name"], self.customer.name)

    def test_list_forbidden_without_current_company(self):
        u = get_user_model().objects.create_user(
            username="no-cc-del",
            email="no-cc-d@test.com",
            password="x",
        )
        CompanyMembership.objects.create(
            user=u, company=self.co, role="viewer", is_active=True
        )
        self.client.force_authenticate(u)
        r = self.client.get(reverse("delivery-document-list"))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_list_forbidden_wrong_current_company(self):
        other = Company.objects.create(name="Not member")
        self.user.current_company = other
        self.user.save(update_fields=["current_company"])
        self.client.force_authenticate(user=self.user)
        r = self.client.get(reverse("delivery-document-list"))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])

    def test_create_sets_company_user_and_document_number(self):
        self.client.force_authenticate(user=self.user)
        body = {
            "order_id": str(self.order.uuid),
            "document_type": DeliveryDocument.DOC_TYPE_WZ,
            "issue_date": "2026-04-18",
            "from_warehouse_id": str(self.wh.uuid),
        }
        r = self.client.post(
            reverse("delivery-document-list"),
            data=body,
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_number"], "WZ/2026/0001")
        self.assertEqual(r.data["status"], DeliveryDocument.STATUS_DRAFT)
        self.assertEqual(str(r.data["company"]), str(self.co.uuid))
        self.assertEqual(str(r.data["user"]), str(self.user.uuid))
        row = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertEqual(row.company_id, self.co.id)
        self.assertEqual(row.user_id, self.user.id)

    def test_retrieve_from_other_company_returns_404(self):
        self.client.force_authenticate(user=self.user)
        other_co = Company.objects.create(name="OtherCo")
        foreign_c = Customer.objects.create(name="Ext", company=other_co)
        foreign_o = Order.objects.create(
            user=self.user,
            customer=foreign_c,
            company=other_co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 8, 1),
            status=Order.STATUS_DRAFT,
        )
        foreign_doc = DeliveryDocument.objects.create(
            company=other_co,
            order=foreign_o,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 5, 1),
        )
        r = self.client.get(
            reverse("delivery-document-detail", kwargs={"uuid": str(foreign_doc.uuid)})
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_preview_returns_404_for_document_other_company(self):
        self.client.force_authenticate(user=self.user)
        other_co = Company.objects.create(name="OtherCo")
        foreign_c = Customer.objects.create(name="Ext", company=other_co)
        foreign_o = Order.objects.create(
            user=self.user,
            customer=foreign_c,
            company=other_co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 8, 1),
            status=Order.STATUS_DRAFT,
        )
        foreign_doc = DeliveryDocument.objects.create(
            company=other_co,
            order=foreign_o,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 5, 1),
        )
        r = self.client.get(
            reverse(
                "delivery-document-preview",
                kwargs={"uuid": str(foreign_doc.uuid)},
            )
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_create_rejects_order_from_other_company(self):
        self.client.force_authenticate(user=self.user)
        other_co = Company.objects.create(name="Foreign")
        foreign_c = Customer.objects.create(name="F", company=other_co)
        foreign_o = Order.objects.create(
            user=self.user,
            customer=foreign_c,
            company=other_co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 8, 1),
            status=Order.STATUS_DRAFT,
        )
        r = self.client.post(
            reverse("delivery-document-list"),
            data={
                "order_id": str(foreign_o.uuid),
                "document_type": DeliveryDocument.DOC_TYPE_WZ,
                "issue_date": "2026-04-01",
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("order_id", r.data)

    def test_patch_updates_fields_and_sets_user(self):
        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
        )
        other = get_user_model().objects.create_user(
            username="delivery-editor",
            email="editor@test.com",
            password="x",
        )
        CompanyMembership.objects.create(
            user=other, company=self.co, role="admin", is_active=True
        )
        other.current_company = self.co
        other.save(update_fields=["current_company"])
        self.client.force_authenticate(user=other)
        r = self.client.patch(
            reverse("delivery-document-detail", kwargs={"uuid": str(d.uuid)}),
            data={"driver_name": "Jan K."},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["status"], DeliveryDocument.STATUS_DRAFT)
        self.assertEqual(r.data["driver_name"], "Jan K.")
        d.refresh_from_db()
        self.assertEqual(d.user_id, other.id)

    def test_detail_includes_locked_for_edit_and_linked_invoices(self):
        """GET exposes ``locked_for_edit`` and ``linked_invoices``."""
        from apps.invoices.models import Invoice

        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
        )
        r0 = self.client.get(
            reverse("delivery-document-detail", kwargs={"uuid": str(d.uuid)}),
        )
        self.assertEqual(r0.status_code, status.HTTP_200_OK)
        self.assertFalse(r0.data["locked_for_edit"])
        self.assertEqual(r0.data["linked_invoices"], [])
        inv = Invoice.objects.create(
            company=self.co,
            user=self.user,
            order=self.order,
            customer=self.customer,
            delivery_document=d,
            issue_date=date(2026, 5, 1),
            sale_date=date(2026, 5, 1),
            due_date=date(2026, 5, 15),
            status=Invoice.STATUS_DRAFT,
        )
        r1 = self.client.get(
            reverse("delivery-document-detail", kwargs={"uuid": str(d.uuid)}),
        )
        self.assertTrue(r1.data["locked_for_edit"])
        self.assertEqual(len(r1.data["linked_invoices"]), 1)
        self.assertEqual(r1.data["linked_invoices"][0]["id"], str(inv.uuid))
        self.assertTrue(r1.data["linked_invoices"][0]["invoice_number"])

    def test_mutations_reject_when_locked_by_invoice(self):
        from apps.invoices.models import Invoice

        self.order.status = Order.STATUS_CONFIRMED
        self.order.save(update_fields=["status"])
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            from_warehouse=self.wh,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            status=DeliveryDocument.STATUS_DRAFT,
        )
        oi = OrderItem.objects.create(
            order=self.order,
            product=self.product,
            product_name=self.product.name,
            quantity=Decimal("10.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.23"),
            vat_rate=Decimal("23.00"),
        )
        line = DeliveryItem.objects.create(
            delivery_document=doc,
            order_item=oi,
            product=self.product,
            quantity_planned=Decimal("4.00"),
        )
        Invoice.objects.create(
            company=self.co,
            user=self.user,
            order=self.order,
            customer=self.customer,
            delivery_document=doc,
            issue_date=date(2026, 6, 1),
            sale_date=date(2026, 6, 1),
            due_date=date(2026, 6, 15),
            status=Invoice.STATUS_DRAFT,
        )
        self.client.force_authenticate(user=self.user)

        patch_r = self.client.patch(
            reverse("delivery-document-detail", kwargs={"uuid": str(doc.uuid)}),
            data={"driver_name": "X"},
            format="json",
        )
        self.assertEqual(patch_r.status_code, status.HTTP_400_BAD_REQUEST)

        sv = self.client.post(
            reverse("delivery-document-save", kwargs={"uuid": str(doc.uuid)}),
            data={},
            format="json",
        )
        self.assertEqual(sv.status_code, status.HTTP_400_BAD_REQUEST)

        ul = self.client.post(
            reverse("delivery-document-update-lines", kwargs={"uuid": str(doc.uuid)}),
            data={
                "items": [
                    {"id": str(line.uuid), "quantity_planned": "3.00"},
                ]
            },
            format="json",
        )
        self.assertEqual(ul.status_code, status.HTTP_400_BAD_REQUEST)

        del_r = self.client.delete(
            reverse("delivery-document-detail", kwargs={"uuid": str(doc.uuid)}),
        )
        self.assertEqual(del_r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_patch_allowed_after_draft_invoice_deleted(self):
        """Deleting the draft invoice removes the edit lock."""
        from apps.invoices.models import Invoice

        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
        )
        inv = Invoice.objects.create(
            company=self.co,
            user=self.user,
            order=self.order,
            customer=self.customer,
            delivery_document=d,
            issue_date=date(2026, 5, 1),
            sale_date=date(2026, 5, 1),
            due_date=date(2026, 5, 15),
            status=Invoice.STATUS_DRAFT,
        )

        blocked = self.client.patch(
            reverse("delivery-document-detail", kwargs={"uuid": str(d.uuid)}),
            data={"driver_name": "Locked"},
            format="json",
        )
        self.assertEqual(blocked.status_code, status.HTTP_400_BAD_REQUEST)

        inv.delete()

        freed = self.client.patch(
            reverse("delivery-document-detail", kwargs={"uuid": str(d.uuid)}),
            data={"driver_name": "Unlocked"},
            format="json",
        )
        self.assertEqual(freed.status_code, status.HTTP_200_OK)
        self.assertFalse(freed.data["locked_for_edit"])
        self.assertEqual(freed.data["driver_name"], "Unlocked")

    def test_start_and_complete_reject_when_locked(self):
        from apps.invoices.models import Invoice

        self.order.status = Order.STATUS_CONFIRMED
        self.order.save(update_fields=["status"])
        saved_doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            from_warehouse=self.wh,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 5),
            status=DeliveryDocument.STATUS_SAVED,
        )
        Invoice.objects.create(
            company=self.co,
            user=self.user,
            order=self.order,
            customer=self.customer,
            delivery_document=saved_doc,
            issue_date=date(2026, 6, 1),
            sale_date=date(2026, 6, 1),
            due_date=date(2026, 6, 15),
            status=Invoice.STATUS_DRAFT,
        )
        self.client.force_authenticate(user=self.user)

        rs = self.client.post(
            reverse("delivery-document-start-delivery", kwargs={"uuid": str(saved_doc.uuid)}),
            data={},
            format="json",
        )
        self.assertEqual(rs.status_code, status.HTTP_400_BAD_REQUEST)

        transit_doc = DeliveryDocument.objects.create(
            company=self.co,
            user=self.user,
            from_warehouse=self.wh,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 6),
            status=DeliveryDocument.STATUS_IN_TRANSIT,
        )
        order2 = self._confirmed_order_with_line()
        Invoice.objects.create(
            company=self.co,
            user=self.user,
            order=order2,
            customer=self.customer,
            delivery_document=transit_doc,
            issue_date=date(2026, 6, 2),
            sale_date=date(2026, 6, 2),
            due_date=date(2026, 6, 16),
            status=Invoice.STATUS_DRAFT,
        )

        rc = self.client.post(
            reverse("delivery-document-complete", kwargs={"uuid": str(transit_doc.uuid)}),
            data={},
            format="json",
        )
        self.assertEqual(rc.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_uses_issue_date_year_in_document_number(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-list"),
            data={
                "order_id": str(self.order.uuid),
                "document_type": DeliveryDocument.DOC_TYPE_WZ,
                "issue_date": "2025-12-01",
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_number"], "WZ/2025/0001")

    def _url_save(self, doc_id):
        return reverse("delivery-document-save", kwargs={"uuid": str(doc_id)})

    def _url_start_delivery(self, doc_id):
        return reverse("delivery-document-start-delivery", kwargs={"uuid": str(doc_id)})

    def _url_complete(self, doc_id):
        return reverse("delivery-document-complete", kwargs={"uuid": str(doc_id)})

    def _url_generate(self, order_id):
        return reverse(
            "delivery-document-generate-for-order",
            kwargs={"order_id": str(order_id)},
        )

    def _reserve_stock_for_order(self, order: Order, warehouse: Warehouse) -> None:
        """Mirror post-confirm stock: one ProductStock row per product with reservation."""
        pool = Decimal("100.00")
        by_product = {}
        for line in order.items.all():
            by_product[line.product_id] = by_product.get(line.product_id, Decimal("0")) + line.quantity
        for pid, reserved in by_product.items():
            ProductStock.objects.update_or_create(
                company_id=order.company_id,
                product_id=pid,
                warehouse=warehouse,
                defaults={
                    "quantity_available": pool - reserved,
                    "quantity_reserved": reserved,
                    "quantity_total": pool,
                },
            )

    def _confirmed_order_with_line(self, qty_delivered=Decimal("0.00")):
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 1),
            delivery_date=date(2026, 5, 15),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("4.00"),
            quantity_delivered=qty_delivered,
            unit_price_net=Decimal("10.00"),
            unit_price_gross=Decimal("12.30"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("0.00"),
        )
        self._reserve_stock_for_order(o, self.wh)
        return o

    def _confirmed_order_two_lines_same_product(self):
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 1),
            delivery_date=date(2026, 5, 15),
            status=Order.STATUS_CONFIRMED,
        )
        for qty in (Decimal("2.00"), Decimal("3.00")):
            OrderItem.objects.create(
                order=o,
                product=self.product,
                quantity=qty,
                unit_price_net=Decimal("10.00"),
                unit_price_gross=Decimal("12.30"),
                vat_rate=Decimal("23.00"),
                discount_percent=Decimal("0.00"),
            )
        self._reserve_stock_for_order(o, self.wh)
        return o

    def _confirmed_order_two_products(self, qty_a=Decimal("2.00"), qty_b=Decimal("3.00")):
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 1),
            delivery_date=date(2026, 5, 15),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=qty_a,
            unit_price_net=Decimal("10.00"),
            unit_price_gross=Decimal("12.30"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("0.00"),
        )
        OrderItem.objects.create(
            order=o,
            product=self.product_b,
            quantity=qty_b,
            unit_price_net=Decimal("5.00"),
            unit_price_gross=Decimal("6.00"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("0.00"),
        )
        self._reserve_stock_for_order(o, self.wh)
        return o

    def test_filter_by_order_status_issue_date_and_type(self):
        self.client.force_authenticate(user=self.user)
        d1 = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 1),
            status=DeliveryDocument.STATUS_DRAFT,
        )
        DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_MM,
            issue_date=date(2026, 1, 1),
            status=DeliveryDocument.STATUS_SAVED,
        )
        r = self.client.get(
            reverse("delivery-document-list"),
            {
                "order": str(self.order.uuid),
                "status": DeliveryDocument.STATUS_DRAFT,
                "document_type": DeliveryDocument.DOC_TYPE_WZ,
                "issue_date_after": "2026-05-01",
                "issue_date_before": "2026-06-30",
            },
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        ids = {row["id"] for row in r.data["results"]}
        self.assertEqual(ids, {str(d1.uuid)})

    def test_post_save_and_start_delivery_transitions(self):
        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            status=DeliveryDocument.STATUS_DRAFT,
        )
        r1 = self.client.post(self._url_save(d.uuid))
        self.assertEqual(r1.status_code, status.HTTP_200_OK)
        self.assertEqual(r1.data["status"], DeliveryDocument.STATUS_SAVED)
        r2 = self.client.post(self._url_start_delivery(d.uuid))
        self.assertEqual(r2.status_code, status.HTTP_200_OK)
        self.assertEqual(r2.data["status"], DeliveryDocument.STATUS_IN_TRANSIT)

    def test_post_save_wrong_status_returns_400(self):
        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            status=DeliveryDocument.STATUS_SAVED,
        )
        r = self.client.post(self._url_save(d.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_get_generate_for_order_creates_wz_with_lines(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        r = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_type"], DeliveryDocument.DOC_TYPE_WZ)
        self.assertEqual(r.data["status"], DeliveryDocument.STATUS_SAVED)
        self.assertEqual(str(r.data["from_warehouse_id"]), str(self.wh.uuid))
        self.assertEqual(len(r.data["items"]), 1)
        self.assertEqual(r.data["items"][0]["quantity_planned"], "4.00")
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertEqual(doc.order_id, o.id)
        self.assertEqual(doc.to_customer_id, o.customer_id)

    def test_get_generate_for_order_prefers_mobile_from_warehouse(self):
        """When a MOBILE warehouse exists, WZ `from_warehouse` is the van (not MG)."""
        wh_mobile = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MV",
            name="Van",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        r = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(str(r.data["from_warehouse_id"]), str(wh_mobile.uuid))

    def test_generate_for_order_requires_confirmed(self):
        self.client.force_authenticate(user=self.user)
        self.order.status = Order.STATUS_DRAFT
        self.order.save(update_fields=["status"])
        OrderItem.objects.create(
            order=self.order,
            product=self.product,
            quantity=Decimal("2.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.get(self._url_generate(self.order.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_generate_for_order_uses_remaining_quantity(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line(qty_delivered=Decimal("1.50"))
        r = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["items"][0]["quantity_planned"], "2.50")

    def _url_generate_batch(self):
        return reverse("delivery-document-generate-for-orders")

    def test_post_generate_for_orders_creates_one_wz_per_confirmed_order(self):
        self.client.force_authenticate(user=self.user)
        o1 = self._confirmed_order_with_line()
        o2 = self._confirmed_order_with_line()
        r = self.client.post(
            self._url_generate_batch(),
            data={"order_ids": [str(o2.uuid), str(o1.uuid)]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertIn("documents", r.data)
        self.assertEqual(len(r.data["documents"]), 2)
        nums = {row["document_number"] for row in r.data["documents"]}
        ids = {row["id"] for row in r.data["documents"]}
        self.assertEqual(len(nums), 2)
        self.assertEqual(len(ids), 2)
        self.assertEqual(DeliveryDocument.objects.filter(uuid__in=ids).count(), 2)

    def test_post_generate_for_orders_not_confirmed_returns_400_with_ids(self):
        self.client.force_authenticate(user=self.user)
        ok = self._confirmed_order_with_line()
        bad = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 1),
            delivery_date=date(2026, 5, 15),
            status=Order.STATUS_DRAFT,
        )
        OrderItem.objects.create(
            order=bad,
            product=self.product,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(
            self._url_generate_batch(),
            data={"order_ids": [str(ok.uuid), str(bad.uuid)]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertEqual(r.data["not_confirmed_order_ids"], [str(bad.uuid)])

    def test_post_generate_for_orders_other_company_order_returns_404(self):
        co_other = Company.objects.create(name="Foreign Co")
        cust_other = Customer.objects.create(name="Foreign", company=co_other)
        product_foreign = Product.objects.create(
            name="Foreign prod",
            company=co_other,
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
        )
        o_foreign = Order.objects.create(
            user=self.user,
            customer=cust_other,
            company=co_other,
            order_date=date(2026, 5, 1),
            delivery_date=date(2026, 5, 15),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=o_foreign,
            product=product_foreign,
            quantity=Decimal("2.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )

        self.client.force_authenticate(user=self.user)
        o_local = self._confirmed_order_with_line()
        r = self.client.post(
            self._url_generate_batch(),
            data={"order_ids": [str(o_local.uuid), str(o_foreign.uuid)]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND, r.data)
        self.assertIn(str(o_foreign.uuid), r.data["missing_order_ids"])

    def test_post_complete_updates_lines_and_order(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(gen.status_code, status.HTTP_201_CREATED)
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_id,
                        "quantity_actual": "3.00",
                        "quantity_returned": "1.00",
                        "return_reason": "Damaged",
                    }
                ],
                "receiver_name": "Client",
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["status"], DeliveryDocument.STATUS_DELIVERED)
        self.assertTrue(r.data["has_returns"])
        item = DeliveryItem.objects.get(uuid=line_id)
        self.assertEqual(item.quantity_actual, Decimal("3.00"))
        self.assertEqual(item.quantity_returned, Decimal("1.00"))
        oi = OrderItem.objects.get(order=o)
        self.assertEqual(oi.quantity_delivered, Decimal("2.00"))
        self.assertEqual(oi.quantity_returned, Decimal("1.00"))
        o.refresh_from_db()
        self.assertEqual(
            o.status,
            Order.STATUS_PARTIALLY_DELIVERED,
            "Partial delivery must set order status to partially_delivered.",
        )
        stock = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(stock.quantity_reserved, Decimal("1.00"))
        self.assertEqual(stock.quantity_available, Decimal("97.00"))
        self.assertEqual(stock.quantity_total, Decimal("98.00"))
        movements = StockMovement.objects.filter(reference_id=r.data["id"]).order_by(
            "movement_type"
        )
        self.assertEqual(movements.count(), 2)
        sale = movements.filter(movement_type=StockMovement.MovementType.SALE).get()
        self.assertEqual(sale.quantity, Decimal("-3"))
        self.assertEqual(sale.reference_type, "delivery")
        ret_m = movements.filter(movement_type=StockMovement.MovementType.RETURN).get()
        self.assertEqual(ret_m.quantity, Decimal("1"))
        self.assertEqual(ret_m.reference_type, "delivery")

    def test_post_complete_marks_order_delivered_when_fully_delivered(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(gen.status_code, status.HTTP_201_CREATED, gen.data)
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_id,
                        "quantity_actual": "4.00",
                        "quantity_returned": "0",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        o.refresh_from_db()
        self.assertEqual(o.status, Order.STATUS_DELIVERED)

    def test_post_start_delivery_wrong_status_returns_400(self):
        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            status=DeliveryDocument.STATUS_DRAFT,
        )
        r = self.client.post(self._url_start_delivery(d.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_post_complete_wrong_status_returns_400(self):
        self.client.force_authenticate(user=self.user)
        d = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            status=DeliveryDocument.STATUS_DRAFT,
        )
        r = self.client.post(self._url_complete(d.uuid), data={}, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_post_complete_twice_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        self.client.post(
            self._url_complete(doc_id),
            data={"items": [{"id": line_id, "quantity_actual": "2.00", "quantity_returned": "0"}]},
            format="json",
        )
        r2 = self.client.post(self._url_complete(doc_id), data={}, format="json")
        self.assertEqual(r2.status_code, status.HTTP_400_BAD_REQUEST)

    def test_post_complete_unknown_item_id_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={"items": [{"id": str(uuid.uuid4()), "quantity_actual": "1.00"}]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", r.data)

    def test_post_complete_returns_exceed_actual_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {"id": line_id, "quantity_actual": "2.00", "quantity_returned": "3.00"}
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_post_complete_exceeds_ordered_quantity_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [{"id": line_id, "quantity_actual": "5.00", "quantity_returned": "0"}]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_post_complete_insufficient_reserved_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        ProductStock.objects.filter(
            product=self.product, warehouse=self.wh
        ).update(quantity_reserved=Decimal("1.00"), quantity_available=Decimal("99.00"))
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_id,
                        "quantity_actual": "4.00",
                        "quantity_returned": "0",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        doc = DeliveryDocument.objects.get(uuid=doc_id)
        self.assertEqual(doc.status, DeliveryDocument.STATUS_IN_TRANSIT)

    def test_post_complete_sale_only_one_sale_movement_and_stock(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_id,
                        "quantity_actual": "4.00",
                        "quantity_returned": "0",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        stock = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        self.assertEqual(stock.quantity_available, Decimal("96.00"))
        self.assertEqual(stock.quantity_total, Decimal("96.00"))
        mov = StockMovement.objects.filter(reference_id=r.data["id"])
        self.assertEqual(mov.count(), 1)
        m = mov.get()
        self.assertEqual(m.movement_type, StockMovement.MovementType.SALE)
        self.assertEqual(m.quantity, Decimal("-4"))
        self.assertEqual(m.quantity_before, Decimal("96"))
        self.assertEqual(m.quantity_after, Decimal("96"))

    def test_post_complete_missing_productstock_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        ProductStock.objects.filter(
            product=self.product, warehouse=self.wh
        ).delete()
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_id,
                        "quantity_actual": "2.00",
                        "quantity_returned": "0",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        doc = DeliveryDocument.objects.get(uuid=doc_id)
        self.assertEqual(doc.status, DeliveryDocument.STATUS_IN_TRANSIT)

    def test_post_complete_without_from_warehouse_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        DeliveryDocument.objects.filter(uuid=doc_id).update(from_warehouse=None)
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_id,
                        "quantity_actual": "1.00",
                        "quantity_returned": "0",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("from_warehouse", r.data)
        doc = DeliveryDocument.objects.get(uuid=doc_id)
        self.assertEqual(doc.status, DeliveryDocument.STATUS_IN_TRANSIT)

    def test_post_complete_two_lines_same_product_two_sale_movements(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_two_lines_same_product()
        gen = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(gen.status_code, status.HTTP_201_CREATED, gen.data)
        self.assertEqual(len(gen.data["items"]), 2)
        doc_id = gen.data["id"]
        ids = [row["id"] for row in gen.data["items"]]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {"id": ids[0], "quantity_actual": "2.00", "quantity_returned": "0"},
                    {"id": ids[1], "quantity_actual": "3.00", "quantity_returned": "0"},
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        stock = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        self.assertEqual(stock.quantity_total, Decimal("95.00"))
        sales = StockMovement.objects.filter(
            reference_id=r.data["id"],
            movement_type=StockMovement.MovementType.SALE,
        )
        self.assertEqual(sales.count(), 2)
        self.assertEqual(
            {m.quantity for m in sales},
            {Decimal("-2"), Decimal("-3")},
        )

    def test_post_complete_two_distinct_products_updates_both_stocks(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_two_products()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_by_product = {
            str(row["product_id"]): row["id"] for row in gen.data["items"]
        }
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_by_product[str(self.product.uuid)],
                        "quantity_actual": "2.00",
                        "quantity_returned": "0",
                    },
                    {
                        "id": line_by_product[str(self.product_b.uuid)],
                        "quantity_actual": "3.00",
                        "quantity_returned": "0",
                    },
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        sa = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        sb = ProductStock.objects.get(product=self.product_b, warehouse=self.wh)
        self.assertEqual(sa.quantity_reserved, Decimal("0"))
        self.assertEqual(sa.quantity_total, Decimal("98.00"))
        self.assertEqual(sb.quantity_reserved, Decimal("0"))
        self.assertEqual(sb.quantity_total, Decimal("97.00"))
        self.assertEqual(
            StockMovement.objects.filter(
                reference_id=r.data["id"],
                movement_type=StockMovement.MovementType.SALE,
            ).count(),
            2,
        )

    def test_post_complete_two_products_one_short_rolls_back_all(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_two_products(Decimal("2.00"), Decimal("3.00"))
        ProductStock.objects.filter(product=self.product_b, warehouse=self.wh).update(
            quantity_reserved=Decimal("1.00"),
            quantity_available=Decimal("99.00"),
        )
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_by_product = {
            str(row["product_id"]): row["id"] for row in gen.data["items"]
        }
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {
                        "id": line_by_product[str(self.product.uuid)],
                        "quantity_actual": "2.00",
                        "quantity_returned": "0",
                    },
                    {
                        "id": line_by_product[str(self.product_b.uuid)],
                        "quantity_actual": "3.00",
                        "quantity_returned": "0",
                    },
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        doc = DeliveryDocument.objects.get(uuid=doc_id)
        self.assertEqual(doc.status, DeliveryDocument.STATUS_IN_TRANSIT)
        sa = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        sb = ProductStock.objects.get(product=self.product_b, warehouse=self.wh)
        self.assertEqual(sa.quantity_reserved, Decimal("2.00"))
        self.assertEqual(sb.quantity_reserved, Decimal("1.00"))
        self.assertFalse(
            StockMovement.objects.filter(reference_id=doc_id).exists()
        )

    def test_post_complete_second_wz_consumes_remaining_reserved(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen1 = self.client.get(self._url_generate(o.uuid))
        d1 = gen1.data["id"]
        l1 = gen1.data["items"][0]["id"]
        self.client.post(self._url_save(d1))
        self.client.post(self._url_start_delivery(d1))
        r1 = self.client.post(
            self._url_complete(d1),
            data={"items": [{"id": l1, "quantity_actual": "2.00", "quantity_returned": "0"}]},
            format="json",
        )
        self.assertEqual(r1.status_code, status.HTTP_200_OK, r1.data)
        stock_mid = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(stock_mid.quantity_reserved, Decimal("2.00"))
        gen2 = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(gen2.status_code, status.HTTP_201_CREATED, gen2.data)
        d2 = gen2.data["id"]
        l2 = gen2.data["items"][0]["id"]
        self.client.post(self._url_save(d2))
        self.client.post(self._url_start_delivery(d2))
        r2 = self.client.post(
            self._url_complete(d2),
            data={"items": [{"id": l2, "quantity_actual": "2.00", "quantity_returned": "0"}]},
            format="json",
        )
        self.assertEqual(r2.status_code, status.HTTP_200_OK, r2.data)
        stock_final = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(stock_final.quantity_reserved, Decimal("0"))
        self.assertEqual(stock_final.quantity_total, Decimal("96.00"))

    def test_post_complete_two_lines_same_product_insufficient_reserved_aggregate(
        self,
    ):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_two_lines_same_product()
        ProductStock.objects.filter(product=self.product, warehouse=self.wh).update(
            quantity_reserved=Decimal("2.00"),
            quantity_available=Decimal("98.00"),
        )
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        ids = [row["id"] for row in gen.data["items"]]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(
            self._url_complete(doc_id),
            data={
                "items": [
                    {"id": ids[0], "quantity_actual": "2.00", "quantity_returned": "0"},
                    {"id": ids[1], "quantity_actual": "3.00", "quantity_returned": "0"},
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        self.assertEqual(
            DeliveryDocument.objects.get(uuid=doc_id).status,
            DeliveryDocument.STATUS_IN_TRANSIT,
        )

    def test_post_complete_empty_items_uses_planned_quantities_for_stock(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        self.client.post(self._url_save(doc_id))
        self.client.post(self._url_start_delivery(doc_id))
        r = self.client.post(self._url_complete(doc_id), data={}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        stock = ProductStock.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        self.assertEqual(stock.quantity_total, Decimal("96.00"))
        self.assertEqual(
            StockMovement.objects.filter(
                reference_id=r.data["id"],
                movement_type=StockMovement.MovementType.SALE,
            ).count(),
            1,
        )

    def test_generate_no_remaining_quantity_returns_400(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line(qty_delivered=Decimal("4.00"))
        r = self.client.get(self._url_generate(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_generate_for_foreign_order_returns_404(self):
        self.client.force_authenticate(user=self.user)
        other_co = Company.objects.create(name="OutsiderCo")
        foreign_c = Customer.objects.create(name="Ext", company=other_co)
        foreign_p = Product.objects.create(
            name="Foreign SKU",
            company=other_co,
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
        )
        foreign_o = Order.objects.create(
            user=self.user,
            customer=foreign_c,
            company=other_co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 2, 1),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=foreign_o,
            product=foreign_p,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.get(self._url_generate(foreign_o.uuid))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_retrieve_includes_nested_items(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        r = self.client.get(
            reverse("delivery-document-detail", kwargs={"uuid": str(doc_id)})
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.data["items"]), 1)
        self.assertIn("quantity_planned", r.data["items"][0])
        self.assertEqual(r.data["order_number"], o.order_number)
        self.assertEqual(r.data["customer_name"], self.customer.name)

    def test_delete_document_allowed_and_removes_items(self):
        self.client.force_authenticate(user=self.user)
        o = self._confirmed_order_with_line()
        gen = self.client.get(self._url_generate(o.uuid))
        doc_id = gen.data["id"]
        line_id = gen.data["items"][0]["id"]
        r = self.client.delete(
            reverse("delivery-document-detail", kwargs={"uuid": str(doc_id)})
        )
        self.assertEqual(r.status_code, status.HTTP_204_NO_CONTENT)
        self.assertFalse(DeliveryItem.objects.filter(uuid=line_id).exists())

    def test_preview_returns_print_payload(self):
        self.client.force_authenticate(user=self.user)
        self.co.address = "ul. Firmowa 1"
        self.co.nip = "1234567890"
        self.co.save(update_fields=["address", "nip"])
        self.customer.company_name = "Klient SA"
        self.customer.nip = "0987654321"
        self.customer.street = "ul. Klienta 9"
        self.customer.save(update_fields=["company_name", "nip", "street"])
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 18),
            from_warehouse=self.wh,
            to_customer=self.customer,
            notes="Bring ID",
        )
        self.product.unit = "op."
        self.product.save(update_fields=["unit"])
        DeliveryItem.objects.create(
            delivery_document=doc,
            product=self.product,
            quantity_planned=Decimal("4.00"),
            quantity_actual=None,
            quantity_returned=Decimal("0"),
        )
        r = self.client.get(
            reverse("delivery-document-preview", kwargs={"uuid": str(doc.uuid)})
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertIn("document", r.data)
        self.assertEqual(r.data["company"]["name"], self.co.name)
        self.assertEqual(r.data["company"]["nip"], "1234567890")
        self.assertEqual(r.data["company"]["address"], "ul. Firmowa 1")
        self.assertEqual(r.data["customer"]["name"], "Klient SA")
        self.assertEqual(r.data["customer"]["nip"], "0987654321")
        self.assertEqual(r.data["customer"]["address"], "ul. Klienta 9")
        self.assertEqual(r.data["from_warehouse"]["name"], "Main")
        self.assertEqual(r.data["from_warehouse"]["code"], "MG")
        self.assertEqual(len(r.data["items"]), 1)
        row = r.data["items"][0]
        self.assertEqual(row["product_name"], "Line product")
        self.assertEqual(row["quantity_planned"], "4.00")
        self.assertIsNone(row["quantity_actual"])
        self.assertEqual(row["quantity_returned"], "0.00")
        self.assertEqual(row["unit"], "op.")
        d = r.data["document"]
        self.assertEqual(d["id"], str(doc.uuid))
        self.assertEqual(d["document_type"], "WZ")
        self.assertEqual(d["notes"], "Bring ID")
        self.assertEqual(d["from_warehouse"], str(self.wh.uuid))


class BuildDeliveryDocumentPreviewDataTests(TestCase):
    """Unit tests for `build_delivery_document_preview_data`."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="del-preview-build",
            email="del-preview-build@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(
            name="Co Preview",
            nip="1111111111",
            address="Addr 1",
        )
        CompanyMembership.objects.create(
            user=self.user,
            company=self.co,
            role="admin",
            is_active=True,
        )
        self.customer = Customer.objects.create(
            name="Osoba",
            company_name="Firma ABC",
            nip="2222222222",
            street="ul. Test 3",
            company=self.co,
        )
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status=Order.STATUS_DRAFT,
        )
        self.wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="WH1",
            name="Warehouse One",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.product = Product.objects.create(
            name="SKU-X",
            company=self.co,
            unit="kg",
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
        )

    def test_document_block_contains_all_delivery_fields(self):
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 12),
            from_warehouse=self.wh,
            to_customer=self.customer,
            status=DeliveryDocument.STATUS_SAVED,
            driver_name="Kierowca",
        )
        expected_keys = {
            "id",
            "company",
            "order",
            "user",
            "document_type",
            "document_number",
            "issue_date",
            "from_warehouse",
            "to_warehouse",
            "to_customer",
            "status",
            "has_returns",
            "returns_notes",
            "driver_name",
            "receiver_name",
            "delivered_at",
            "notes",
            "created_at",
            "updated_at",
        }
        data = build_delivery_document_preview_data(doc)
        self.assertTrue(expected_keys.issubset(data["document"].keys()))
        self.assertEqual(data["document"]["company"], str(self.co.uuid))
        self.assertEqual(data["document"]["order"], str(self.order.uuid))
        self.assertEqual(data["document"]["from_warehouse"], str(self.wh.uuid))
        self.assertEqual(data["document"]["driver_name"], "Kierowca")
        self.assertIsNone(data["document"]["to_warehouse"])
        self.assertIsNone(data["document"]["delivered_at"])

    def test_customer_from_order_when_to_customer_not_set(self):
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            to_customer=None,
        )
        data = build_delivery_document_preview_data(doc)
        self.assertEqual(data["customer"]["name"], "Firma ABC")
        self.assertEqual(data["customer"]["nip"], "2222222222")
        self.assertEqual(data["customer"]["address"], "ul. Test 3")

    def test_mm_without_order_or_customer_has_empty_customer_party(self):
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=None,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_MM,
            issue_date=date(2026, 4, 1),
            to_customer=None,
        )
        data = build_delivery_document_preview_data(doc)
        self.assertEqual(data["customer"]["name"], "")
        self.assertEqual(data["document"]["order"], None)

    def test_from_warehouse_null_in_payload_when_unset(self):
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
            from_warehouse=None,
        )
        data = build_delivery_document_preview_data(doc)
        self.assertIsNone(data["from_warehouse"])
        self.assertIsNone(data["document"]["from_warehouse"])

    def test_items_include_quantities_and_unit(self):
        doc = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 4, 1),
        )
        DeliveryItem.objects.create(
            delivery_document=doc,
            product=self.product,
            quantity_planned=Decimal("2.50"),
            quantity_actual=Decimal("2.00"),
            quantity_returned=Decimal("0.25"),
        )
        data = build_delivery_document_preview_data(doc)
        self.assertEqual(len(data["items"]), 1)
        row = data["items"][0]
        self.assertEqual(row["product_name"], "SKU-X")
        self.assertEqual(row["quantity_planned"], "2.50")
        self.assertEqual(row["quantity_actual"], "2.00")
        self.assertEqual(row["quantity_returned"], "0.25")
        self.assertEqual(row["unit"], "kg")


class GenerateDeliveryFromOrderTests(TestCase):
    """``generate_delivery_from_order()`` — WZ from confirmed order (full line quantities)."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="gen-from-order-user",
            email="gen-from-order@test.com",
            password="test12345",
        )
        self.company = Company.objects.create(name="Gen Co")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.company,
            role="admin",
            is_active=True,
        )
        self.customer = Customer.objects.create(name="Buyer", company=self.company)
        self.p1 = Product.objects.create(
            name="A",
            company=self.company,
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
        )
        self.p2 = Product.objects.create(
            name="B",
            company=self.company,
            price_net=Decimal("2.00"),
            price_gross=Decimal("2.00"),
        )

    def test_creates_wz_linked_to_order_and_sets_user(self):
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("4.00"),
            quantity_delivered=Decimal("1.50"),
            unit_price_net=Decimal("10.00"),
            unit_price_gross=Decimal("12.30"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("0.00"),
        )
        doc = generate_delivery_from_order(order, user=self.user)
        self.assertIsInstance(doc, DeliveryDocument)
        self.assertEqual(doc.document_type, DeliveryDocument.DOC_TYPE_WZ)
        self.assertEqual(doc.status, DeliveryDocument.STATUS_DRAFT)
        self.assertEqual(doc.order_id, order.id)
        self.assertEqual(doc.company_id, order.company_id)
        self.assertEqual(doc.user_id, self.user.id)
        self.assertEqual(doc.to_customer_id, order.customer_id)
        self.assertTrue(doc.document_number.startswith("WZ/"))
        line = doc.items.get()
        self.assertEqual(line.quantity_planned, Decimal("4.00"))
        self.assertEqual(line.order_item.product_id, self.p1.id)

    def test_one_delivery_item_per_order_item_full_quantity(self):
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("2.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        OrderItem.objects.create(
            order=order,
            product=self.p2,
            quantity=Decimal("3.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        doc = generate_delivery_from_order(order)
        self.assertEqual(doc.items.count(), 2)
        planned = sorted(doc.items.values_list("quantity_planned", flat=True))
        self.assertEqual(planned, [Decimal("2.00"), Decimal("3.00")])

    def test_requires_confirmed_order(self):
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_DRAFT,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        with self.assertRaises(ValueError):
            generate_delivery_from_order(order)

    def test_sets_from_warehouse_when_main_warehouse_exists(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.company,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        doc = generate_delivery_from_order(order)
        self.assertEqual(doc.from_warehouse_id, wh.id)

    def test_prefers_mobile_warehouse_over_main(self):
        Warehouse.objects.create(
            user=self.user,
            company=self.company,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        wh_mobile = Warehouse.objects.create(
            user=self.user,
            company=self.company,
            code="MV",
            name="Van",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        doc = generate_delivery_from_order(order)
        self.assertEqual(doc.from_warehouse_id, wh_mobile.id)

    def test_sets_from_warehouse_mobile_when_mobile_exists_without_main(self):
        """Active mobile warehouse is used even if the company has no MAIN warehouse."""
        wh_mobile = Warehouse.objects.create(
            user=self.user,
            company=self.company,
            code="MV",
            name="Van",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        doc = generate_delivery_from_order(order)
        self.assertEqual(doc.from_warehouse_id, wh_mobile.id)

    def test_from_warehouse_none_when_no_main_warehouse(self):
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=order,
            product=self.p1,
            quantity=Decimal("1.00"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        doc = generate_delivery_from_order(order)
        self.assertIsNone(doc.from_warehouse_id)

    def test_empty_order_creates_document_without_items(self):
        order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 7, 1),
            delivery_date=date(2026, 7, 10),
            status=Order.STATUS_CONFIRMED,
        )
        doc = generate_delivery_from_order(order)
        self.assertEqual(doc.items.count(), 0)


class VanLoadingAPITests(TestCase):
    """POST /api/delivery/van-loading/ — MM main→mobile and stock transfer."""

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="van-load-user",
            email="van-load@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Van Co")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.co,
            role="admin",
            is_active=True,
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)
        self.wh_main = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.wh_van = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MV1",
            name="Van 1",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        self.product = Product.objects.create(
            name="Stocked item",
            company=self.co,
            price_net=Decimal("10.00"),
            price_gross=Decimal("12.30"),
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=self.wh_main,
            quantity_available=Decimal("100.00"),
            quantity_reserved=Decimal("0.00"),
        )

    def test_van_loading_creates_mm_and_moves_stock(self):
        self.client.force_authenticate(user=self.user)
        url = reverse("delivery-document-van-loading")
        r = self.client.post(
            url,
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [
                    {"product_id": str(self.product.uuid), "quantity": "4.50"},
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_type"], DeliveryDocument.DOC_TYPE_MM)
        self.assertEqual(r.data["status"], DeliveryDocument.STATUS_SAVED)
        self.assertTrue(
            r.data.get("document_number"),
            msg="Van-loading response must include assigned MM document_number for the client success screen.",
        )
        self.assertIsNone(r.data["order_id"])
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertEqual(doc.items.count(), 1)
        line = doc.items.first()
        self.assertIsNone(line.order_item_id)
        self.assertEqual(line.quantity_planned, Decimal("4.50"))
        self.assertEqual(r.data["items"][0]["product_name"], self.product.name)

        main = ProductStock.objects.get(
            product=self.product, warehouse=self.wh_main
        )
        van = ProductStock.objects.get(
            product=self.product, warehouse=self.wh_van
        )
        self.assertEqual(main.quantity_available, Decimal("95.50"))
        self.assertEqual(van.quantity_available, Decimal("4.50"))

        moves = StockMovement.objects.filter(reference_id=doc.uuid).order_by("created_at")
        self.assertEqual(moves.count(), 2)
        self.assertEqual(moves[0].movement_type, StockMovement.MovementType.TRANSFER)
        self.assertEqual(moves[0].quantity, Decimal("-4.50"))
        self.assertEqual(moves[1].quantity, Decimal("4.50"))

    def test_van_loading_consumes_reserved_when_available_insufficient(self):
        """MG reserved stock is still physical on the shelf — van load may consume it."""
        ps = ProductStock.objects.get(product=self.product, warehouse=self.wh_main)
        ps.quantity_available = Decimal("10.00")
        ps.quantity_reserved = Decimal("90.00")
        ps.save(update_fields=["quantity_available", "quantity_reserved"])
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "90"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        main = ProductStock.objects.get(product=self.product, warehouse=self.wh_main)
        van = ProductStock.objects.get(product=self.product, warehouse=self.wh_van)
        self.assertEqual(main.quantity_available, Decimal("0.00"))
        self.assertEqual(main.quantity_reserved, Decimal("10.00"))
        self.assertEqual(van.quantity_available, Decimal("90.00"))

        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        mv_out = StockMovement.objects.filter(
            warehouse=self.wh_main, reference_id=doc.uuid
        ).get()
        self.assertEqual(mv_out.quantity_before, Decimal("100.00"))
        self.assertEqual(mv_out.quantity_after, Decimal("10.00"))

    def test_van_loading_rejects_non_main_source(self):
        wh_other = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="XX",
            name="Other",
            warehouse_type=Warehouse.WarehouseType.EXTERNAL,
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(wh_other.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "1"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("from_warehouse_id", r.data)

    def test_van_loading_requires_authentication(self):
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_van_loading_forbidden_without_current_company(self):
        u = get_user_model().objects.create_user(
            username="van-no-cc",
            email="van-no-cc@test.com",
            password="x",
        )
        CompanyMembership.objects.create(
            user=u, company=self.co, role="viewer", is_active=True
        )
        self.client.force_authenticate(user=u)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "1"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_van_loading_rejects_non_mobile_destination(self):
        wh_main2 = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG2",
            name="Main 2",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(wh_main2.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "1"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("to_warehouse_id", r.data)

    def test_van_loading_rejects_same_from_and_to(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_main.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "1"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_van_loading_insufficient_stock_returns_400(self):
        ps = ProductStock.objects.get(
            product=self.product, warehouse=self.wh_main
        )
        ps.quantity_available = Decimal("2.00")
        ps.save(update_fields=["quantity_available"])
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "5"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("stock", r.data)
        self.assertFalse(
            DeliveryDocument.objects.filter(document_type=DeliveryDocument.DOC_TYPE_MM).exists()
        )

    def test_van_loading_duplicate_product_in_items_returns_400(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [
                    {"product_id": str(self.product.uuid), "quantity": "1"},
                    {"product_id": str(self.product.uuid), "quantity": "2"},
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("items", r.data)

    def test_van_loading_unknown_product_returns_400(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [{"product_id": str(uuid.uuid4()), "quantity": "1"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("items", r.data)

    def test_van_loading_empty_items_returns_400(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(self.wh_main.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("items", r.data)

    def test_van_loading_foreign_warehouse_returns_404(self):
        other = Company.objects.create(name="Foreign van co")
        foreign_wh = Warehouse.objects.create(
            user=self.user,
            company=other,
            code="FX",
            name="Foreign",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            reverse("delivery-document-van-loading"),
            data={
                "from_warehouse_id": str(foreign_wh.uuid),
                "to_warehouse_id": str(self.wh_van.uuid),
                "items": [{"product_id": str(self.product.uuid), "quantity": "1"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


class VanReconciliationAPITests(TestCase):
    """POST /api/delivery/van-reconciliation/{van_warehouse_id}/"""

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="van-rec-user",
            email="van-rec@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Rec Co")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.co,
            role="admin",
            is_active=True,
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)
        self.wh_main = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG-R",
            name="Main Rec",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.wh_van = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MV1",
            name="Van",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        self.p1 = Product.objects.create(
            name="P1",
            company=self.co,
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
        )
        self.p2 = Product.objects.create(
            name="P2",
            company=self.co,
            price_net=Decimal("2.00"),
            price_gross=Decimal("2.00"),
        )

    def _url(self):
        return reverse(
            "delivery-document-van-reconciliation",
            kwargs={"van_warehouse_id": str(self.wh_van.uuid)},
        )

    def test_reconciliation_shrinkage_records_damage(self):
        ProductStock.objects.create(
            company=self.co,
            product=self.p1,
            warehouse=self.wh_van,
            quantity_available=Decimal("10.00"),
            quantity_reserved=Decimal("0.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "8.00",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["items_processed"], 1)
        self.assertEqual(len(r.data["discrepancies"]), 1)
        d0 = r.data["discrepancies"][0]
        self.assertEqual(d0["discrepancy_type"], "damage")
        self.assertEqual(d0["quantity_expected"], "10.00")
        self.assertEqual(d0["quantity_actual"], "8.00")
        self.assertEqual(d0["quantity_delta"], "-2.00")

        # After MM-P return + discrepancy zeroing, van stock is fully cleared.
        st = ProductStock.objects.get(product=self.p1, warehouse=self.wh_van)
        self.assertEqual(st.quantity_available, Decimal("0.00"))

        mv = StockMovement.objects.get(
            product=self.p1,
            warehouse=self.wh_van,
            movement_type=StockMovement.MovementType.DAMAGE,
        )
        self.assertEqual(mv.quantity, Decimal("-2.00"))
        self.assertEqual(mv.quantity_before, Decimal("10.00"))
        self.assertEqual(mv.quantity_after, Decimal("8.00"))

    def test_reconciliation_overage_records_adjustment(self):
        ProductStock.objects.create(
            company=self.co,
            product=self.p1,
            warehouse=self.wh_van,
            quantity_available=Decimal("5.00"),
            quantity_reserved=Decimal("0.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "7.50",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["discrepancies"][0]["discrepancy_type"], "adjustment")
        self.assertEqual(r.data["discrepancies"][0]["quantity_delta"], "2.50")

        # After MM-P return + discrepancy zeroing, van stock is fully cleared.
        st = ProductStock.objects.get(product=self.p1, warehouse=self.wh_van)
        self.assertEqual(st.quantity_available, Decimal("0.00"))
        mv = StockMovement.objects.get(
            product=self.p1,
            warehouse=self.wh_van,
            movement_type=StockMovement.MovementType.ADJUSTMENT,
        )
        self.assertEqual(mv.quantity, Decimal("2.50"))

    def test_reconciliation_no_discrepancy_no_movement(self):
        ProductStock.objects.create(
            company=self.co,
            product=self.p1,
            warehouse=self.wh_van,
            quantity_available=Decimal("4.00"),
            quantity_reserved=Decimal("0.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "4.00",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["discrepancies"], [])
        # MM-P always returns remaining goods to main warehouse (2 TRANSFER movements: van out + main in).
        transfer_mvs = StockMovement.objects.filter(
            product=self.p1, movement_type=StockMovement.MovementType.TRANSFER
        )
        self.assertEqual(transfer_mvs.count(), 2)
        self.assertFalse(
            StockMovement.objects.filter(
                product=self.p1, movement_type=StockMovement.MovementType.DAMAGE
            ).exists()
        )

    def test_reconciliation_rejects_non_mobile_warehouse(self):
        wh_main = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.client.force_authenticate(user=self.user)
        url = reverse(
            "delivery-document-van-reconciliation",
            kwargs={"van_warehouse_id": str(wh_main.uuid)},
        )
        r = self.client.post(
            url,
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "1",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("van_warehouse_id", r.data)

    def test_reconciliation_empty_items(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={"items": []},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["items_processed"], 0)
        self.assertEqual(r.data["discrepancies"], [])
        self.assertIsNone(r.data["reconciliation_id"])

    def test_reconciliation_requires_auth(self):
        r = self.client.post(self._url(), data={"items": []}, format="json")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_reconciliation_duplicate_product_returns_400(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "1",
                    },
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "2",
                    },
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("items", r.data)

    def test_reconciliation_unknown_product_returns_400(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(uuid.uuid4()),
                        "quantity_actual_remaining": "1",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("items", r.data)

    def test_reconciliation_foreign_warehouse_returns_404(self):
        other = Company.objects.create(name="Other rec")
        foreign_van = Warehouse.objects.create(
            user=self.user,
            company=other,
            code="FV",
            name="Foreign van",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        self.client.force_authenticate(user=self.user)
        url = reverse(
            "delivery-document-van-reconciliation",
            kwargs={"van_warehouse_id": str(foreign_van.uuid)},
        )
        r = self.client.post(
            url,
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "1",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_reconciliation_forbidden_without_current_company(self):
        u = get_user_model().objects.create_user(
            username="rec-no-cc",
            email="rec-no-cc@test.com",
            password="x",
        )
        CompanyMembership.objects.create(
            user=u, company=self.co, role="viewer", is_active=True
        )
        self.client.force_authenticate(user=u)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "0",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_reconciliation_multiple_products_mixed(self):
        ProductStock.objects.create(
            company=self.co,
            product=self.p1,
            warehouse=self.wh_van,
            quantity_available=Decimal("10.00"),
            quantity_reserved=Decimal("0.00"),
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.p2,
            warehouse=self.wh_van,
            quantity_available=Decimal("3.00"),
            quantity_reserved=Decimal("0.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "8.00",
                    },
                    {
                        "product_id": str(self.p2.uuid),
                        "quantity_actual_remaining": "3.00",
                    },
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["items_processed"], 2)
        self.assertEqual(len(r.data["discrepancies"]), 1)
        self.assertEqual(r.data["discrepancies"][0]["product_id"], str(self.p1.uuid))
        self.assertEqual(r.data["discrepancies"][0]["discrepancy_type"], "damage")

        rid = r.data["reconciliation_id"]
        ref = uuid.UUID(rid)
        ids = set(
            StockMovement.objects.filter(reference_id=ref).values_list(
                "product_id", flat=True
            )
        )
        self.assertEqual(ids, {self.p1.id})

    def test_reconciliation_no_prior_stock_row_adjustment(self):
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "5.25",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(
            Decimal(r.data["discrepancies"][0]["quantity_expected"]),
            Decimal("0"),
        )
        self.assertEqual(r.data["discrepancies"][0]["discrepancy_type"], "adjustment")
        # After MM-P return + discrepancy zeroing, van stock is fully cleared.
        st = ProductStock.objects.get(product=self.p1, warehouse=self.wh_van)
        self.assertEqual(st.quantity_available, Decimal("0.00"))
        self.assertEqual(st.quantity_total, Decimal("0.00"))

    def test_reconciliation_expected_includes_reserved_shrinkage(self):
        ProductStock.objects.create(
            company=self.co,
            product=self.p1,
            warehouse=self.wh_van,
            quantity_available=Decimal("4.00"),
            quantity_reserved=Decimal("6.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "8.00",
                    }
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["discrepancies"][0]["quantity_expected"], "10.00")
        self.assertEqual(r.data["discrepancies"][0]["quantity_delta"], "-2.00")
        # After MM-P return + discrepancy zeroing, van stock is fully cleared.
        st = ProductStock.objects.get(product=self.p1, warehouse=self.wh_van)
        self.assertEqual(st.quantity_reserved, Decimal("0.00"))
        self.assertEqual(st.quantity_available, Decimal("0.00"))
        self.assertEqual(st.quantity_total, Decimal("0.00"))

    def test_reconciliation_batch_same_reference_id_all_movements(self):
        ProductStock.objects.create(
            company=self.co,
            product=self.p1,
            warehouse=self.wh_van,
            quantity_available=Decimal("10.00"),
            quantity_reserved=Decimal("0.00"),
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.p2,
            warehouse=self.wh_van,
            quantity_available=Decimal("5.00"),
            quantity_reserved=Decimal("0.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url(),
            data={
                "items": [
                    {
                        "product_id": str(self.p1.uuid),
                        "quantity_actual_remaining": "9.00",
                    },
                    {
                        "product_id": str(self.p2.uuid),
                        "quantity_actual_remaining": "3.00",
                    },
                ]
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(len(r.data["discrepancies"]), 2)
        ref = uuid.UUID(r.data["reconciliation_id"])
        counts = StockMovement.objects.filter(
            reference_type="van_reconciliation",
            reference_id=ref,
        ).count()
        self.assertEqual(counts, 2)


class PZFlowAPITests(TestCase):
    """End-to-end PZ flow: create-pz → complete → stock credited."""

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="pz-flow-user",
            email="pz-flow@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="PZ Tenant")
        CompanyMembership.objects.create(
            user=self.user, company=self.co, role="admin", is_active=True
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])

        # Enable delivery + purchasing modules
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="purchasing", is_enabled=True)

        self.wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG-PZ",
            name="Main PZ",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.product = Product.objects.create(
            name="PZ Widget",
            company=self.co,
            price_net=Decimal("10.00"),
            price_gross=Decimal("12.30"),
        )
        self.supplier = Supplier.objects.create(
            company=self.co,
            name="Dostawca Testowy",
            nip="1234567890",
        )
        self.client.force_authenticate(user=self.user)

    # ── create-pz ──────────────────────────────────────────────────

    def test_create_pz_returns_201_with_draft_document(self):
        r = self.client.post("/api/delivery/create-pz/", {
            "to_warehouse_id": str(self.wh.uuid),
            "from_supplier_id": str(self.supplier.uuid),
            "issue_date": "2026-05-29",
            "items": [
                {"product_id": str(self.product.uuid), "quantity_planned": "10.00", "unit_cost": "5.50"},
            ],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_type"], "PZ")
        self.assertEqual(r.data["status"], "draft")
        self.assertTrue(r.data["document_number"].startswith("PZ/2026/"))
        self.assertEqual(len(r.data["items"]), 1)
        self.assertEqual(Decimal(r.data["items"][0]["quantity_planned"]), Decimal("10.00"))
        self.assertEqual(Decimal(r.data["items"][0]["unit_cost"]), Decimal("5.5000"))

    def test_create_pz_without_supplier_is_allowed(self):
        r = self.client.post("/api/delivery/create-pz/", {
            "to_warehouse_id": str(self.wh.uuid),
            "items": [{"product_id": str(self.product.uuid), "quantity_planned": "5.00"}],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertIsNone(r.data["from_supplier_id"])

    def test_create_pz_requires_to_warehouse(self):
        r = self.client.post("/api/delivery/create-pz/", {
            "items": [{"product_id": str(self.product.uuid), "quantity_planned": "5.00"}],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_pz_requires_items(self):
        r = self.client.post("/api/delivery/create-pz/", {
            "to_warehouse_id": str(self.wh.uuid),
            "items": [],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_create_pz_supplier_name_visible_in_response(self):
        r = self.client.post("/api/delivery/create-pz/", {
            "to_warehouse_id": str(self.wh.uuid),
            "from_supplier_id": str(self.supplier.uuid),
            "items": [{"product_id": str(self.product.uuid), "quantity_planned": "3.00"}],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["supplier_name"], self.supplier.name)

    # ── complete (receipt) ──────────────────────────────────────────

    def _create_pz(self, qty="10.00", unit_cost="5.50"):
        """Helper: create a draft PZ and return its id."""
        r = self.client.post("/api/delivery/create-pz/", {
            "to_warehouse_id": str(self.wh.uuid),
            "from_supplier_id": str(self.supplier.uuid),
            "items": [
                {"product_id": str(self.product.uuid), "quantity_planned": qty, "unit_cost": unit_cost},
            ],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        return r.data["id"]

    def test_complete_pz_changes_status_to_delivered(self):
        pz_id = self._create_pz()
        r = self.client.post(f"/api/delivery/{pz_id}/complete/", {}, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["status"], "delivered")
        self.assertIsNotNone(r.data["delivered_at"])

    def test_complete_pz_credits_stock_to_to_warehouse(self):
        qty = Decimal("10.00")
        pz_id = self._create_pz(qty=str(qty))
        self.client.post(f"/api/delivery/{pz_id}/complete/", {}, format="json")

        stock = ProductStock.objects.get(
            company=self.co,
            product=self.product,
            warehouse=self.wh,
        )
        self.assertEqual(stock.quantity_available, qty)
        self.assertEqual(stock.quantity_total, qty)

    def test_complete_pz_creates_purchase_stock_movement(self):
        pz_id = self._create_pz(qty="7.00")
        doc_id = uuid.UUID(pz_id)
        self.client.post(f"/api/delivery/{pz_id}/complete/", {}, format="json")

        mv = StockMovement.objects.filter(
            company=self.co,
            product=self.product,
            warehouse=self.wh,
            movement_type=StockMovement.MovementType.PURCHASE,
            reference_type="delivery_document",
            reference_id=doc_id,
        )
        self.assertEqual(mv.count(), 1)
        self.assertEqual(mv.first().quantity, Decimal("7.00"))

    def test_complete_pz_twice_returns_400(self):
        pz_id = self._create_pz()
        self.client.post(f"/api/delivery/{pz_id}/complete/", {}, format="json")
        r2 = self.client.post(f"/api/delivery/{pz_id}/complete/", {}, format="json")
        self.assertEqual(r2.status_code, status.HTTP_400_BAD_REQUEST)

    def test_complete_pz_with_quantity_actual_override(self):
        """Caller supplies quantity_actual for items; stock reflects actual not planned."""
        pz_id = self._create_pz(qty="10.00")
        doc = DeliveryDocument.objects.get(uuid=pz_id)
        item = doc.items.first()
        r = self.client.post(f"/api/delivery/{pz_id}/complete/", {
            "items": [{"id": str(item.uuid), "quantity_actual": "8.00"}],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)

        stock = ProductStock.objects.get(
            company=self.co, product=self.product, warehouse=self.wh
        )
        # apply_pz_receipt uses quantity_actual when set
        self.assertEqual(stock.quantity_available, Decimal("8.00"))

    def test_complete_pz_accumulates_stock_on_second_pz(self):
        """Two PZ documents for the same product stack the stock."""
        pz1 = self._create_pz(qty="5.00")
        pz2 = self._create_pz(qty="3.00")
        self.client.post(f"/api/delivery/{pz1}/complete/", {}, format="json")
        self.client.post(f"/api/delivery/{pz2}/complete/", {}, format="json")

        stock = ProductStock.objects.get(
            company=self.co, product=self.product, warehouse=self.wh
        )
        self.assertEqual(stock.quantity_available, Decimal("8.00"))


# ── New tests for workflow guard fixes ────────────────────────────────────────


class CreateZwFromPendingReturnsGuardTests(TestCase):
    """create_zw_from_pending_returns: order_item FK propagation and Level 3 return guard."""

    def setUp(self):
        from apps.delivery.services import create_zw_from_pending_returns
        self._service = create_zw_from_pending_returns

        User = get_user_model()
        self.user = User.objects.create_user(
            username="zw-guard-user",
            email="zw-guard@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="ZW Guard Co")
        CompanyMembership.objects.create(user=self.user, company=self.co, role="admin", is_active=True)
        self.customer = Customer.objects.create(name="Cust ZW", company=self.co)
        self.product = Product.objects.create(
            name="Bread",
            company=self.co,
            price_net=Decimal("2.00"),
            price_gross=Decimal("2.46"),
        )
        self.wh_van = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="VAN-ZW",
            name="Van ZW",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 6, 1),
            delivery_date=date(2026, 6, 4),
            status=Order.STATUS_CONFIRMED,
        )
        self.order_item = OrderItem.objects.create(
            order=self.order,
            product=self.product,
            quantity=Decimal("10.00"),
            unit_price_net=Decimal("2.00"),
            unit_price_gross=Decimal("2.46"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("0.00"),
        )
        self.wz = DeliveryDocument.objects.create(
            company=self.co,
            order=self.order,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 4),
            from_warehouse=self.wh_van,
            to_customer=self.customer,
            status=DeliveryDocument.STATUS_DELIVERED,
        )
        self.wz_item = DeliveryItem.objects.create(
            delivery_document=self.wz,
            order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("5.00"),
            quantity_actual=Decimal("5.00"),
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=self.wh_van,
            quantity_available=Decimal("20.00"),
            quantity_reserved=Decimal("0.00"),
        )

    def _zw(self, qty):
        return self._service(
            wz_doc=self.wz,
            return_items=[{"product_id": str(self.product.uuid), "quantity": str(qty)}],
            user=self.user,
        )

    # ── order_item FK propagation ─────────────────────────────────────────────

    def test_zw_item_inherits_order_item_fk_from_wz_item(self):
        zw = self._zw("3.00")
        self.assertEqual(zw.items.first().order_item_id, self.order_item.id)

    def test_zw_item_order_item_is_none_when_wz_item_has_no_order_item(self):
        self.wz_item.order_item = None
        self.wz_item.save(update_fields=["order_item"])
        zw = self._zw("2.00")
        self.assertIsNone(zw.items.first().order_item_id)

    # ── Level 3 guard ─────────────────────────────────────────────────────────

    def test_guard_blocks_return_exceeding_quantity_actual(self):
        from rest_framework.exceptions import ValidationError as DRFVal
        with self.assertRaises(DRFVal):
            self._zw("6.00")  # quantity_actual = 5

    def test_guard_allows_return_equal_to_quantity_actual(self):
        zw = self._zw("5.00")
        self.assertEqual(Decimal(zw.items.first().quantity_actual), Decimal("5.00"))

    def test_guard_blocks_second_zw_that_exceeds_remaining(self):
        from rest_framework.exceptions import ValidationError as DRFVal
        self._zw("3.00")  # first return OK (3 of 5)
        with self.assertRaises(DRFVal):
            self._zw("3.00")  # second: 3 more but only 2 remaining

    def test_guard_allows_second_zw_within_remaining(self):
        self._zw("3.00")
        zw2 = self._zw("2.00")  # exactly the 2 remaining
        self.assertEqual(Decimal(zw2.items.first().quantity_actual), Decimal("2.00"))

    def test_guard_uses_quantity_planned_when_actual_not_set(self):
        """Before WZ is completed, quantity_actual is None — guard falls back to quantity_planned."""
        from rest_framework.exceptions import ValidationError as DRFVal
        self.wz_item.quantity_actual = None
        self.wz_item.save(update_fields=["quantity_actual"])
        with self.assertRaises(DRFVal):
            self._zw("6.00")  # quantity_planned = 5


class GenerateForOrderVanRouteAutoTests(TestCase):
    """generate-for-order auto-links van_route when order is on exactly one active route."""

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="gen-van-auto-user",
            email="gen-van-auto@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="VanAuto Co")
        CompanyMembership.objects.create(user=self.user, company=self.co, role="admin", is_active=True)
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)
        self.customer = Customer.objects.create(name="CA", company=self.co)
        self.product = Product.objects.create(
            name="PA",
            company=self.co,
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
        )
        self.wh_main = Warehouse.objects.create(
            user=self.user, company=self.co, code="MG-A", name="Main A",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.wh_van = Warehouse.objects.create(
            user=self.user, company=self.co, code="VAN-A", name="Van A",
            warehouse_type=Warehouse.WarehouseType.MOBILE,
        )
        self.order = Order.objects.create(
            user=self.user, customer=self.customer, company=self.co,
            order_date=date(2026, 6, 1), delivery_date=date(2026, 6, 4),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=self.order, product=self.product, quantity=Decimal("5.00"),
            unit_price_net=Decimal("1.00"), unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"), discount_percent=Decimal("0.00"),
        )
        self.client.force_authenticate(user=self.user)

    def _make_route(self, route_status="planned"):
        from apps.van_routes.models import VanRoute
        return VanRoute.objects.create(
            company=self.co,
            date=date(2026, 6, 4),
            van_warehouse=self.wh_van,
            main_warehouse=self.wh_main,
            status=route_status,
        )

    def _url(self):
        return reverse(
            "delivery-document-generate-for-order",
            kwargs={"order_id": str(self.order.uuid)},
        )

    def test_auto_links_van_route_when_order_on_one_active_route(self):
        route = self._make_route()
        route.orders.add(self.order)
        r = self.client.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertEqual(doc.van_route_id, route.id)
        self.assertEqual(doc.from_warehouse_id, self.wh_van.id)

    def test_no_van_route_when_order_not_on_any_route(self):
        r = self.client.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertIsNone(doc.van_route_id)

    def test_no_auto_link_when_order_on_two_active_routes(self):
        route1 = self._make_route()
        route2 = self._make_route()
        route1.orders.add(self.order)
        route2.orders.add(self.order)
        r = self.client.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertIsNone(doc.van_route_id)

    def test_no_auto_link_when_route_is_closed(self):
        from apps.van_routes.models import VanRoute
        route = self._make_route(route_status=VanRoute.STATUS_CLOSED)
        route.orders.add(self.order)
        r = self.client.get(self._url())
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertIsNone(doc.van_route_id)



class FifoStockBatchDeductionOnWZTests(TestCase):
    """
    WZ completion must decrement StockBatch.quantity_remaining (FIFO order)
    so that expiry-alert reports only count stock physically still in the warehouse.
    """

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="fifo-wz-user",
            email="fifo-wz@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Fifo tenant")
        CompanyMembership.objects.create(
            user=self.user, company=self.co, role="admin", is_active=True
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)

        self.wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.customer = Customer.objects.create(name="Shop A", company=self.co)
        self.product = Product.objects.create(
            name="Bread",
            company=self.co,
            price_net=Decimal("3.00"),
            price_gross=Decimal("3.69"),
            track_batches=True,
        )

    def _make_stock_batch(self, qty, unit_cost=Decimal("2.00"), received_date=None):
        from apps.products.models import StockBatch
        return StockBatch.objects.create(
            company=self.co,
            product=self.product,
            warehouse=self.wh,
            received_date=received_date or date(2026, 1, 1),
            quantity_initial=qty,
            quantity_remaining=qty,
            unit_cost=unit_cost,
        )

    def _make_stock(self, available, reserved=Decimal("0")):
        return ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=self.wh,
            quantity_available=available,
            quantity_reserved=reserved,
            quantity_total=available + reserved,
        )

    def _standalone_wz_in_transit(self, qty):
        doc = DeliveryDocument.objects.create(
            company=self.co,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 1),
            from_warehouse=self.wh,
            to_customer=self.customer,
            status=DeliveryDocument.STATUS_IN_TRANSIT,
        )
        DeliveryItem.objects.create(
            delivery_document=doc,
            product=self.product,
            quantity_planned=qty,
        )
        return doc

    def _url_complete(self, doc_id):
        return reverse("delivery-document-complete", kwargs={"uuid": str(doc_id)})

    def test_wz_complete_decrements_single_batch(self):
        """Completing a WZ reduces StockBatch.quantity_remaining by the sold qty."""
        from apps.products.models import StockBatch
        batch = self._make_stock_batch(Decimal("10.00"))
        self._make_stock(available=Decimal("10.00"))
        doc = self._standalone_wz_in_transit(Decimal("4.00"))

        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_complete(doc.uuid),
            data={"items": [{"id": str(doc.items.first().uuid), "quantity_actual": "4.00"}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.data)
        batch.refresh_from_db()
        self.assertEqual(batch.quantity_remaining, Decimal("6.00"))

    def test_wz_complete_consumes_oldest_batch_first(self):
        """FIFO: oldest received_date batch is consumed before newer one."""
        from apps.products.models import StockBatch
        old_batch = self._make_stock_batch(Decimal("3.00"), received_date=date(2026, 1, 1))
        new_batch = self._make_stock_batch(Decimal("10.00"), received_date=date(2026, 3, 1))
        self._make_stock(available=Decimal("13.00"))
        doc = self._standalone_wz_in_transit(Decimal("5.00"))

        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_complete(doc.uuid),
            data={"items": [{"id": str(doc.items.first().uuid), "quantity_actual": "5.00"}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.data)
        old_batch.refresh_from_db()
        new_batch.refresh_from_db()
        self.assertEqual(old_batch.quantity_remaining, Decimal("0.00"))
        self.assertEqual(new_batch.quantity_remaining, Decimal("8.00"))

    def test_wz_complete_full_sale_zeroes_batch(self):
        """Selling exactly all stock zeroes out the batch."""
        from apps.products.models import StockBatch
        batch = self._make_stock_batch(Decimal("5.00"))
        self._make_stock(available=Decimal("5.00"))
        doc = self._standalone_wz_in_transit(Decimal("5.00"))

        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_complete(doc.uuid),
            data={"items": [{"id": str(doc.items.first().uuid), "quantity_actual": "5.00"}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.data)
        batch.refresh_from_db()
        self.assertEqual(batch.quantity_remaining, Decimal("0.00"))

    def test_wz_complete_no_batches_does_not_raise(self):
        """Products with track_batches=False have no StockBatch rows — must not raise."""
        product_no_batch = Product.objects.create(
            name="Service product",
            company=self.co,
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.23"),
            track_batches=False,
        )
        ProductStock.objects.create(
            company=self.co,
            product=product_no_batch,
            warehouse=self.wh,
            quantity_available=Decimal("10.00"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10.00"),
        )
        doc = DeliveryDocument.objects.create(
            company=self.co,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 1),
            from_warehouse=self.wh,
            to_customer=self.customer,
            status=DeliveryDocument.STATUS_IN_TRANSIT,
        )
        DeliveryItem.objects.create(
            delivery_document=doc,
            product=product_no_batch,
            quantity_planned=Decimal("3.00"),
        )
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_complete(doc.uuid),
            data={"items": [{"id": str(doc.items.first().uuid), "quantity_actual": "3.00"}]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.data)


class ExpiryDateOnPZTests(TestCase):
    """
    expiry_date set on a PZ line must propagate to the StockBatch
    created when the PZ is completed.
    """

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="expiry-pz-user",
            email="expiry-pz@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Expiry tenant")
        CompanyMembership.objects.create(
            user=self.user, company=self.co, role="admin", is_active=True
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)

        self.wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.product = Product.objects.create(
            name="Flour",
            company=self.co,
            price_net=Decimal("2.50"),
            price_gross=Decimal("2.70"),
            track_batches=True,
        )

    def _url_create_pz(self):
        return reverse("delivery-document-create-pz")

    def _url_complete(self, doc_id):
        return reverse("delivery-document-complete", kwargs={"uuid": str(doc_id)})

    def test_expiry_date_stored_on_delivery_item(self):
        """expiry_date sent in create-pz payload is persisted on DeliveryItem."""
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_create_pz(),
            data={
                "to_warehouse_id": str(self.wh.uuid),
                "items": [
                    {
                        "product_id": str(self.product.uuid),
                        "quantity_planned": "50.00",
                        "unit_cost": "1.80",
                        "expiry_date": "2026-12-31",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        item = DeliveryItem.objects.get(delivery_document__uuid=r.data["id"])
        self.assertEqual(str(item.expiry_date), "2026-12-31")

    def test_expiry_date_propagates_to_stock_batch_on_complete(self):
        """Completing the PZ creates a StockBatch with the same expiry_date."""
        from apps.products.models import StockBatch
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_create_pz(),
            data={
                "to_warehouse_id": str(self.wh.uuid),
                "items": [
                    {
                        "product_id": str(self.product.uuid),
                        "quantity_planned": "50.00",
                        "unit_cost": "1.80",
                        "expiry_date": "2026-12-31",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        doc_id = r.data["id"]

        r2 = self.client.post(self._url_complete(doc_id))
        self.assertEqual(r2.status_code, 200, r2.data)

        batch = StockBatch.objects.get(product=self.product, warehouse=self.wh)
        self.assertEqual(str(batch.expiry_date), "2026-12-31")

    def test_no_expiry_date_creates_batch_without_expiry(self):
        """When expiry_date is omitted, StockBatch.expiry_date is None."""
        from apps.products.models import StockBatch
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_create_pz(),
            data={
                "to_warehouse_id": str(self.wh.uuid),
                "items": [
                    {
                        "product_id": str(self.product.uuid),
                        "quantity_planned": "10.00",
                        "unit_cost": "2.00",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        r2 = self.client.post(self._url_complete(r.data["id"]))
        self.assertEqual(r2.status_code, 200, r2.data)

        batch = StockBatch.objects.get(product=self.product, warehouse=self.wh)
        self.assertIsNone(batch.expiry_date)

    def test_expiry_date_visible_in_delivery_item_api_response(self):
        """GET delivery document returns expiry_date on items."""
        self.client.force_authenticate(user=self.user)
        r = self.client.post(
            self._url_create_pz(),
            data={
                "to_warehouse_id": str(self.wh.uuid),
                "items": [
                    {
                        "product_id": str(self.product.uuid),
                        "quantity_planned": "5.00",
                        "expiry_date": "2027-06-30",
                    }
                ],
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["items"][0]["expiry_date"], "2027-06-30")


class CreateRWAPITests(TestCase):
    """POST /api/delivery/create-rw/ — manual write-off (RW) document."""

    URL = "/api/delivery/create-rw/"

    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="rw-user", email="rw@test.com", password="test12345"
        )
        self.co = Company.objects.create(name="RW Tenant")
        CompanyMembership.objects.create(
            user=self.user, company=self.co, role="admin", is_active=True
        )
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])

        CompanyModule.objects.create(company=self.co, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)

        self.wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG-RW",
            name="Main RW",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.product = Product.objects.create(
            name="RW Widget",
            company=self.co,
            price_net=Decimal("5.00"),
            price_gross=Decimal("6.15"),
        )
        # Give the product some stock to write off
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=self.wh,
            quantity_available=Decimal("20.000"),
            quantity_reserved=Decimal("0.000"),
        )
        self.client.force_authenticate(user=self.user)

    def _payload(self, **overrides):
        base = {
            "from_warehouse_id": str(self.wh.uuid),
            "reason": "Strata",
            "issue_date": "2026-06-16",
            "items": [{"product_id": str(self.product.uuid), "quantity": "3.000"}],
        }
        base.update(overrides)
        return base

    # ── happy path ──────────────────────────────────────────────────

    def test_returns_201_with_delivered_rw_document(self):
        r = self.client.post(self.URL, self._payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_type"], "RW")
        self.assertEqual(r.data["status"], "delivered")
        self.assertTrue(r.data["document_number"].startswith("RW/2026/"))
        self.assertEqual(len(r.data["items"]), 1)

    def test_stock_is_decremented(self):
        self.client.post(self.URL, self._payload(), format="json")
        stock = ProductStock.objects.get(company=self.co, product=self.product, warehouse=self.wh)
        self.assertEqual(stock.quantity_available, Decimal("17.000"))

    def test_stock_movement_created_with_damage_type(self):
        self.client.post(self.URL, self._payload(), format="json")
        mv = StockMovement.objects.filter(
            company=self.co, product=self.product, warehouse=self.wh
        ).first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.movement_type, StockMovement.MovementType.DAMAGE)
        self.assertEqual(mv.quantity, Decimal("-3.000"))
        self.assertEqual(mv.reference_type, "rw_manual")

    def test_reason_embedded_in_notes(self):
        r = self.client.post(self.URL, self._payload(reason="Próbka", notes="do degustacji"), format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        doc = DeliveryDocument.objects.get(uuid=r.data["id"])
        self.assertIn("Próbka", doc.notes)
        self.assertIn("do degustacji", doc.notes)

    def test_multiple_items_all_deducted(self):
        product2 = Product.objects.create(
            name="RW Widget 2", company=self.co,
            price_net=Decimal("1.00"), price_gross=Decimal("1.23"),
        )
        ProductStock.objects.create(
            company=self.co, product=product2, warehouse=self.wh,
            quantity_available=Decimal("10.000"), quantity_reserved=Decimal("0.000"),
        )
        r = self.client.post(self.URL, {
            "from_warehouse_id": str(self.wh.uuid),
            "reason": "Uszkodzenie",
            "items": [
                {"product_id": str(self.product.uuid), "quantity": "2.000"},
                {"product_id": str(product2.uuid), "quantity": "5.000"},
            ],
        }, format="json")
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(len(r.data["items"]), 2)

        s1 = ProductStock.objects.get(company=self.co, product=self.product, warehouse=self.wh)
        s2 = ProductStock.objects.get(company=self.co, product=product2, warehouse=self.wh)
        self.assertEqual(s1.quantity_available, Decimal("18.000"))
        self.assertEqual(s2.quantity_available, Decimal("5.000"))

    # ── validation ──────────────────────────────────────────────────

    def test_requires_from_warehouse_id(self):
        payload = self._payload()
        del payload["from_warehouse_id"]
        r = self.client.post(self.URL, payload, format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_requires_reason(self):
        r = self.client.post(self.URL, self._payload(reason=""), format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_requires_at_least_one_item(self):
        r = self.client.post(self.URL, self._payload(items=[]), format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_rejects_warehouse_from_other_company(self):
        other_co = Company.objects.create(name="Other Co")
        other_wh = Warehouse.objects.create(
            user=self.user, company=other_co, code="MG-OTHER", name="Other WH",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        r = self.client.post(self.URL, self._payload(from_warehouse_id=str(other_wh.uuid)), format="json")
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_requires_authentication(self):
        self.client.force_authenticate(user=None)
        r = self.client.post(self.URL, self._payload(), format="json")
        self.assertEqual(r.status_code, status.HTTP_401_UNAUTHORIZED)


class ZWReturnBatchTests(TestCase):
    """ZW return flow recreates StockBatch so FIFO tracking stays accurate."""

    def setUp(self):
        from apps.delivery.services import create_zw_from_pending_returns

        self.create_zw = create_zw_from_pending_returns

        User = get_user_model()
        self.user = User.objects.create_user(username="zw-user", email="zw@test.com", password="x")
        self.co = Company.objects.create(name="ZW Co")
        CompanyMembership.objects.create(user=self.user, company=self.co, role="admin", is_active=True)
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])

        self.wh = Warehouse.objects.create(
            user=self.user, company=self.co, code="MG", name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self.product = Product.objects.create(
            name="Bread", company=self.co,
            price_net=Decimal("2.00"), price_gross=Decimal("2.16"),
            track_batches=True,
        )
        # Simulate a delivered WZ with one item (unit_cost + expiry_date preserved)
        self.wz = DeliveryDocument.objects.create(
            company=self.co, user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 1),
            from_warehouse=self.wh,
            status=DeliveryDocument.STATUS_DELIVERED,
        )
        self.wz_item = DeliveryItem.objects.create(
            delivery_document=self.wz,
            product=self.product,
            quantity_planned=Decimal("10.000"),
            quantity_actual=Decimal("10.000"),
            unit_cost=Decimal("1.8000"),
            expiry_date=date(2026, 7, 1),
        )
        # Warehouse stock (after original WZ deduction, 0 remaining on hand)
        self.stock = ProductStock.objects.create(
            company=self.co, product=self.product, warehouse=self.wh,
            quantity_available=Decimal("0.000"), quantity_reserved=Decimal("0.000"),
        )

    def _do_return(self, qty="3.000"):
        return self.create_zw(
            wz_doc=self.wz,
            return_items=[{
                "product_id": str(self.product.uuid),
                "quantity": qty,
                "return_reason": "Zwrot z poprzedniego dnia",
            }],
            user=self.user,
        )

    def test_zw_document_created_with_correct_type_and_link(self):
        zw = self._do_return()
        self.assertEqual(zw.document_type, DeliveryDocument.DOC_TYPE_ZW)
        self.assertEqual(zw.linked_wz_id, self.wz.id)

    def test_stock_is_incremented_on_return(self):
        self._do_return("3.000")
        self.stock.refresh_from_db()
        self.assertEqual(self.stock.quantity_available, Decimal("3.000"))

    def test_stock_batch_created_for_tracked_product(self):
        from apps.products.models import StockBatch
        self._do_return("3.000")
        batch = StockBatch.objects.filter(
            company=self.co, product=self.product, warehouse=self.wh
        ).first()
        self.assertIsNotNone(batch)
        self.assertEqual(batch.quantity_initial, Decimal("3.000"))
        self.assertEqual(batch.quantity_remaining, Decimal("3.000"))

    def test_batch_carries_unit_cost_from_original_wz_line(self):
        from apps.products.models import StockBatch
        self._do_return("3.000")
        batch = StockBatch.objects.get(company=self.co, product=self.product, warehouse=self.wh)
        self.assertEqual(batch.unit_cost, Decimal("1.80"))

    def test_batch_carries_expiry_date_from_original_wz_line(self):
        from apps.products.models import StockBatch
        self._do_return("3.000")
        batch = StockBatch.objects.get(company=self.co, product=self.product, warehouse=self.wh)
        self.assertEqual(batch.expiry_date, date(2026, 7, 1))

    def test_no_batch_created_when_product_does_not_track_batches(self):
        from apps.products.models import StockBatch
        self.product.track_batches = False
        self.product.save(update_fields=["track_batches"])
        self._do_return("2.000")
        self.assertEqual(
            StockBatch.objects.filter(company=self.co, product=self.product).count(), 0
        )

    def test_stock_movement_recorded_as_return(self):
        self._do_return("3.000")
        mv = StockMovement.objects.get(
            company=self.co, product=self.product, warehouse=self.wh
        )
        self.assertEqual(mv.movement_type, StockMovement.MovementType.RETURN)
        self.assertEqual(mv.quantity, Decimal("3.000"))


# ---------------------------------------------------------------------------
# WZ-KOR — Delivery correction tests
# ---------------------------------------------------------------------------


class WzKorServiceTests(TestCase):
    """Unit tests for create_wz_correction service."""

    def setUp(self):
        from apps.delivery.services import create_wz_correction

        self.service = create_wz_correction

        User = get_user_model()
        self.user = User.objects.create_user(
            username="wzkor-svc-user", email="wzkor-svc@test.com", password="pass"
        )
        self.company = Company.objects.create(name="WZ KOR Co")
        CompanyMembership.objects.create(
            user=self.user, company=self.company, role="admin", is_active=True
        )
        self.warehouse = Warehouse.objects.create(
            company=self.company, user=self.user, name="Main", code="MG", warehouse_type="main"
        )
        self.customer = Customer.objects.create(name="Shop A", company=self.company)
        self.product = Product.objects.create(
            company=self.company, name="Bread", unit="szt", price_gross="5.00"
        )
        self.stock = ProductStock.objects.create(
            company=self.company,
            product=self.product,
            warehouse=self.warehouse,
            quantity_available=Decimal("0"),
        )
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 6, 1),
            delivery_date=date(2026, 6, 10),
            status=Order.STATUS_DELIVERED,
        )
        self.order_item = OrderItem.objects.create(
            order=self.order,
            product=self.product,
            product_name="Bread",
            product_unit="szt",
            quantity=Decimal("10"),
            quantity_delivered=Decimal("10"),
            unit_price_net=Decimal("4.07"),
            unit_price_gross=Decimal("5.00"),
            vat_rate=Decimal("23"),
            line_total_net=Decimal("40.70"),
            line_total_gross=Decimal("50.00"),
        )
        self.wz = DeliveryDocument.objects.create(
            company=self.company,
            user=self.user,
            order=self.order,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 10),
            from_warehouse=self.warehouse,
            to_customer=self.customer,
            status=DeliveryDocument.STATUS_DELIVERED,
        )
        self.wz_item = DeliveryItem.objects.create(
            delivery_document=self.wz,
            order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("10"),
            quantity_actual=Decimal("10"),
        )

    def test_creates_wz_kor_document(self):
        kor = self.service(
            original_wz=self.wz,
            correction_items=[{
                "delivery_item_id": str(self.wz_item.uuid),
                "quantity_returned": Decimal("3"),
            }],
            user=self.user,
            correction_reason="Zwrot",
        )
        self.assertEqual(kor.document_type, DeliveryDocument.DOC_TYPE_WZ_KOR)
        self.assertEqual(kor.corrects_wz, self.wz)
        self.assertEqual(kor.status, DeliveryDocument.STATUS_DELIVERED)
        self.assertTrue(kor.document_number.startswith("WZ-KOR/"))

    def test_stock_returned_to_warehouse(self):
        self.service(
            original_wz=self.wz,
            correction_items=[{
                "delivery_item_id": str(self.wz_item.uuid),
                "quantity_returned": Decimal("4"),
            }],
            user=self.user,
        )
        self.stock.refresh_from_db()
        self.assertEqual(self.stock.quantity_available, Decimal("4"))

    def test_stock_movement_recorded(self):
        self.service(
            original_wz=self.wz,
            correction_items=[{
                "delivery_item_id": str(self.wz_item.uuid),
                "quantity_returned": Decimal("2"),
            }],
            user=self.user,
        )
        mv = StockMovement.objects.filter(
            reference_type="wz_correction", product=self.product
        ).first()
        self.assertIsNotNone(mv)
        self.assertEqual(mv.quantity, Decimal("2"))

    def test_raises_for_non_wz_document(self):
        from rest_framework.exceptions import ValidationError as DRFValidationError

        pz = DeliveryDocument.objects.create(
            company=self.company,
            user=self.user,
            document_type=DeliveryDocument.DOC_TYPE_PZ,
            issue_date=date(2026, 6, 10),
            status=DeliveryDocument.STATUS_DELIVERED,
        )
        with self.assertRaises((DRFValidationError, Exception)):
            self.service(
                original_wz=pz,
                correction_items=[{
                    "delivery_item_id": str(self.wz_item.uuid),
                    "quantity_returned": Decimal("1"),
                }],
                user=self.user,
            )

    def test_raises_when_quantity_exceeds_delivered(self):
        from rest_framework.exceptions import ValidationError as DRFValidationError

        with self.assertRaises((DRFValidationError, Exception)):
            self.service(
                original_wz=self.wz,
                correction_items=[{
                    "delivery_item_id": str(self.wz_item.uuid),
                    "quantity_returned": Decimal("99"),
                }],
                user=self.user,
            )

    def test_raises_for_non_delivered_wz(self):
        from rest_framework.exceptions import ValidationError as DRFValidationError

        self.wz.status = DeliveryDocument.STATUS_SAVED
        self.wz.save(update_fields=["status"])
        with self.assertRaises((DRFValidationError, Exception)):
            self.service(
                original_wz=self.wz,
                correction_items=[{
                    "delivery_item_id": str(self.wz_item.uuid),
                    "quantity_returned": Decimal("1"),
                }],
                user=self.user,
            )


class WzKorAPITests(TestCase):
    """POST /api/delivery/{id}/create-wz-correction/ endpoint."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="wzkor-api-user", email="wzkor-api@test.com", password="pass"
        )
        self.company = Company.objects.create(name="WZ API Co")
        CompanyMembership.objects.create(
            user=self.user, company=self.company, role="admin", is_active=True
        )
        self.user.current_company = self.company
        self.user.save()
        CompanyModule.objects.create(company=self.company, module="delivery", is_enabled=True)
        CompanyModule.objects.create(company=self.company, module="warehouses", is_enabled=True)
        self.warehouse = Warehouse.objects.create(
            company=self.company, user=self.user, name="MG", code="MG", warehouse_type="main"
        )
        self.customer = Customer.objects.create(name="Shop B", company=self.company)
        self.product = Product.objects.create(
            company=self.company, name="Roll", unit="szt", price_gross="1.00"
        )
        ProductStock.objects.create(
            company=self.company,
            product=self.product,
            warehouse=self.warehouse,
            quantity_available=Decimal("0"),
        )
        self.order = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.company,
            order_date=date(2026, 6, 1),
            delivery_date=date(2026, 6, 10),
            status=Order.STATUS_DELIVERED,
        )
        self.order_item = OrderItem.objects.create(
            order=self.order,
            product=self.product,
            product_name="Roll",
            product_unit="szt",
            quantity=Decimal("20"),
            quantity_delivered=Decimal("20"),
            unit_price_net=Decimal("0.81"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("23"),
            line_total_net=Decimal("16.20"),
            line_total_gross=Decimal("20.00"),
        )
        self.wz = DeliveryDocument.objects.create(
            company=self.company,
            user=self.user,
            order=self.order,
            document_type=DeliveryDocument.DOC_TYPE_WZ,
            issue_date=date(2026, 6, 10),
            from_warehouse=self.warehouse,
            to_customer=self.customer,
            status=DeliveryDocument.STATUS_DELIVERED,
        )
        self.wz_item = DeliveryItem.objects.create(
            delivery_document=self.wz,
            order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("20"),
            quantity_actual=Decimal("20"),
        )
        self.client = APIClient()
        self.client.force_authenticate(user=self.user)

    def _url(self, doc_id):
        return reverse("delivery-document-create-wz-correction-action", kwargs={"uuid": str(doc_id)})

    def test_returns_201_with_wz_kor(self):
        r = self.client.post(
            self._url(self.wz.uuid),
            data={
                "correction_reason": "Zwrot",
                "items": [{"delivery_item_id": str(self.wz_item.uuid), "quantity_returned": "5.000"}],
            },
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertEqual(r.data["document_type"], "WZ-KOR")

    def test_returns_400_for_non_delivered_wz(self):
        self.wz.status = DeliveryDocument.STATUS_SAVED
        self.wz.save(update_fields=["status"])
        r = self.client.post(
            self._url(self.wz.uuid),
            data={"items": [{"delivery_item_id": str(self.wz_item.uuid), "quantity_returned": "1"}]},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

    def test_returns_400_when_items_empty(self):
        r = self.client.post(
            self._url(self.wz.uuid),
            data={"items": []},
            format="json",
        )
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)

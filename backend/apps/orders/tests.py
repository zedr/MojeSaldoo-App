from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient

from apps.customers.models import Customer
from apps.orders.models import Order, OrderItem
from apps.products.models import Product, ProductStock, StockMovement, Warehouse
from apps.users.models import Company, CompanyMembership, CompanyModule


class OrderApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        User = get_user_model()
        self.user = User.objects.create_user(
            username="order-api-user",
            email="order-api@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Buyer tenant")
        CompanyMembership.objects.create(
            user=self.user,
            company=self.co,
            role="admin",
            is_active=True,
        )
        CompanyModule.objects.create(company=self.co, module="warehouses", is_enabled=True)
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])
        self.customer = Customer.objects.create(name="Buyer Co", company=self.co)
        self.product = Product.objects.create(
            name="API Product",
            company=self.co,
            unit="szt",
            price_net=Decimal("10.00"),
            price_gross=Decimal("12.30"),
            vat_rate=Decimal("23.00"),
        )
        Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 4, 1),
            delivery_date=date(2026, 4, 10),
            status="draft",
        )

    def test_order_list_url_resolves(self):
        self.assertEqual(reverse("order-list"), "/api/orders/")

    def test_order_list_requires_authentication(self):
        response = self.client.get(reverse("order-list"))
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)

    def test_order_list_authenticated_returns_results(self):
        self.client.force_authenticate(user=self.user)
        response = self.client.get(reverse("order-list"))
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertIn("results", response.data)
        self.assertGreaterEqual(response.data["count"], 1)

    def test_order_list_without_invoice_returns_confirmed_or_delivered_uninvoiced(self):
        from apps.invoices.models import Invoice

        self.client.force_authenticate(user=self.user)
        o_delivered = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 1),
            delivery_date=date(2026, 5, 10),
            status=Order.STATUS_DELIVERED,
        )
        o_confirmed = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 3),
            delivery_date=date(2026, 5, 14),
            status=Order.STATUS_CONFIRMED,
        )
        o_invoiced = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 5, 2),
            delivery_date=date(2026, 5, 12),
            status=Order.STATUS_DELIVERED,
        )
        Invoice.objects.create(
            company=self.co,
            user=self.user,
            order=o_invoiced,
            customer=self.customer,
            issue_date=date(2026, 5, 13),
            sale_date=date(2026, 5, 13),
            due_date=date(2026, 5, 27),
        )
        r = self.client.get(reverse("order-list"), {"without_invoice": "true"})
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        ids = {row["id"] for row in r.data["results"]}
        self.assertIn(str(o_delivered.uuid), ids)
        self.assertIn(str(o_confirmed.uuid), ids)
        self.assertNotIn(str(o_invoiced.uuid), ids)

    def test_create_order_accepts_customer_id_and_items(self):
        self.client.force_authenticate(user=self.user)
        body = {
            "customer_id": str(self.customer.uuid),
            "delivery_date": "2026-04-20",
            "items": [
                {
                    "product_id": str(self.product.uuid),
                    "quantity": "2.00",
                    "unit_price_net": "5.00",
                    "unit_price_gross": "6.00",
                    "vat_rate": "23.00",
                    "discount_percent": "0.00",
                }
            ],
        }
        r = self.client.post(
            reverse("order-list"), data=body, format="json"
        )
        self.assertEqual(r.status_code, status.HTTP_201_CREATED, r.data)
        self.assertIn("id", r.data)
        self.assertIn("order_number", r.data)
        it = r.data["items"]
        self.assertEqual(len(it), 1)
        self.assertEqual(it[0]["product_name"], "API Product")
        self.assertEqual(it[0]["product_unit"], "szt")
        self.assertEqual(it[0]["line_total_net"], "10.00")
        self.assertEqual(it[0]["line_total_gross"], "12.00")
        self.assertEqual(r.data["subtotal_net"], "10.00")
        self.assertEqual(r.data["subtotal_gross"], "12.00")

    def _auth(self):
        self.client.force_authenticate(user=self.user)

    def _url_items(self, order_id):
        return reverse("order-items", kwargs={"uuid": str(order_id)})

    def _url_confirm(self, order_id):
        return reverse("order-confirm", kwargs={"uuid": str(order_id)})

    def _url_cancel(self, order_id):
        return reverse("order-cancel", kwargs={"uuid": str(order_id)})

    def test_list_forbidden_without_current_company(self):
        User = get_user_model()
        u = User.objects.create_user(
            username="no-cc",
            email="no-cc@test.com",
            password="x",
        )
        CompanyMembership.objects.create(
            user=u, company=self.co, role="viewer", is_active=True
        )
        self.client.force_authenticate(u)
        r = self.client.get(reverse("order-list"))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)

    def test_list_forbidden_wrong_current_company(self):
        other = Company.objects.create(name="Not member here")
        self.user.current_company = other
        self.user.save(update_fields=["current_company"])
        self._auth()
        r = self.client.get(reverse("order-list"))
        self.assertEqual(r.status_code, status.HTTP_403_FORBIDDEN)
        self.user.current_company = self.co
        self.user.save(update_fields=["current_company"])

    def test_get_items_returns_list_of_line_items(self):
        self._auth()
        o = Order.objects.get(company=self.co)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.get(self._url_items(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertIsInstance(r.data, list)
        self.assertEqual(len(r.data), 1)
        self.assertEqual(r.data[0]["product_name"], "API Product")

    def test_post_confirm_draft_to_confirmed(self):
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["status"], Order.STATUS_CONFIRMED)
        o.refresh_from_db()
        self.assertIsNotNone(o.confirmed_at)

    def test_post_confirm_non_draft_returns_400(self):
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        o.status = Order.STATUS_CONFIRMED
        o.save(update_fields=["status"])
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", r.data)

    def test_post_confirm_with_items_requires_main_warehouse(self):
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("warehouse", r.data)

    def test_post_confirm_insufficient_stock_returns_400_and_no_partial_reserve(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("2"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("2"),
        )
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("5"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        o.refresh_from_db()
        self.assertEqual(o.status, Order.STATUS_DRAFT)
        stock = ProductStock.objects.get(product=self.product, warehouse=wh)
        self.assertEqual(stock.quantity_available, Decimal("2"))
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        self.assertEqual(StockMovement.objects.filter(reference_id=o.uuid).count(), 0)

    def test_post_confirm_reserves_stock_and_writes_movements(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("10"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10"),
        )
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("3"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["status"], Order.STATUS_CONFIRMED)
        stock = ProductStock.objects.get(product=self.product, warehouse=wh)
        self.assertEqual(stock.quantity_available, Decimal("7"))
        self.assertEqual(stock.quantity_reserved, Decimal("3"))
        self.assertEqual(stock.quantity_total, Decimal("10"))
        mov = StockMovement.objects.get(reference_id=o.uuid)
        self.assertEqual(mov.movement_type, StockMovement.MovementType.RESERVATION)
        self.assertEqual(mov.quantity, Decimal("-3"))
        self.assertEqual(mov.reference_type, "order")
        self.assertEqual(mov.quantity_before, Decimal("10"))
        self.assertEqual(mov.quantity_after, Decimal("7"))

    def test_post_confirm_two_lines_same_product_reserves_cumulative_and_two_movements(
        self,
    ):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("10"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10"),
        )
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        for qty in (Decimal("2"), Decimal("3")):
            OrderItem.objects.create(
                order=o,
                product=self.product,
                quantity=qty,
                unit_price_net=Decimal("1.00"),
                unit_price_gross=Decimal("1.00"),
                vat_rate=Decimal("0.00"),
                discount_percent=Decimal("0.00"),
            )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        stock = ProductStock.objects.get(product=self.product, warehouse=wh)
        self.assertEqual(stock.quantity_available, Decimal("5"))
        self.assertEqual(stock.quantity_reserved, Decimal("5"))
        movements = StockMovement.objects.filter(reference_id=o.uuid).order_by(
            "quantity_after"
        )
        self.assertEqual(movements.count(), 2)
        self.assertEqual(
            {m.quantity for m in movements},
            {Decimal("-2"), Decimal("-3")},
        )

    def test_post_confirm_two_products_short_on_one_rolls_back_all(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        p2 = Product.objects.create(
            name="Second",
            company=self.co,
            unit="szt",
            price_net=Decimal("1.00"),
            price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("100"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("100"),
        )
        ProductStock.objects.create(
            company=self.co,
            product=p2,
            warehouse=wh,
            quantity_available=Decimal("1"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("1"),
        )
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("5"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        OrderItem.objects.create(
            order=o,
            product=p2,
            quantity=Decimal("3"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        o.refresh_from_db()
        self.assertEqual(o.status, Order.STATUS_DRAFT)
        s1 = ProductStock.objects.get(product=self.product, warehouse=wh)
        s2 = ProductStock.objects.get(product=p2, warehouse=wh)
        self.assertEqual(s1.quantity_available, Decimal("100"))
        self.assertEqual(s2.quantity_available, Decimal("1"))
        self.assertEqual(StockMovement.objects.filter(reference_id=o.uuid).count(), 0)

    def test_post_confirm_without_productstock_row_shortfall_uses_zero_available(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        self.assertFalse(
            ProductStock.objects.filter(
                product=self.product, warehouse=wh
            ).exists()
        )

    def test_post_confirm_inactive_main_warehouse_rejected(self):
        Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
            is_active=False,
        )
        self._auth()
        o = Order.objects.get(company=self.co, status=Order.STATUS_DRAFT)
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_confirm(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("warehouse", r.data)

    def test_post_cancel_draft_succeeds(self):
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_DRAFT,
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["status"], Order.STATUS_CANCELLED)

    def test_post_cancel_confirmed_succeeds(self):
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_CONFIRMED,
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK)
        self.assertEqual(r.data["status"], Order.STATUS_CANCELLED)

    def test_post_cancel_confirmed_after_confirm_releases_stock(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("10"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10"),
        )
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_DRAFT,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("4"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        self.assertEqual(
            self.client.post(self._url_confirm(o.uuid)).status_code,
            status.HTTP_200_OK,
        )
        stock = ProductStock.objects.get(product=self.product, warehouse=wh)
        self.assertEqual(stock.quantity_available, Decimal("6"))
        self.assertEqual(stock.quantity_reserved, Decimal("4"))
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        self.assertEqual(r.data["status"], Order.STATUS_CANCELLED)
        stock.refresh_from_db()
        self.assertEqual(stock.quantity_available, Decimal("10"))
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        self.assertEqual(stock.quantity_total, Decimal("10"))
        unres = StockMovement.objects.filter(
            reference_id=o.uuid,
            movement_type=StockMovement.MovementType.UNRESERVATION,
        )
        self.assertEqual(unres.count(), 1)
        m = unres.get()
        self.assertEqual(m.quantity, Decimal("4"))
        self.assertEqual(m.quantity_before, Decimal("6"))
        self.assertEqual(m.quantity_after, Decimal("10"))

    def test_post_cancel_confirmed_with_items_requires_main_warehouse(self):
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("warehouse", r.data)
        o.refresh_from_db()
        self.assertEqual(o.status, Order.STATUS_CONFIRMED)

    def test_post_cancel_confirmed_insufficient_reserved_returns_400(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("10"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10"),
        )
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("3"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        o.refresh_from_db()
        self.assertEqual(o.status, Order.STATUS_CONFIRMED)

    def test_post_cancel_draft_with_items_does_not_touch_stock(self):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("10"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10"),
        )
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_DRAFT,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("4"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        stock = ProductStock.objects.get(product=self.product, warehouse=wh)
        self.assertEqual(stock.quantity_available, Decimal("10"))
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        self.assertFalse(
            StockMovement.objects.filter(reference_id=o.uuid).exists()
        )

    def test_post_cancel_after_confirm_two_lines_same_product_two_unreservations(
        self,
    ):
        wh = Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        ProductStock.objects.create(
            company=self.co,
            product=self.product,
            warehouse=wh,
            quantity_available=Decimal("10"),
            quantity_reserved=Decimal("0"),
            quantity_total=Decimal("10"),
        )
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_DRAFT,
        )
        for qty in (Decimal("2"), Decimal("3")):
            OrderItem.objects.create(
                order=o,
                product=self.product,
                quantity=qty,
                unit_price_net=Decimal("1.00"),
                unit_price_gross=Decimal("1.00"),
                vat_rate=Decimal("0.00"),
                discount_percent=Decimal("0.00"),
            )
        self.assertEqual(
            self.client.post(self._url_confirm(o.uuid)).status_code,
            status.HTTP_200_OK,
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_200_OK, r.data)
        stock = ProductStock.objects.get(product=self.product, warehouse=wh)
        self.assertEqual(stock.quantity_available, Decimal("10"))
        self.assertEqual(stock.quantity_reserved, Decimal("0"))
        unres = StockMovement.objects.filter(
            reference_id=o.uuid,
            movement_type=StockMovement.MovementType.UNRESERVATION,
        )
        self.assertEqual(unres.count(), 2)
        self.assertEqual(
            {m.quantity for m in unres},
            {Decimal("2"), Decimal("3")},
        )

    def test_post_cancel_confirmed_missing_productstock_returns_400(self):
        Warehouse.objects.create(
            user=self.user,
            company=self.co,
            code="MG",
            name="Main",
            warehouse_type=Warehouse.WarehouseType.MAIN,
        )
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_CONFIRMED,
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST, r.data)
        self.assertIn("stock", r.data)
        o.refresh_from_db()
        self.assertEqual(o.status, Order.STATUS_CONFIRMED)

    def test_post_cancel_in_preparation_returns_400(self):
        self._auth()
        o = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 3, 1),
            delivery_date=date(2026, 3, 20),
            status=Order.STATUS_IN_PREPARATION,
        )
        r = self.client.post(self._url_cancel(o.uuid))
        self.assertEqual(r.status_code, status.HTTP_400_BAD_REQUEST)
        self.assertIn("error", r.data)

    def test_filter_delivery_date_range(self):
        self._auth()
        o_early = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 4, 5),
            status=Order.STATUS_DRAFT,
        )
        o_mid = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 4, 15),
            status=Order.STATUS_DRAFT,
        )
        o_late = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 4, 25),
            status=Order.STATUS_DRAFT,
        )
        r = self.client.get(
            reverse("order-list"),
            {
                "delivery_date_after": "2026-04-10",
                "delivery_date_before": "2026-04-20",
            },
        )
        self.assertEqual(r.status_code, 200)
        ids = {row["id"] for row in r.data["results"]}
        self.assertIn(str(o_mid.uuid), ids)
        self.assertNotIn(str(o_early.uuid), ids)
        self.assertNotIn(str(o_late.uuid), ids)

    def test_filter_by_status(self):
        self._auth()
        o_draft = Order.objects.filter(company=self.co, status=Order.STATUS_DRAFT).first()
        o_conf = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 5, 1),
            status=Order.STATUS_CONFIRMED,
        )
        r = self.client.get(reverse("order-list"), {"status": Order.STATUS_CONFIRMED})
        ids = {row["id"] for row in r.data["results"]}
        self.assertIn(str(o_conf.uuid), ids)
        if o_draft and o_draft.status != Order.STATUS_CONFIRMED:
            self.assertNotIn(str(o_draft.uuid), ids)

    def test_filter_by_customer(self):
        self._auth()
        c2 = Customer.objects.create(name="Other", company=self.co)
        o1 = Order.objects.get(company=self.co, customer=self.customer, delivery_date=date(2026, 4, 10))
        o2 = Order.objects.create(
            user=self.user,
            customer=c2,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 6, 1),
            status=Order.STATUS_DRAFT,
        )
        r = self.client.get(reverse("order-list"), {"customer": str(c2.uuid)})
        ids = {row["id"] for row in r.data["results"]}
        self.assertIn(str(o2.uuid), ids)
        self.assertNotIn(str(o1.uuid), ids)

    def test_ordering_by_total_gross(self):
        self._auth()
        o_low = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 7, 1),
            status=Order.STATUS_DRAFT,
            subtotal_gross=Decimal("10.00"),
            subtotal_net=Decimal("8.00"),
            total_gross=Decimal("10.00"),
            total_net=Decimal("8.00"),
        )
        o_high = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 7, 2),
            status=Order.STATUS_DRAFT,
            subtotal_gross=Decimal("100.00"),
            subtotal_net=Decimal("80.00"),
            total_gross=Decimal("100.00"),
            total_net=Decimal("80.00"),
        )
        r = self.client.get(reverse("order-list"), {"ordering": "total_gross"})
        ids = [row["id"] for row in r.data["results"]]
        pos_low = ids.index(str(o_low.uuid)) if str(o_low.uuid) in ids else -1
        pos_high = ids.index(str(o_high.uuid)) if str(o_high.uuid) in ids else -1
        self.assertNotEqual(pos_low, -1)
        self.assertNotEqual(pos_high, -1)
        self.assertLess(pos_low, pos_high)

    def test_retrieve_order_from_other_company_returns_404(self):
        self._auth()
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
        r = self.client.get(
            reverse("order-detail", kwargs={"uuid": str(foreign_o.uuid)})
        )
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)

    def test_ordering_created_at(self):
        self._auth()
        o_a = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 9, 1),
            status=Order.STATUS_DRAFT,
        )
        o_b = Order.objects.create(
            user=self.user,
            customer=self.customer,
            company=self.co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 9, 2),
            status=Order.STATUS_DRAFT,
        )
        r = self.client.get(reverse("order-list"), {"ordering": "created_at"})
        ids = [row["id"] for row in r.data["results"]]
        pos_a = ids.index(str(o_a.uuid))
        pos_b = ids.index(str(o_b.uuid))
        self.assertLess(pos_a, pos_b)

    def test_items_action_404_for_other_company_order(self):
        self._auth()
        other_co = Company.objects.create(name="Co2")
        foreign_c = Customer.objects.create(name="F", company=other_co)
        foreign_o = Order.objects.create(
            user=self.user,
            customer=foreign_c,
            company=other_co,
            order_date=date(2026, 1, 1),
            delivery_date=date(2026, 8, 1),
            status=Order.STATUS_DRAFT,
        )
        r = self.client.get(self._url_items(foreign_o.uuid))
        self.assertEqual(r.status_code, status.HTTP_404_NOT_FOUND)


class OrderModelTests(TestCase):
    """Cover order_number sequencing, pricing, and status side effects."""

    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create_user(
            username="order-model-user",
            email="order-model@test.com",
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
        self.user.current_company = self.company
        self.user.save(update_fields=["current_company"])
        self.customer = Customer.objects.create(name="Cust A", company=self.company)
        self.customer_b = Customer.objects.create(name="Cust B", company=self.company_b)
        self.product = Product.objects.create(
            name="P1", company=self.company, price_net=60, price_gross=73.8
        )

    def _make_order(self, company=None, customer=None, user=None, **kwargs):
        return Order.objects.create(
            user=user or self.user,
            company=company or self.company,
            customer=customer or self.customer,
            order_date=kwargs.pop("order_date", date(2026, 4, 1)),
            delivery_date=kwargs.pop("delivery_date", date(2026, 4, 10)),
            status=kwargs.pop("status", Order.STATUS_DRAFT),
            **kwargs,
        )

    def test_new_order_receives_sequential_number_per_company(self):
        o1 = self._make_order()
        o2 = self._make_order()
        self.assertEqual(o1.order_number, "ZAM/2026/0001")
        self.assertEqual(o2.order_number, "ZAM/2026/0002")

    def test_different_companies_may_reuse_number_pattern(self):
        a = self._make_order(self.company, self.customer)
        b = self._make_order(self.company_b, self.customer_b)
        self.assertEqual(a.order_number, "ZAM/2026/0001")
        self.assertEqual(b.order_number, "ZAM/2026/0001")

    def test_year_is_taken_from_order_date(self):
        o = self._make_order(order_date=date(2025, 6, 15))
        self.assertEqual(o.order_number, "ZAM/2025/0001")

    def test_explicit_order_number_is_not_replaced(self):
        o = self._make_order(order_number="MANUAL-1")
        self.assertEqual(o.order_number, "MANUAL-1")

    @mock.patch("apps.orders.models.timezone")
    def test_update_status_sets_confirmed_at_once(self, m_tz):
        m_tz.localdate = mock.Mock(return_value=date(2026, 4, 1))
        t = datetime(2026, 4, 1, 9, 0, 0, tzinfo=dt_timezone.utc)
        m_tz.now = mock.Mock(return_value=t)
        o = self._make_order()
        o.update_status(Order.STATUS_CONFIRMED)
        o.refresh_from_db()
        self.assertEqual(o.confirmed_at, t)
        m_tz.now.return_value = datetime(2026, 4, 2, 9, 0, 0, tzinfo=dt_timezone.utc)
        o.update_status(Order.STATUS_IN_PREPARATION)
        o.update_status(Order.STATUS_CONFIRMED)
        self.assertEqual(o.confirmed_at, t)

    @mock.patch("apps.orders.models.timezone")
    def test_update_status_sets_delivered_at(self, m_tz):
        t = datetime(2026, 4, 5, 12, 0, 0, tzinfo=dt_timezone.utc)
        m_tz.localdate = mock.Mock(return_value=date(2026, 4, 1))
        m_tz.now = mock.Mock(return_value=t)
        o = self._make_order()
        o.update_status(Order.STATUS_DELIVERED)
        o.refresh_from_db()
        self.assertEqual(o.delivered_at, t)

    def test_update_status_rejects_invalid(self):
        o = self._make_order()
        with self.assertRaises(ValueError):
            o.update_status("not_a_status")

    def _line(
        self,
        order,
        unit_net: Decimal = Decimal("10.00"),
        unit_gross: Decimal = Decimal("10.00"),
        qty: Decimal = Decimal("2"),
    ):
        return OrderItem.objects.create(
            order=order,
            product=self.product,
            quantity=qty,
            unit_price_net=unit_net,
            unit_price_gross=unit_gross,
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )

    def test_calculate_total_sums_line_items(self):
        o = self._make_order()
        self._line(o)
        o.refresh_from_db()
        self.assertEqual(o.subtotal_net, Decimal("20.00"))
        self.assertEqual(o.subtotal_gross, Decimal("20.00"))
        self.assertEqual(o.total_gross, Decimal("20.00"))

    def test_calculate_total_applies_discount_percent(self):
        o = self._make_order(discount_percent=Decimal("10.00"))
        self._line(
            o,
            unit_net=Decimal("100.00"),
            unit_gross=Decimal("100.00"),
            qty=Decimal("1"),
        )
        o.refresh_from_db()
        self.assertEqual(o.discount_amount, Decimal("10.00"))
        self.assertEqual(o.total_gross, Decimal("90.00"))
        self.assertEqual(o.total_net, Decimal("90.00"))

    def test_calculate_total_uses_amount_when_no_percent(self):
        o = self._make_order(
            discount_percent=Decimal("0"), discount_amount=Decimal("15.00")
        )
        self._line(
            o,
            unit_net=Decimal("100.00"),
            unit_gross=Decimal("100.00"),
            qty=Decimal("1"),
        )
        o.refresh_from_db()
        self.assertEqual(o.total_gross, Decimal("85.00"))
        self.assertEqual(o.total_net, Decimal("85.00"))

    def test_duplicate_order_number_per_company_fails(self):
        self._make_order()
        with self.assertRaises(IntegrityError):
            self._make_order(
                order_number="ZAM/2026/0001",
            )

    def test_id_is_uuid(self):
        o = self._make_order()
        self.assertEqual(len(str(o.uuid)), 36)

    def test_can_be_modified_draft_and_confirmed_only(self):
        o = self._make_order()
        self.assertTrue(o.can_be_modified())
        o.status = Order.STATUS_CONFIRMED
        self.assertTrue(o.can_be_modified())
        o.status = Order.STATUS_IN_PREPARATION
        self.assertFalse(o.can_be_modified())

    def test_str_uses_order_number(self):
        o = self._make_order()
        self.assertIn("ZAM/2026/0001", str(o))

    def test_order_item_id_is_uuid(self):
        o = self._make_order()
        line = self._line(o)
        self.assertEqual(len(str(line.uuid)), 36)

    def test_order_item_snapshots_product_name_and_unit(self):
        self.product.name = "Renamed product"
        self.product.unit = "szt"
        self.product.save(update_fields=["name", "unit"])
        o = self._make_order()
        line = self._line(o)
        self.assertEqual(line.product_name, "Renamed product")
        self.assertEqual(line.product_unit, "szt")

    def test_line_recomputes_totals_from_line_discount(self):
        o = self._make_order()
        line = OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("100.00"),
            unit_price_gross=Decimal("123.00"),
            vat_rate=Decimal("23.00"),
            discount_percent=Decimal("10.00"),
        )
        # (1 - 0.1) * 100 = 90, (1 - 0.1) * 123 = 110.7
        self.assertEqual(line.line_total_net, Decimal("90.00"))
        self.assertEqual(line.line_total_gross, Decimal("110.70"))

    def test_same_product_appears_twice_on_one_order(self):
        o = self._make_order()
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("1"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        o.refresh_from_db()
        self.assertEqual(o.subtotal_gross, Decimal("2.00"))
        self.assertEqual(o.items.filter(product=self.product).count(), 2)

    def test_quantity_delivered_and_returned_persist(self):
        o = self._make_order()
        line = OrderItem.objects.create(
            order=o,
            product=self.product,
            quantity=Decimal("5"),
            quantity_delivered=Decimal("2"),
            quantity_returned=Decimal("0.5"),
            unit_price_net=Decimal("1.00"),
            unit_price_gross=Decimal("1.00"),
            vat_rate=Decimal("0.00"),
            discount_percent=Decimal("0.00"),
        )
        line.refresh_from_db()
        self.assertEqual(line.quantity_delivered, Decimal("2.00"))
        self.assertEqual(line.quantity_returned, Decimal("0.50"))


class DeliveryItemSignalTests(TestCase):
    """on_delivery_item_save: only recomputes quantity_delivered when doc is delivered."""

    def setUp(self):
        from apps.delivery.models import DeliveryDocument, DeliveryItem
        User = get_user_model()
        self.user = User.objects.create_user(
            username="signal-guard-user",
            email="signal-guard@test.com",
            password="test12345",
        )
        self.co = Company.objects.create(name="Signal Guard Co")
        CompanyMembership.objects.create(user=self.user, company=self.co, role="admin", is_active=True)
        customer = Customer.objects.create(name="SC", company=self.co)
        self.product = Product.objects.create(
            name="SP", company=self.co,
            price_net=Decimal("1.00"), price_gross=Decimal("1.23"),
        )
        self.order = Order.objects.create(
            user=self.user, customer=customer, company=self.co,
            order_date=date(2026, 6, 1), delivery_date=date(2026, 6, 4),
            status=Order.STATUS_CONFIRMED,
        )
        self.order_item = OrderItem.objects.create(
            order=self.order, product=self.product,
            quantity=Decimal("10.00"),
            quantity_delivered=Decimal("5.00"),
            unit_price_net=Decimal("1.00"), unit_price_gross=Decimal("1.23"),
            vat_rate=Decimal("23.00"), discount_percent=Decimal("0.00"),
        )

    def _make_doc(self, doc_status):
        from apps.delivery.models import DeliveryDocument
        return DeliveryDocument.objects.create(
            company=self.co, order=self.order, user=self.user,
            document_type="WZ", issue_date=date(2026, 6, 4),
            status=doc_status,
        )

    def test_signal_does_not_touch_quantity_delivered_when_doc_is_in_transit(self):
        """Saving a DeliveryItem while its doc is in_transit must not zero quantity_delivered."""
        from apps.delivery.models import DeliveryDocument, DeliveryItem
        doc = self._make_doc(DeliveryDocument.STATUS_IN_TRANSIT)
        item = DeliveryItem.objects.create(
            delivery_document=doc, order_item=self.order_item,
            product=self.product, quantity_planned=Decimal("3.00"),
        )
        self.order_item.refresh_from_db()
        self.assertEqual(self.order_item.quantity_delivered, Decimal("5.00"))

        # Also on a subsequent save (e.g. setting quantity_actual)
        item.quantity_actual = Decimal("3.00")
        item.save(update_fields=["quantity_actual"])
        self.order_item.refresh_from_db()
        self.assertEqual(self.order_item.quantity_delivered, Decimal("5.00"))

    def test_signal_recomputes_quantity_delivered_when_doc_is_delivered(self):
        """Creating a DeliveryItem on an already-delivered doc triggers DB recompute."""
        from apps.delivery.models import DeliveryDocument, DeliveryItem
        doc = self._make_doc(DeliveryDocument.STATUS_DELIVERED)
        # Set an incorrect value that the signal should overwrite.
        OrderItem.objects.filter(pk=self.order_item.pk).update(quantity_delivered=Decimal("0.00"))
        DeliveryItem.objects.create(
            delivery_document=doc, order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("4.00"), quantity_actual=Decimal("4.00"),
        )
        self.order_item.refresh_from_db()
        self.assertEqual(self.order_item.quantity_delivered, Decimal("4.00"))

    def test_signal_on_delete_recalculates_quantity_delivered(self):
        """Deleting a DeliveryItem from a delivered doc decrements quantity_delivered."""
        from apps.delivery.models import DeliveryDocument, DeliveryItem
        doc = self._make_doc(DeliveryDocument.STATUS_DELIVERED)
        item = DeliveryItem.objects.create(
            delivery_document=doc, order_item=self.order_item,
            product=self.product,
            quantity_planned=Decimal("3.00"), quantity_actual=Decimal("3.00"),
        )
        OrderItem.objects.filter(pk=self.order_item.pk).update(quantity_delivered=Decimal("3.00"))
        item.delete()
        self.order_item.refresh_from_db()
        self.assertEqual(self.order_item.quantity_delivered, Decimal("0.00"))

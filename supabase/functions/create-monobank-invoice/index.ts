import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "https://petal-pearl.github.io",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const token = Deno.env.get("MONOBANK_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !supabaseUrl || !serviceKey) return json(503, { error: "Payment service is not configured yet." });

  try {
    const body = await req.json();
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length || rawItems.length > 50) return json(400, { error: "Invalid cart." });
    const name = String(body.customerName || "").trim().slice(0, 120);
    const phone = String(body.customerPhone || "").trim().slice(0, 40);
    const email = String(body.customerEmail || "").trim().slice(0, 180);
    if (!name || !phone) return json(400, { error: "Customer name and phone are required." });

    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const ids = [...new Set(rawItems.map((i: any) => Number(i.id)).filter((id: number) => Number.isSafeInteger(id) && id > 0))];
    if (!ids.length || ids.length !== new Set(rawItems.map((i: any) => Number(i.id))).size) return json(400, { error: "Invalid product IDs." });
    const { data: rows, error: productError } = await supabase.from("products").select("id,data").in("id", ids);
    if (productError || !rows) throw new Error("Could not validate catalog prices.");
    const byId = new Map(rows.map((r: any) => [Number(r.id), r.data]));
    const items: any[] = [];
    let amount = 0;
    for (const item of rawItems) {
      const id = Number(item.id), qty = Number(item.quantity);
      const product: any = byId.get(id);
      if (!product || !Number.isSafeInteger(qty) || qty < 1 || qty > 10000) return json(400, { error: "A product or quantity is invalid." });
      const unitPrice = qty > 10 ? Number(product.wholesalePrice) : Number(product.retailPrice);
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) return json(400, { error: "A product has an invalid price." });
      const lineTotal = Math.round(unitPrice * 100) * qty;
      amount += lineTotal;
      items.push({ id, name: String(product.name || "Товар").slice(0, 200), quantity: qty, unitPrice: Math.round(unitPrice * 100), total: lineTotal });
    }
    if (!Number.isSafeInteger(amount) || amount < 100 || amount > 100000000) return json(400, { error: "Order total is outside allowed limits." });

    const reference = "PP-" + crypto.randomUUID();
    const { error: insertError } = await supabase.from("payment_orders").insert({
      reference, amount, currency: 980, items, customer_name: name, customer_phone: phone, customer_email: email || null, status: "pending"
    });
    if (insertError) throw new Error("Could not create order record.");

    const invoicePayload = {
      amount,
      ccy: 980,
      merchantPaymInfo: {
        reference,
        destination: "Замовлення Petal & Pearl",
        comment: "Оплата замовлення Petal & Pearl",
        customerEmails: email ? [email] : [],
        basketOrder: items.map((i) => ({ name: i.name, qty: i.quantity, sum: i.unitPrice, total: i.total, unit: "шт.", code: String(i.id) }))
      },
      redirectUrl: "https://petal-pearl.github.io/Petal-Pearl/?payment=return",
      webHookUrl: supabaseUrl + "/functions/v1/monobank-webhook"
    };
    const paymentResponse = await fetch("https://api.monobank.ua/api/merchant/invoice/create", {
      method: "POST",
      headers: { "X-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify(invoicePayload)
    });
    const payment = await paymentResponse.json();
    if (!paymentResponse.ok || !payment.invoiceId || !payment.pageUrl) {
      await supabase.from("payment_orders").update({ status: "failure" }).eq("reference", reference);
      console.error("Monobank invoice creation failed:", paymentResponse.status, JSON.stringify(payment));
      return json(502, { error: "Monobank could not create the payment invoice. Check merchant setup and token." });
    }
    const { error: updateError } = await supabase.from("payment_orders")
      .update({ invoice_id: payment.invoiceId, payment_url: payment.pageUrl, updated_at: new Date().toISOString() })
      .eq("reference", reference);
    if (updateError) throw new Error("Invoice created but order update failed.");
    return json(200, { paymentUrl: payment.pageUrl, reference });
  } catch (error) {
    console.error("create-monobank-invoice error:", error);
    return json(500, { error: error instanceof Error ? error.message : "Unexpected payment error." });
  }
});

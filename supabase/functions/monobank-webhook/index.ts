import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function derEcdsaToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("Invalid ECDSA signature");
  let offset = der[1] < 0x80 ? 2 : 2 + (der[1] & 0x7f);
  if (der[offset++] !== 0x02) throw new Error("Invalid ECDSA r");
  const rLen = der[offset++];
  let r = der.slice(offset, offset + rLen); offset += rLen;
  if (der[offset++] !== 0x02) throw new Error("Invalid ECDSA s");
  const sLen = der[offset++];
  let ss = der.slice(offset, offset + sLen);
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (ss.length > 32 && ss[0] === 0) ss = ss.slice(1);
  if (r.length > 32 || ss.length > 32) throw new Error("ECDSA signature out of range");
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length); out.set(ss, 64 - ss.length);
  return out;
}
async function verifySignature(rawBody: Uint8Array, signatureB64: string, token: string): Promise<boolean> {
  const response = await fetch("https://api.monobank.ua/api/merchant/pubkey", { headers: { "X-Token": token } });
  if (!response.ok) throw new Error("Could not retrieve Monobank webhook public key.");
  const { key } = await response.json();
  const pem = new TextDecoder().decode(decodeBase64(key));
  const derText = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, "");
  const spki = decodeBase64(derText);
  const publicKey = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, derEcdsaToRaw(decodeBase64(signatureB64)), rawBody);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const token = Deno.env.get("MONOBANK_TOKEN");
  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !supabaseUrl || !serviceKey) return new Response("Payment webhook is not configured", { status: 503 });

  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    const signature = req.headers.get("x-sign") || req.headers.get("X-Sign");
    if (!signature || !(await verifySignature(raw, signature, token))) return new Response("Invalid signature", { status: 401 });
    const event = JSON.parse(new TextDecoder().decode(raw));
    if (!event.invoiceId || !event.status) return new Response("Invalid event", { status: 400 });
    const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
    const { data: order, error } = await supabase.from("payment_orders").select("*").eq("invoice_id", event.invoiceId).maybeSingle();
    if (error || !order) return new Response("Order not found", { status: 404 });
    if (Number(event.amount) !== Number(order.amount) || Number(event.ccy || 980) !== Number(order.currency)) return new Response("Amount mismatch", { status: 409 });

    const modified = event.modifiedDate ? new Date(event.modifiedDate) : new Date();
    const oldModified = order.payment_status_modified_at ? new Date(order.payment_status_modified_at) : null;
    if (oldModified && modified < oldModified) return new Response("Stale event ignored", { status: 200 });
    const statusMap: Record<string, string> = { success: "success", processing: "processing", failure: "failure", expired: "expired" };
    const nextStatus = statusMap[event.status] || order.status;
    const shouldNotify = nextStatus === "success" && order.status !== "success" && !order.telegram_notified_at;
    const { error: saveError } = await supabase.from("payment_orders").update({
      status: nextStatus, payment_status_modified_at: modified.toISOString(), updated_at: new Date().toISOString()
    }).eq("id", order.id);
    if (saveError) throw saveError;

    if (shouldNotify && botToken && chatId) {
      const lines = (order.items || []).map((i: any) => "• " + i.name + " × " + i.quantity + " — " + (i.total / 100).toFixed(2) + " грн");
      const message = [
        "🌸 Petal & Pearl — ОПЛАТА ПІДТВЕРДЖЕНА",
        "Замовлення: " + order.reference,
        "Покупець: " + (order.customer_name || "не вказано"),
        "Телефон: " + (order.customer_phone || "не вказано"),
        ...lines,
        "Разом: " + (order.amount / 100).toFixed(2) + " грн",
        "Статус: " + event.status,
        "Invoice: " + event.invoiceId
      ].join("\n");
      const telegramResponse = await fetch("https://api.telegram.org/bot" + botToken + "/sendMessage", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: message })
      });
      if (!telegramResponse.ok) {
        console.error("Telegram notification failed:", await telegramResponse.text());
      } else {
        await supabase.from("payment_orders").update({ telegram_notified_at: new Date().toISOString() }).eq("id", order.id);
      }
    } else if (shouldNotify) {
      console.warn("Payment succeeded but Telegram secrets are not configured.");
    }
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("monobank-webhook error:", error);
    return new Response("Webhook processing failed", { status: 500 });
  }
});

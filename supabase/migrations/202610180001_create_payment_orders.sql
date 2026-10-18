create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  invoice_id text unique,
  status text not null default 'pending' check (status in ('pending','processing','success','failure','expired')),
  amount integer not null check (amount > 0),
  currency integer not null default 980,
  items jsonb not null,
  customer_name text,
  customer_phone text,
  customer_email text,
  payment_url text,
  payment_status_modified_at timestamptz,
  telegram_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.payment_orders enable row level security;
revoke all on public.payment_orders from anon, authenticated;

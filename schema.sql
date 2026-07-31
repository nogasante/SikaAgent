-- Sika Agent v1 — multi-tenant schema
-- Run in Supabase SQL Editor (new project)

create table vendors (
  id uuid primary key default gen_random_uuid(),
  shop_name text not null,
  owner_name text not null,
  owner_phone text not null,        -- vendor's personal WhatsApp, e.g. whatsapp:+233XX  (vendor console + notifications)
  twilio_number text unique not null, -- the dedicated business line, e.g. whatsapp:+1415XX
  city text,
  delivery_note text,               -- e.g. "Accra GHS 20, Madina GHS 25, arrives next day"
  tone_note text,                   -- e.g. "warm, uses 🔥 and 💕, light pidgin ok"
  is_demo boolean default false,    -- judge/demo vendor: fake payment flow
  active boolean default true,
  created_at timestamptz default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id) on delete cascade,
  name text not null,
  price int not null,               -- GHS
  options text,                     -- "S, M, L" / "shades: 1-5"
  in_stock boolean default true,
  notes text,                       -- anything the AI should know
  created_at timestamptz default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id) on delete cascade,
  customer_number text not null,
  ai_paused boolean default false,  -- kill switch: vendor took over this thread
  ai_resumed_at timestamptz,        -- owner handed the thread back; AI reads history from here
  created_at timestamptz default now(),
  unique (vendor_id, customer_number)
);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  role text not null,               -- customer | agent | vendor
  content text not null,
  created_at timestamptz default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id),
  conversation_id uuid references conversations(id),
  summary text,                     -- "Ankara two-piece, size M, deliver Madina"
  amount int not null,              -- GHS total
  status text default 'pending',    -- payment only: pending | paid | cancelled
  payment_ref text unique,
  paid_at timestamptz,
  delivered_at timestamptz,         -- fulfilment, kept off status so revenue totals stay intact
  created_at timestamptz default now()
);

create table escalations (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid references vendors(id),
  conversation_id uuid references conversations(id),
  reason text,
  resolved boolean default false,
  created_at timestamptz default now()
);

-- Hackathon evidence: every AI decision, timestamped, continuously.
create table agent_logs (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid,
  conversation_id uuid,
  action text not null,  -- received | replied | created_order | sent_payment_link | payment_confirmed | escalated | paused | daily_report
  detail jsonb,
  created_at timestamptz default now()
);

create index idx_msgs_convo on messages(conversation_id, created_at);
create index idx_logs_time on agent_logs(created_at);

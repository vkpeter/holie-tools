-- Nieuwsbrief uit @holie/tools 0.25.0: verzendregister en onderdrukkingslijst.
-- Idempotent: opnieuw draaien verandert niets. Enkel service_role raakt deze objecten.
--
-- Gebruik (edge function, service role):
--   1. ids = nieuwsbrief_claim(uitgave, alle_ontvanger_ids)   -- enkel wie deze uitgave nog niet kreeg
--   2. verstuur naar ids (per batch van 100, Idempotency-Key = uitgave + batchnummer)
--   3. mislukt een batch: nieuwsbrief_vrijgeven(uitgave, ids_van_die_batch), dan kan een herhaling ze opnieuw
-- Ontvanger is een vrije tekst (meestal het id van de abonnee), nooit het e-mailadres zelf.

create table if not exists public.nieuwsbrief_verzending (
  uitgave text not null,
  ontvanger text not null,
  geclaimd_op timestamptz not null default now(),
  primary key (uitgave, ontvanger)
);

create index if not exists nieuwsbrief_verzending_tijd
  on public.nieuwsbrief_verzending (geclaimd_op);

alter table public.nieuwsbrief_verzending enable row level security;
revoke all on public.nieuwsbrief_verzending from public, anon, authenticated;
grant select, insert, delete on public.nieuwsbrief_verzending to service_role;

-- Adressen die nooit meer gemaild worden: harde bounce of spamklacht (Resend-webhook).
-- Bewaard als sha256 van het adres in kleine letters, zodat de lijst zelf geen adressen bevat.
create table if not exists public.nieuwsbrief_onderdrukt (
  adres_hash text primary key check (adres_hash ~ '^[0-9a-f]{64}$'),
  reden text not null check (reden in ('bounce', 'klacht', 'handmatig')),
  sinds timestamptz not null default now()
);

alter table public.nieuwsbrief_onderdrukt enable row level security;
revoke all on public.nieuwsbrief_onderdrukt from public, anon, authenticated;
grant select, insert, update, delete on public.nieuwsbrief_onderdrukt to service_role;

-- Claimt de ontvangers voor een uitgave en geeft enkel wie nog niet geclaimd was terug.
-- Twee gelijktijdige runs krijgen elk een ander deel (de primary key beslist), nooit dezelfde.
create or replace function public.nieuwsbrief_claim(p_uitgave text, p_ontvangers text[])
returns setof text
language sql
volatile
security invoker
set search_path = public
as $$
  insert into public.nieuwsbrief_verzending (uitgave, ontvanger)
  select p_uitgave, o from unnest(p_ontvangers) as o
  where p_uitgave is not null and p_uitgave <> '' and o is not null and o <> ''
  on conflict do nothing
  returning ontvanger;
$$;

-- Geeft een claim terug vrij (een batch die niet vertrok).
create or replace function public.nieuwsbrief_vrijgeven(p_uitgave text, p_ontvangers text[])
returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_aantal integer;
begin
  delete from public.nieuwsbrief_verzending
  where uitgave = p_uitgave and ontvanger = any (p_ontvangers);
  get diagnostics v_aantal = row_count;
  return v_aantal;
end;
$$;

-- Zet adressen op de onderdrukkingslijst. Een klacht weegt zwaarder dan een bounce.
create or replace function public.nieuwsbrief_onderdruk(p_adressen text[], p_reden text)
returns integer
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_aantal integer;
begin
  insert into public.nieuwsbrief_onderdrukt (adres_hash, reden)
  select distinct encode(sha256(convert_to(lower(btrim(a)), 'UTF8')), 'hex'), p_reden
  from unnest(p_adressen) as a
  where a is not null and btrim(a) <> ''
  on conflict (adres_hash) do update
    set reden = case when excluded.reden = 'klacht' then 'klacht' else nieuwsbrief_onderdrukt.reden end;
  get diagnostics v_aantal = row_count;
  return v_aantal;
end;
$$;

revoke all on function public.nieuwsbrief_claim(text, text[]) from public, anon, authenticated;
revoke all on function public.nieuwsbrief_vrijgeven(text, text[]) from public, anon, authenticated;
revoke all on function public.nieuwsbrief_onderdruk(text[], text) from public, anon, authenticated;
grant execute on function public.nieuwsbrief_claim(text, text[]) to service_role;
grant execute on function public.nieuwsbrief_vrijgeven(text, text[]) to service_role;
grant execute on function public.nieuwsbrief_onderdruk(text[], text) to service_role;

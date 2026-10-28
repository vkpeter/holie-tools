-- rate_limit_hit uit @holie/tools 0.18.0 (lat N3): tellen en registreren in een stap.
-- Idempotent: opnieuw draaien verandert niets.

create table if not exists public.rate_limit_hits (
  id bigint generated always as identity primary key,
  sleutel text not null,
  endpoint text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_limit_hits_endpoint_sleutel_tijd
  on public.rate_limit_hits (endpoint, sleutel, created_at desc);
create index if not exists rate_limit_hits_tijd
  on public.rate_limit_hits (created_at);

-- Enkel de functie hieronder (security definer) raakt deze tabel.
alter table public.rate_limit_hits enable row level security;
revoke all on public.rate_limit_hits from public, anon, authenticated;

create or replace function public.rate_limit_hit(
  _key text,
  _endpoint text,
  _max_requests integer,
  _window_minutes integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  _aantal integer;
begin
  if _key is null or _endpoint is null or _max_requests is null or _window_minutes is null then
    raise exception 'rate_limit_hit: argumenten mogen niet null zijn' using errcode = '22004';
  end if;
  -- De opkuis wist alles ouder dan 25 uur: een langer venster zou nooit volledig tellen.
  if _window_minutes < 1 or _window_minutes > 1500 or _max_requests < 1 then
    raise exception 'rate_limit_hit: venster 1..1500 minuten, max_requests >= 1' using errcode = '22023';
  end if;

  -- Serialiseert gelijktijdige hits op dezelfde sleutel tot het einde van de transactie.
  perform pg_advisory_xact_lock(hashtext(_endpoint || ':' || _key));

  select count(*) into _aantal
  from public.rate_limit_hits
  where endpoint = _endpoint
    and sleutel = _key
    and created_at > now() - make_interval(mins => _window_minutes);

  if _aantal < _max_requests then
    insert into public.rate_limit_hits (sleutel, endpoint) values (_key, _endpoint);
    -- Opkuis: rijen ouder dan 25 uur (langer dan het grootste venster), hoogstens 500 per hit.
    -- skip locked: twee hits tegelijk wachten nooit op elkaars opkuis, en na een piek
    -- verdeelt de opkuis zich over de volgende hits in plaats van er een te laten hangen.
    delete from public.rate_limit_hits
    where id in (
      select id from public.rate_limit_hits
      where created_at < now() - interval '25 hours'
      order by created_at
      limit 500
      for update skip locked
    );
    return true;
  end if;

  return false;
end;
$$;

revoke all on function public.rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, text, integer, integer) to service_role;

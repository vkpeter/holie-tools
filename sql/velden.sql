-- velden uit @holie/tools 0.31.0: Postgres-kant van ./velden (velden.ts).
-- Kopieer in een migratie van de app. Idempotent: opnieuw draaien verandert niets.
--
-- Waarom: iOS en kopieer-plak zetten onzichtbare opmaaktekens (Unicode Cf:
-- U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+FEFF) en NBSP (U+00A0,
-- U+202F) in een veld. btrim() haalt die niet weg. Deze functies wel, met
-- dezelfde regels als velden.ts. Gebruik ze in triggers, check-constraints en
-- generated columns, naast (niet in plaats van) de normalisatie in het scherm.
--
-- Verschillen met velden.ts:
-- - norm_telefoon en norm_postcode nemen enkel een ISO alpha-2-code als land
--   (BE, NL, ...), geen landnaam. Normaliseer de naam eerst met normaliseerLand.
-- - norm_regel en norm_email geven null bij null; een leeg resultaat is bij
--   norm_email ook null (bij norm_regel een lege tekst).
-- - lower() maakt in Postgres van I met punt (U+0130) een teken, JavaScript twee:
--   alleen een adres van ~254 tekens vol met dat teken krijgt een ander oordeel.
-- - Landentabel voor telefoon: dezelfde als TELEFOON_LANDEN in velden.ts. Breid
--   op beide plaatsen uit.

-- Onzichtbare opmaaktekens (Cf) weg, overal in de tekst.
create or replace function public.strip_cf(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    t,
    '[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001\U000E0020-\U000E007F]',
    '',
    'g'
  )
$$;

-- Zelfde, maar de zero-width joiner (U+200D) en de emoji-tagtekens blijven
-- staan, zodat samengestelde emoji in vrije tekst heel blijven. Voor norm_regel.
create or replace function public.strip_cf_tekst(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select regexp_replace(
    t,
    '[\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\U000110BD\U000110CD\U00013430-\U0001343F\U0001BCA0-\U0001BCA3\U0001D173-\U0001D17A\U000E0001]',
    '',
    'g'
  )
$$;

-- Tekst van een regel: Cf weg, elke soort spatie (NBSP, regeleinden, tabs) een
-- gewone spatie, dubbele spaties samen, begin en einde af.
create or replace function public.norm_regel(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select btrim(
    regexp_replace(
      public.strip_cf_tekst(t),
      '[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',
      ' ',
      'g'
    ),
    ' '
  )
$$;

-- E-mail: Cf overal weg, spaties aan de rand af, kleine letters. Geeft de
-- opgeschoonde tekst terug, ook als het geen geldig adres is (zie email_geldig);
-- null bij null of leeg.
create or replace function public.norm_email(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    lower(
      regexp_replace(
        public.strip_cf(t),
        '^[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$',
        '',
        'g'
      )
    ),
    ''
  )
$$;

-- Is dit een bruikbaar adres? Zelfde regels als normaliseerEmail: hoogstens 254
-- tekens (ook v\u00F3\u00F3r het strippen), geen spaties of stuurtekens midden in het
-- adres, geen punt vooraan, achteraan of dubbel in het lokale deel, geen
-- <>"(),;:\[], domein enkel letters, cijfers en koppeltekens per label.
create or replace function public.email_geldig(t text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    length(t) <= 254
    and length(n) <= 254
    and n ~ '^[^\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000@.<>"(),;:\\\[\]\u0001-\u001F\u007F-\u009F]+(\.[^\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000@.<>"(),;:\\\[\]\u0001-\u001F\u007F-\u009F]+)*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$',
    false
  )
  from (select public.norm_email(t) as n) x
$$;

-- Telefoon naar E.164 (+32475123456), of null. Regels: zie normaliseerTelefoon.
-- De tabel hieronder is "land:landnummer:nationale nul" (weg = nul valt weg,
-- blijft = nul hoort bij het nummer, geen = land kent geen nul).
create or replace function public.norm_telefoon(
  t text,
  standaard_land text default 'BE'
)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  landen constant text[] := array[
    'BE:32:weg', 'NL:31:weg', 'LU:352:geen', 'FR:33:weg', 'DE:49:weg',
    'GB:44:weg', 'CH:41:weg', 'AT:43:weg', 'ES:34:geen', 'IT:39:blijft',
    'MA:212:weg', 'TR:90:weg'
  ];
  s text;
  digits text;
  e164 text;
  land text := upper(btrim(coalesce(standaard_land, '')));
  c text;
  nul text;
  rij text;
  delen text[];
begin
  if t is null or length(t) > 64 then
    return null;
  end if;

  s := regexp_replace(
    public.strip_cf(t),
    '[\s\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+',
    '',
    'g'
  );
  -- "(0)" na het landnummer is ballast: weg v\u00F3\u00F3r de haakjes zelf verdwijnen.
  if s like '+%' or s like '00%' then
    s := replace(s, '(0)', '');
  end if;
  s := regexp_replace(s, '[./()-]', '', 'g');
  if s !~ '^\+?[0-9]+$' then
    return null;
  end if;

  if s like '+%' or s like '00%' then
    digits := case when s like '+%' then substr(s, 2) else substr(s, 3) end;
    -- "+32 0475...": de nationale nul hoort na het landnummer niet te staan.
    foreach rij in array landen loop
      delen := string_to_array(rij, ':');
      if digits like delen[2] || '%' then
        if delen[3] = 'weg'
           and substr(digits, length(delen[2]) + 1, 1) = '0' then
          digits := delen[2] || substr(digits, length(delen[2]) + 2);
        end if;
        exit;
      end if;
    end loop;
    e164 := '+' || digits;
  else
    foreach rij in array landen loop
      delen := string_to_array(rij, ':');
      if delen[1] = land then
        c := delen[2];
        nul := delen[3];
      end if;
    end loop;
    if c is null then
      return null;
    end if;
    if nul = 'weg' then
      if s not like '0%' then
        return null;
      end if;
      e164 := '+' || c || substr(s, 2);
    elsif nul = 'blijft' then
      e164 := '+' || c || s;
    else
      if s like '0%' then
        return null;
      end if;
      e164 := '+' || c || s;
    end if;
  end if;

  if e164 !~ '^\+[1-9][0-9]{7,14}$' then
    return null;
  end if;
  if e164 like '+32%' and e164 !~ '^\+32[1-9][0-9]{7,8}$' then
    return null;
  end if;
  if e164 like '+31%' and e164 !~ '^\+31[1-9][0-9]{8}$' then
    return null;
  end if;
  return e164;
end
$$;

-- Postcode in de vaste schrijfwijze van het land, of null. land = ISO alpha-2.
-- BE 4 cijfers (eerste 1-9); NL "1234 AB" (niet SA, SD, SS); LU 4 cijfers;
-- DE en FR 5 cijfers; rest: A-Z 0-9 spatie koppelteken, hoogstens 12 tekens.
create or replace function public.norm_postcode(t text, land text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  s text;
  l text := upper(btrim(coalesce(land, '')));
  m text[];
begin
  if t is null or length(t) > 64 then
    return null;
  end if;
  s := upper(public.norm_regel(t));
  if s = '' then
    return null;
  end if;

  -- Voorvoegsel zoals B-1000 of L-1234.
  if l in ('BE', 'NL', 'LU', 'DE', 'FR') and s ~ '^[A-Z]{1,2} ?-? ?[0-9]' then
    s := regexp_replace(
      s,
      case l
        when 'BE' then '^(BE|B) ?-? ?'
        when 'NL' then '^NL ?-? ?'
        when 'LU' then '^(LU|L) ?-? ?'
        when 'DE' then '^(DE|D) ?-? ?'
        else '^(FR|F) ?-? ?'
      end,
      ''
    );
  end if;

  if l = 'BE' then
    return case when s ~ '^[1-9][0-9]{3}$' then s end;
  elsif l = 'NL' then
    m := regexp_match(s, '^([1-9][0-9]{3}) ?([A-Z]{2})$');
    if m is null or m[2] in ('SA', 'SD', 'SS') then
      return null;
    end if;
    return m[1] || ' ' || m[2];
  elsif l = 'LU' then
    return case when s ~ '^[0-9]{4}$' then s end;
  elsif l in ('DE', 'FR') then
    return case when s ~ '^[0-9]{5}$' then s end;
  end if;
  return case
    when length(s) <= 12 and s ~ '^[A-Z0-9][A-Z0-9 -]*$' then s
  end;
end
$$;

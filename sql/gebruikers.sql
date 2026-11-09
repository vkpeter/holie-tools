-- gebruikers uit @holie/tools 0.32.0: Postgres-kant van ./gebruikers (gebruikers.ts).
-- Kopieer in een migratie van de app en pas de rollen aan. Idempotent.
--
-- Twee delen:
--   1. account_op_email: het account bij een e-mailadres, voor zoekAccountOpEmail en nodigUit.
--      Enkel de service-role mag hem aanroepen (anders verklapt hij wie een account heeft).
--   2. rol_zetten: de rolbewaking, naar het voorbeeld van Tickbook (9 nov 2026). Het scherm en de
--      server toetsen dezelfde regels met magRolWijzigen, maar enkel de databank doet het
--      atomair: twee beheerders die elkaar tegelijk degraderen, zien elk nog een andere beheerder.
--      Deze functie weigert:
--        - een aanroeper die geen beheerder is,
--        - de eigen rol wijzigen,
--        - een rol buiten de toewijsbare,
--        - de laatste beheerder degraderen.
--
-- Het sjabloon gaat uit van het meest voorkomende model:
--   create type public.app_role as enum ('admin', 'user', ...);
--   create table public.user_roles (user_id uuid references auth.users on delete cascade,
--                                   role public.app_role, unique (user_id, role));
-- Een ander model (rollen per organisatie, profiles.role): houd de vier weigeringen en de
-- "for update" op de beheerdersrijen, vervang de tabel- en kolomnamen.

-- ── 1. Account bij een e-mailadres ────────────────────────────────────────────────────────────
create or replace function public.account_op_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
    from auth.users u
   where lower(u.email) = lower(btrim(p_email))
   order by u.created_at
   limit 1
$$;

revoke all on function public.account_op_email(text) from public;
revoke all on function public.account_op_email(text) from anon;
revoke all on function public.account_op_email(text) from authenticated;
grant execute on function public.account_op_email(text) to service_role;

-- ── 2. Rolbewaking ────────────────────────────────────────────────────────────────────────────
-- Pas aan per app:
--   v_beheerders: de rollen die als beheerder tellen (magRolWijzigen: instelling.beheerders);
--   v_toewijsbaar: de rollen die het scherm zet (instelling.toewijsbaar). Andere rollen van de
--                  gebruiker (bv. een key_user die uit een grant volgt) blijven staan.
-- Eén rol per gebruiker (instelling.meerdere = false). Voor meerdere rollen: neem p_rollen text[]
-- en vervang de insert door een insert per element.
create or replace function public.rol_zetten(p_user uuid, p_rol text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_beheerders public.app_role[] := array['admin']::public.app_role[];
  v_toewijsbaar text[] := array['admin', 'user'];
  v_rol public.app_role;
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_roles
     where user_id = auth.uid() and role = any (v_beheerders)
  ) then
    raise exception 'Enkel een beheerder kan een rol zetten.' using errcode = '42501';
  end if;
  if p_user is null or p_rol is null then
    raise exception 'Gebruiker en rol zijn verplicht.' using errcode = '22023';
  end if;
  if p_user = auth.uid() then
    raise exception 'Je kunt je eigen rol niet wijzigen.' using errcode = '42501';
  end if;
  if not (p_rol = any (v_toewijsbaar)) then
    raise exception 'Onbekende rol: %.', p_rol using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'Gebruiker niet gevonden.' using errcode = 'P0002';
  end if;
  v_rol := p_rol::public.app_role;

  -- Beheerdersrijen vastzetten: twee gelijktijdige degradaties steken elkaar niet voorbij.
  perform 1 from public.user_roles where role = any (v_beheerders) for update;

  if not (v_rol = any (v_beheerders))
     and exists (select 1 from public.user_roles where user_id = p_user and role = any (v_beheerders))
     and not exists (
       select 1 from public.user_roles
        where role = any (v_beheerders) and user_id <> p_user
     ) then
    raise exception 'Je kunt de laatste beheerder niet degraderen.' using errcode = '42501';
  end if;

  -- Enkel de toewijsbare rollen vervangen; andere rollen blijven staan.
  delete from public.user_roles
   where user_id = p_user
     and role::text = any (v_toewijsbaar);
  insert into public.user_roles (user_id, role) values (p_user, v_rol)
  on conflict (user_id, role) do nothing;
end;
$$;

revoke all on function public.rol_zetten(uuid, text) from public;
revoke all on function public.rol_zetten(uuid, text) from anon;
grant execute on function public.rol_zetten(uuid, text) to authenticated;

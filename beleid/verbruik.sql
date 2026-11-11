-- D1-database holie-ai-verbruik (binding VERBRUIK van de Worker holie-ai-beleid), fase D van het
-- AI-beleid (1 nov 2026). Een regel per dag (Europe/Brussels), project, provider en type; de
-- Worker telt elke melding van @holie/tools op (POST /verbruik). Tickbook haalt het dagelijks op
-- (VPS-taak holie-ai-verbruik) en bewaart het in ai_verbruik_dag; hier volstaat een korte historie.
-- Uitrollen: npx wrangler@4 d1 execute holie-ai-verbruik --remote --file verbruik.sql
CREATE TABLE IF NOT EXISTS verbruik (
  dag TEXT NOT NULL,
  project TEXT NOT NULL,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  aanroepen INTEGER NOT NULL DEFAULT 0,
  usd REAL NOT NULL DEFAULT 0,
  terugval INTEGER NOT NULL DEFAULT 0,
  zonder_label INTEGER NOT NULL DEFAULT 0,
  fouten INTEGER NOT NULL DEFAULT 0,
  bijgewerkt TEXT NOT NULL,
  PRIMARY KEY (dag, project, provider, type)
);

-- Storingen (0.33.0): welke provider faalde, per dag en project. Gevuld via `storingen` op een
-- regel van POST /verbruik; gelezen door GET /storing?dag= (VPS-taak ai_storing, Telegram per
-- provider per dag). soort = tegoed (credit balance) of fout (429, 5xx, timeout).
CREATE TABLE IF NOT EXISTS storing (
  dag TEXT NOT NULL,
  provider TEXT NOT NULL,
  soort TEXT NOT NULL,
  project TEXT NOT NULL,
  aantal INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  eerste TEXT NOT NULL,
  laatste TEXT NOT NULL,
  PRIMARY KEY (dag, provider, soort, project)
);

-- Cache en batch (0.34.0): tokens uit en naar de cache (5 minuten en 1 uur) en batchtellers, per
-- dag, project, provider en type. Aparte tabel zodat `verbruik` ongewijzigd blijft. Eerst uitrollen
-- (npx wrangler@4 d1 execute holie-ai-verbruik --remote --file verbruik.sql), dan pas de Worker
-- bijwerken: een regel met extra tellers faalt zolang deze tabel ontbreekt.
-- batch_aanroepen: verzoeken via de Batch API (tegen het halve tarief, al in `verbruik.usd`);
-- batch_gewist en batch_wis_mislukt: batches waarvan de DELETE na het ophalen lukte of mislukte.
CREATE TABLE IF NOT EXISTS verbruik_extra (
  dag TEXT NOT NULL,
  project TEXT NOT NULL,
  provider TEXT NOT NULL,
  type TEXT NOT NULL,
  cache_lees INTEGER NOT NULL DEFAULT 0,
  cache_schrijf_5m INTEGER NOT NULL DEFAULT 0,
  cache_schrijf_1u INTEGER NOT NULL DEFAULT 0,
  batch_aanroepen INTEGER NOT NULL DEFAULT 0,
  batch_gewist INTEGER NOT NULL DEFAULT 0,
  batch_wis_mislukt INTEGER NOT NULL DEFAULT 0,
  bijgewerkt TEXT NOT NULL,
  PRIMARY KEY (dag, project, provider, type)
);

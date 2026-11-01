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

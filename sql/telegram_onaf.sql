-- telegram_onaf uit @holie/tools 0.27.0: kort geheugen van een Telegram-bot.
-- Een rij = een bericht waarop de bot een verduidelijking vroeg. De bot leest de rijen
-- van de laatste 10 minuten voor hij de AI vraagt, en wist ze zodra hij iets uitvoert.
-- Idempotent: opnieuw draaien verandert niets.

create table if not exists public.telegram_onaf (
  id bigint generated always as identity primary key,
  chat_id bigint not null,
  tekst text not null,
  antwoord text,
  gemaakt_op timestamptz not null default now()
);

create index if not exists telegram_onaf_chat_tijd
  on public.telegram_onaf (chat_id, gemaakt_op desc);

-- Enkel de bot (service role) raakt deze tabel.
alter table public.telegram_onaf enable row level security;
revoke all on public.telegram_onaf from public, anon, authenticated;

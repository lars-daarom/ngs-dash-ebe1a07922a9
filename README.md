# Nedgame zoekmodel — live dashboard

Live monitor van het zelflerende zoekalgoritme voor Nedgame (Supabase-project `nedgame-search`).
Laat zien welke signalen binnenkomen, wat elke leerstap (elke 5 minuten) oplevert, wat het model
geleerd heeft en hoe de VWO-variant presteert tegenover de controle.

## Toegang

Geen login: open de URL en het dashboard laadt direct. De dashboard-functies in Supabase zijn
openbaar leesbaar (alleen geaggregeerde, gemaskeerde cijfers). Weer afschermen kan met:

```sql
create or replace function search.dash_ok(p_token text) returns boolean language sql stable security definer
set search_path to 'search','extensions','public' as $$
  select exists (select 1 from private.dashboard_tokens where hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex'));
$$;
```

## Hoe het werkt

- `search_dashboard()` — alle geaggregeerde cijfers, elke 30 seconden ververst
- `search_dashboard_feed(p_since)` — laatste gebeurtenissen voor de live-animatie, elke 5 seconden
- Geen bezoekers-id's; zoekteksten met e-mailadressen, lange cijferreeksen of links worden gemaskeerd
- Statische site zonder build-stap: `index.html`, `style.css`, `app.js`

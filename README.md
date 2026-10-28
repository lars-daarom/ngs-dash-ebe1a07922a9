# Nedgame zoekmodel — live dashboard

Live monitor van het zelflerende zoekalgoritme voor Nedgame (Supabase-project `nedgame-search`).
Laat zien welke signalen binnenkomen, wat elke leerstap (elke 5 minuten) oplevert, wat het model
geleerd heeft en hoe de VWO-variant presteert tegenover de controle.

## Toegang

De data staat achter een dashboard-token. Maak er een aan in de Supabase SQL editor:

```sql
select private.dashboard_new_token('naam van de gebruiker');
```

Het token wordt maar één keer getoond (in de database staat alleen een hash). Intrekken:

```sql
delete from private.dashboard_tokens where label = 'naam van de gebruiker';
```

Je kunt het token ook meegeven in de link: `…/nedgame-zoek-dashboard/#t=TOKEN`. Het dashboard
bewaart het dan lokaal en haalt het meteen uit de adresbalk.

## Hoe het werkt

- `search_dashboard(p_token)` — alle geaggregeerde cijfers, elke 30 seconden ververst
- `search_dashboard_feed(p_token, p_since)` — laatste gebeurtenissen voor de live-animatie, elke 5 seconden
- Geen bezoekers-id's; zoekteksten met e-mailadressen, lange cijferreeksen of links worden gemaskeerd
- Statische site zonder build-stap: `index.html`, `style.css`, `app.js`

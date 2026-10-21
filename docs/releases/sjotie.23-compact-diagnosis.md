# Compact: oorzaakmeting en ontwerpopties — #1916

Onderzoek en observatie, geen productfix. De productbron blijft plugin
`5a0ea2e099a9b3e275ae72604d83722da8273fb2`, vendored factory-core
`3982b9947291996586bddf6fe06736c71ed63818` (module SHA256
`e0c4c59fb32f4329b4759e3849849b834a361fe543e0ba97d4b6f61ad9502842`).
De reeds gebouwde branches zijn uitsluitend als backup gepusht; geen landing,
tag, publicatie of installatie-update. Een fix volgt pas na ontwerpkeuze en
cross-family ontwerpreview.

## Meetcontract

De vervolgmeting bewijst nu een stale Bash-envelop: na de echte compact
bevat het ongewijzigde exportbestand de nieuwe g1, maar Bash draagt nog
exact de oude g0. De precieze interne Claude-cache-/afleveringsstap is niet
vastgesteld. Dit onderscheid blijft staan.

De vervolgmeting gebruikt de echte Claude Code 2.1.301-PTY, vaste
producthookcommands en sandboxed `/codex:native-probe`. De harness verandert
geen productbron of weigerregel. Eén `acquire({deadlineMs:0})` gebruikt dezelfde
enkele poging als `tryAcquire`, maar bewaart de werkelijke weigerreden.
Een observer rond de vaste SQLite-SELECT retourneert het oorspronkelijke
resultaat ongewijzigd. Hij opent geen extra A-verbinding in de houder-PID:
het sluiten van een extra fd kan de procesgebonden fcntl-lock vrijgeven.

Per Bash-aanroep worden uitsluitend variabelenamen, hashes, generaties en
vaste protocol-/weigerlabels opgeslagen. Het bewijs bevat geen raw env,
certificaat, credential of sleutelwaarde. Een private versleutelde capture,
ook vóór een geweigerde acquire, dient alleen voor de gecontroleerde latere
replay. De verse decryptiesleutel blijft in RAM/child-ENV en wordt niet
gelogd. Deze testcapture is geen productcache of toelatingsautoriteit.

De meetlaag heeft 19 groene lokale controles. De oude 5a0ea2e-harness is
gericht rood: één bestaande weigering slaagt, twee observatievoorwaarden
(hash/capture bij weigering) falen. Valid, stale-generation en wrong-source
geven met en zonder observer dezelfde productbeslissing. GCM-tamper en een
ontbrekende sleutel geven een onbesliste capture, geen geslaagde weigertest.
Een observer-logfout verandert het oorspronkelijke SQL-resultaat niet en
markeert het bewijs onbeslist.

## Echte meting

De [duurzame JSON](sjotie.23-compact-evidence.json) bevat alle volledige
hashes en generaties; onderstaande waarden zijn verkort voor leesbaarheid.
Alle 53 productbestanden zijn bytegelijk aan de bevroren kandidaat. Er was
precies één Bash-request vóór compact en één erna, elk met één gestarte
probe; na clear was er één geweigerd request en nul gestarte probes. Geen
verborgen retry of overschreven tweede probe; api-request-blob-kopieën met
hetzelfde tool-ID tellen niet dubbel.

| Aanroep | Bash-generatie / bron | Envelop-SHA256 | Store tijdens dezelfde acquire | Uitkomst |
|---|---|---|---|---|
| Voor compact | g0 `bf8a723173e8…` / resume | `cf7f1cfd1a63…` | ready / g0 | Toegelaten |
| Na echte compact | g0 `bf8a723173e8…` / resume | `cf7f1cfd1a63…` | ready / g1 `ef4dcba07a23…` | Geweigerd |
| Apart gecontroleerd g1-certificaat, zelfde sandbox | g1 `ef4dcba07a23…` / compact | `900d255735db…` | ready / g1 | Toegelaten; state ongewijzigd |
| Na echte clear | Probe niet gestart | Niet gemeten | Alleen readonly footprint beschikbaar | Automatische goedkeuring weigerde de gewone Bash-probe |

De hook schrijft g1 naar hetzelfde ENV-bestand: pad-SHA256
`e57e9c61a721…` en bestandsidentiteit-SHA256 `6a942e93fa1e…` blijven
identiek, de inhoud-SHA256 verandert van `7c9009983425…` naar
`f762a5d18ed6…`. De managed completion bevat g1 en numeric exit zero.
De native/companion/record-SID-hashes, locator-epoch, basisverklaring-SHA256
`5f40958d21b0…` en A-identiteit blijven gelijk. Het huidige exportbestand
is dus daadwerkelijk vernieuwd; de Bash-envelop niet.

De eerste falende disjunct staat in de exacte corebron op
`shared/fenced-lock/fenced-lock.mjs:1390`, functie `validateSessionConsumer`:
`row.generation !== consumer.generation`. De rij bestaat en is ready;
het basiscertificaat is gelijk. De echte fout heet `StateLockTimeout`, code
`ESTATELOCKTIMEOUT`, met vaste reden
`session generation pending, revoked or foreign`. Dit is hier een bewezen
generatiemismatch, geen waargenomen SQLite-contention. De latere receiptcheck
wordt bij deze standaardaanroep niet bereikt. Alleen de generatie vernieuwen
zou bovendien een oude bron resume tegenover de huidige compact-receipt laten
staan; het nieuwe envelope moet uit volledig bewezen huidige metadata komen.

### Clear-beperking

Het actuele g1-certificaat is versleuteld vastgelegd én vóór clear succesvol
geconsumeerd in de echte sandbox. Dezelfde replay ná clear is nog niet
uitgevoerd: Claude auto mode weigerde de gewone
`/codex:native-probe`-Bash als **Code from External**. De harness heeft geen
permission gewijzigd, retry-route of uitroeptekenroute gebruikt.

Wel gemeten: SessionEnd met reason clear voor de oude SID, SessionStart clear
met een nieuwe SID; readonly na de proef staat de oude rij pending met een
andere generatie en zonder admission, en de eerder queued fixturejob is
cancelled. Dit is een footprint, geen vervanging voor de ontbrekende sandbox
replay. De bounded cleanup stopte alleen de eigen Claude-PID; die is aantoonbaar
weg. `keyAbsent=true`; geen raw certificaat of sleutelwaarde in het bewijs.
De functionele compactkandidaat blijft NO-GO.

## Wat het hookmodel ondersteunt

Volgens de officiële [hooksreferentie](https://code.claude.com/docs/en/hooks#persist-environment-variables)
kan SessionStart exports aan `CLAUDE_ENV_FILE` toevoegen; Bash voert dat
bestand vóór ieder command uit. SessionStart heeft een `compact`-bron.
PreCompact en PostCompact hebben die env-filevoorziening niet. Dit is een
gedocumenteerd mechanisme, geen bewijs van correcte aflevering in deze proef.

De geïnstalleerde arm64-binary meldt 2.1.301, SHA256
`1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`.
Embedded code/strings bevatten cache-invalidatie na SessionStart-completion
en de bron `compact`. Er is geen beslissende compact-specifieke caller
vastgesteld; statische strings bewijzen de runtimevolgorde niet.

De productplugin gebruikt al één vaste SessionStart-hook voor startup,
resume, compact en clear. Die schrijft eerst een lege admission-export en
daarna de nieuwe envelop. Een extra hook die hetzelfde nogmaals schrijft
is daarom geen onderbouwde fix.

## Voorwaardelijke ontwerpopties

| Optie | Veiligheidsmodel en kosten | Benodigd bewijs |
|---|---|---|
| **A. Lazy, vaste Bash-initializer onder dezelfde A** | SessionStart levert een vast Bash-startpad dat de actuele volledige envelop uit dezelfde A en de strikte receipt afleidt. De gewone stateconsumer blijft generatiegebonden. Geen prepare/scan/seal/repair/cache; alleen een geldige zelfde basisverklaring, SID/locator/epoch/root/A/F/hash, ready-row en actuele exacte exit-zero-receipt tellen. Kost een expliciet contract voor hernieuwbare toelating aan de Bash-ingang. Een algemene lazy upgrade in state.mjs zou óók oude workers opnieuw kunnen toelaten en is een grotere wijziging. | Eerst ontwerpreview: draait het vaste startpad daadwerkelijk bij iedere Bash, ook als Claude de omgevingsdata cachet? Daarna echte eerste Bash na manual én auto compact, complete source+generation, oude rechtstreeks gebruikte certificaten blijven geweigerd, bestaande workers vernieuwen niet vanzelf. Elke pending/crash/End/missing receipt/F/A/locator weigert; laatste acquire hercontroleert onder A. |
| **B. Claude-exportlevering/cache laten herstellen** | Behoudt de huidige generatiegebonden certificaten en dezelfde ene hook/autoriteit. De hook publiceert al correct; nogmaals schrijven in een extra compact-hook verhelpt de bewezen stale Bash-envelop niet. Vereist een ondersteunde providerfix of bewezen Claude-versie; beschikbaarheid en doorlooptijd liggen buiten deze plugin. | Een concrete versie/fix waarin hetzelfde exportbestand ook de eerste post-compact Bash bereikt. Herhaal alle vier SessionStart-bronnen, hookfouten/crashcuts en clear-replay. Een nieuwe receiptversie pas toelaten na eigen bewijs; geen installatie-update tijdens dit onderzoek. |
| **C. Compactpad expliciet uitsluiten** | Houdt fail-closed en één A intact, maar kost compactfunctionaliteit. Alleen releasebaar na expliciet eigenaarbesluit met zichtbare beperking en bewezen herstelroute. Dit is geen werkende compactfix en geen bewijs dat Claude's hele hookmodel onoplosbaar is. | Besluit over manual én automatische compact, geen stateverlies, duidelijke weigering en herstel via een nieuwe bewezen start. De actuele clear-replay moet nog worden gesloten. |

**Aanbeveling:** laat A als smalle Bash-initializer ontwerpen en cross-family
reviewen; behoud de strikte generatieconsumer voor bestaande workers. Het
per-Bash uitvoeren van die initializer is eerst een te bewijzen voorwaarde,
geen aanname. B bewaart het huidige veiligheidscontract het zuiverst, maar
vereist een provideroplossing; een extra schrijvende compact-hook is door deze
meting geen afdoende pluginfix. C blijft een expliciet scopebesluit. Er is geen
fix gekozen of gebouwd. De pending/ready-intrekking, strikte receiptvalidatie
en vaste Stop/End-paden blijven het uitgangspunt.

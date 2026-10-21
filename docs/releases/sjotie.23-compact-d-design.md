# D: capability behouden over compact — #1916

**Gebouwd en unit-getest op Linux (21-10-2026), native macOS-proef open.**
Het ontwerp hieronder kreeg een cross-family GO (Claude Opus) met
bouwvoorwaarden; hoe die zijn ingevuld staat in [Bouw](#bouw-21-10-2026)
onderaan. De basis van het ontwerp was plugin
`dae440e6565468fa6dfb3110eefecc583e993ee5`, core
`32948eebf590dc8b09e4581df4376d20f60c15fe`, met productmodule
`3982b9947291996586bddf6fe06736c71ed63818`. De
[oorzaakmeting](sjotie.23-compact-diagnosis.md) en
[bewijs-JSON](sjotie.23-compact-evidence.json) blijven het gemeten bewijs.
Geen landing, installatie-update, tag, publicatie of upstream-send.

## Herkomst van de eerdere eis

De directe bron is het orchestratorbericht **21-10-2026 16:42 Amsterdam**, in
deze workersessie: item `i6599`, seq `1000388`, command
`k18fqzhhsbe1d4jc9x88jv9nx98gqf32`, clientId `1916-companion-besluit`.
Factory registreert `provenance.kind=orchestrator`. Het bericht zegt letterlijk:

> bewijs invalidatie: nieuwe SessionStart (ook resume/compact/clear) maakt het
> oude certificaat ongeldig, fout/crash midden in SessionStart laat geen
> bruikbaar certificaat achter, ander sessie-id of andere root wordt geweigerd

Ticketbesluit `sn8fdt6ak572twr1fm34a83mgh8gq2ft` op #1916, zelfde tijd,
is geschreven door **Factory-orchestrator (Opus)** met `decided_by=self`:
"Stop/SessionEnd krijgen het SessionStart-certificaat niet". Bouw-todo
`vn70xw4hv41vgjz8gc1dpp03n98gpgkm` draagt dit vervolg. De technische keuze
pending/ready staat in bouwbesluit `sn85ye6ey6kvpfknzb3gms2sd98gqnms`.
De gevonden directe bron is dus een orchestrator-eis, geen als Sjoerd-besluit
of citaat van hem geregistreerde eis. Mocht er een eerdere ownerbron bestaan,
dan moet de orchestrator die contractwijziging eerst aan Sjoerd voorleggen.

De nieuwe richting staat in orchestratorbesluit
`sn81phy8spc0byt9b43etfbnk58gqt4z` (20:15): D, eerst ontwerp/review.
Wat wordt herzien: **na een geslaagde compact mag de oude, identieke capability
weer werken**. Wat blijft: tijdens pending en na een mislukte poging weigeren;
gewone nieuwe admission, resume en clear maken oudere capabilities ongeldig.

## Eén autoriteit, twee verschillende identiteiten

Onder dezelfde exclusief gehouden SQLite-autoriteit **A** worden vastgelegd:

| Object | Binding en levensduur |
|---|---|
| Capability C | Een verse onvoorspelbare capability-id, SID, canonieke root/cwd, immutable locator-identiteit en bindingEpoch, providerconfigroot, transcriptpad, A/F-identiteiten en het volledige basiscertificaat inclusief recordhash. Ook de oorspronkelijke uitgiftebron hoort bij C. Alleen een gewone bewezen admission kan C uitgeven. |
| Poging T | Eigen verse onvoorspelbare poging-id, C-id, bron, status en de verwachte voorganger. Ieder SessionStart-begin vervangt T atomisch door pending. T is het CAS-token voor finish en vaste hookactivaties. |
| Provider-receipt R | De actuele, complete providercompletion voor precies T: C-id, poging-id, SID, root en actuele bron. Exact vast command, numeric exitCode 0, juiste provider-versie, hookName en transcriptbinding blijven verplicht. |

Geen globale nieuwe autoriteit, sealacceptatie, scan in consumers of
ENV-/receiptcache. De Bash-/workerconsumer krijgt C uit zijn geërfde envelop
en leest T en R vers onder A bij iedere acquire. Hij kan C niet uit T afleiden, vernieuwen
of terugvinden als C ontbreekt. De huidige consumer leest de sessierij en het
transcript al; D voegt geen Node/SQLite-prefix vóór elke Bash-aanroep toe.

De envelop krijgt een expliciete nieuwe wireversie. Zijn bron betekent
**uitgiftebron van C**, niet bron van de laatste poging. Alle C-velden moeten
exact overeenkomen met de onder A opgeslagen uitgiftegegevens. Geen v2→v3
auto-upgrade, ontbrekende velden, alleen een gekopieerd sealrecord of zelf
samengestelde envelop. Compatibility met reeds draaiende v2-consumers is geen
claim: die weigeren; versiecombinaties en bestaande drain-/markerregels zijn
een bouw- en releasegate.

## SessionStart en geslaagde compact

1. Het vaste hookpad vindt via native SID de oorspronkelijke locator. Vóór
   stdinparsing of ENV-writes commit het een nieuwe **pending T** onder A.
   De oude C is dan niet bruikbaar. Het bewaart uitsluitend als kandidaat de
   eerdere C en de identiteit van de voorganger; geen consumer mag die snapshot
   als toelating gebruiken. Een nieuwe SID zonder locator kan nog niets erven.
2. Na inputvalidatie bepaalt de hook de overgang. Alleen `source=compact`
   met exact dezelfde binding, hetzelfde basiscertificaat en een **vóór begin
   volledig bewezen ready-voorganger** mag C behouden. Die predecessorcheck
   gebeurt onder A, met de toen actuele succesvolle receipt. Pending, closing,
   revoked, een eerste compact zonder eerdere admission of een mislukte
   voorganger wordt niet stilzwijgend hersteld. Startup/resume/clear gebruiken
   de gewone vervangende admission; onbekende bron weigert.
3. De bestaande SessionStart-proofgrens blijft gelden. Compact mag geen ander
   A/F, een veranderd record of nieuwe basiscertificaatbinding als dezelfde C
   behandelen. De hook valideert de bestaande proof; bij verandering weigert
   hij. Alleen SessionStart heeft zijn reeds bewezen scanroute; geen globale
   `MACOS_SCAN_PROVEN`, extra executor of ongesandboxte retry.
4. De hook exporteert de stabiele C-envelop. Finish controleert onder A de
   volledige binding en **precies zijn pending poging-id en voorganger**.
   Alleen die poging wordt ready; geen automatische COMMIT-/finishretry die
   een nieuwere poging kan overnemen. Stdout noemt C-id, T-id en actuele bron.
5. Pas de provider-receipt na een echte exit-zero maakt die ready T consumeerbaar.
   Crash na finish of na stdout maar vóór bewezen completion: geen passende R,
   dus weigering. Een later mislukte of onleesbare completion overschaduwt een
   oudere succesvolle receipt. Alleen expliciet herkende contextrecords of
   andere geconfigureerde hookcommands volgen de bestaande uitzonderingen.

Concreet: een Bash draagt C met uitgiftebron `resume`. Na compact is C exact
gelijk, maar T2 heeft bron `compact`. De validator vergelijkt de ENV-bron met
**C.issuedSource**; hij vergelijkt R.source met **T2.source** en R.attemptId
met **T2.id**. Hij vergelijkt niet meer ENV.source met R.source. Dit is geen
algemeen "source negeren": een gewijzigde ENV-bron, onjuiste R-bron of oude
receipt faalt. Een oude C uit een vervangen admission krijgt niets terug.

Bij overlappende pogingen vervangt T3 de pending T2. Een late finish(T2) faalt,
ook als beide compact zouden zijn en dezelfde C zouden behouden. Als T2 bij
begin nog pending was, mag T3 geen succesvolle voorganger verzinnen: geen
compact-herstel van onbewijsbare toestand. Een nieuw bewezen resume is dan
de expliciete herstelroute met nieuwe C.

## Workers, vaste hooks en clear

Een worker bewaart zijn oorspronkelijke C; hij leest geen nieuwe envelopfile
en krijgt geen vernieuwingsrecht. Tijdens compact-pending weigert zijn acquire.
Na succesvolle T2/R2 kan hij met dezelfde C zijn resultaat via de gewone
`updateJobRecord` publiceren. De bestaande begrensde lockdeadline blijft:
een lang pending venster kan een publicatiepoging laten falen; geen onbewezen
retry, result-spool of jobherstel wordt toegevoegd. De native gate moet dit
venster én publicatie na voltooiing meten, inclusief behoud van resultaatdata.

Stop en SessionEnd blijven precies de bestaande vaste entrypoints. Hun
activatie bindt **C én de actuele T-id**; anders zou stabiele C een vertraagde
End over compact heen opnieuw geldig maken. Iedere End-write en zijn revoke
controleert die oorspronkelijke activatie, niet een later ingelezen poging.
Een nieuwe poging vóór de betreffende write/commit laat de oude activatie
weigeren. Reeds gecommitteerde annulering wordt niet teruggedraaid.

Clear sluit de oude SID; de nieuwe SID krijgt uitsluitend een eigen admission.
Oude C mag daarna ook met opnieuw ingestelde oude ENV niet publiceren. Het
ontwerp verlangt daarom dat End bij zijn eerste duurzame actie onder A naar
**closing** gaat, met een eigen uniek, alleen via het vaste Endpad bruikbaar
activatietoken. Gewone workers weigeren closing. Alleen die gebonden End mag
nog annuleringen persisteren en daarna definitief revoken; zonder persistente
annulering geen signaal of brokerteardown. Dit token wordt niet geëxporteerd
en is geen tweede autoriteit. Een crash ná closing laat C onbruikbaar. Een
nieuwe poging of oude End-completion mag closing/revoke niet blind overschrijven.
Deze closing-overgang is een expliciet te reviewen companionwijziging, geen
claim dat de huidige kandidaat dit al doet.

Een clear waarvan de oude End niet is afgeleverd of waarvan zelfs de eerste
closing-COMMIT faalt, bewijst geen revocation. Een nieuwe SID is op zichzelf
geen bewijs dat een willekeurige andere SID in dezelfde root is beëindigd.
Zo'n clear is **onvolledig/NO-GO**, geen succesvolle cleanup; geen globale
"laatste SID wint"-regel die parallelle sessies stukmaakt. Native bewijs moet
de aflevering/closing en de replay tegen de echte toestand aantonen. Een
nieuwe worker met een eigen bewezen nieuwe SID mag uiteraard werken; een
oude worker die over clear heen zijn oude C behoudt niet.

## Weigeringen en bewijsplan

Iedere nieuwe verwachting krijgt eerst een causale rode controle, daarna groen:
de ontbrekende functionaliteit op de bevroren kandidaat; een reeds bestaande
weigering met een gerichte defecte variant van de betreffende predicate.
Alle runs via test-slot. Geen bestaande weigertest wegmasseren om compact
groen te noemen. Consumerchecks en publicatie gebeuren onder A; geen extra
verbinding openen/sluiten binnen dezelfde houder-PID (fcntl/P5).

De bestaande coretests in `shared/fenced-lock/session-admission.test.ts`
blijven **ongewijzigd**: gewone `beginSessionAdmission` blijft vervangend.
Met name `a new begin commits revocation of old Bash certificates, stale finish
cannot overwrite it`, `finish without a matching begin cannot publish ready`,
`finish never requires a receipt that can only exist after hook exit`,
COMMIT-failure/rollback, fresh epoch, independent SIDs, fresh callbacks onder
exclusieve A, replaced A/F/record, existing-only en consumer-only blijven gelden.
De nieuwe compactovergang wordt expliciet getest en maakt de oude API niet
impliciet hernieuwbaar. De bestaande plugintest die **succesvolle compact**
altijd laat revoken wordt bewust vervangen door de onderstaande twee kanten;
startup/resume/clear en alle fout-/crashtests blijven weigeren.

| Te bewijzen overgang | Toegelaten kant | Geweigerde kant |
|---|---|---|
| Zelfde C over compact | Eerste Bash en reeds draaiende worker na manual én auto compact publiceren; resume- en startup-uitgiftebron blijven geldig | C ontbreekt/vervalst, andere oorspronkelijke bron, oude vervangen C, v2/malformed envelop |
| Poging en completion | Alleen current ready T met exacte actuele R | Pending; crash na begin, ENV-write, finish of stdout; ontbrekende/partial/exit-one/gekilde/onjuiste/oude receipt; mislukte compact |
| Binding | Zelfde SID/root/locator/epoch/A/F/basecert | Iedere afzonderlijke wijziging of onbekende identity, corrupt/missing record of autoriteit; niets recreëren |
| CAS en races | Nieuwste geldige finish; huidige Stop/End | T2-finish over T3, End(T1) over T2/T3, overlappende compact zonder proven predecessor, stale callback/closing-token |
| Vervanging en clear | Nieuwe C na gewone admission; nieuwe SID na bewezen start | Oude C na resume, End/closing/clear; oude-SID-worker met oude ENV en met nieuwe ENV, ook dezelfde state-root |
| Resultaatintegriteit | Worker wacht gecontroleerd over auto compact en publiceert precies één resultaat onder C | Pending/failed/clear-write verandert geen job/index, geen false completed, geen signal/teardown vóór persistente annulering |
| Half-combinaties | Nieuwe expliciet ondersteunde module/envelop | Oude consumer/nieuwe row, nieuwe consumer/oude envelope/module, unknown wire/schema; geen legacy fallback |

Bouwbewijs begint met een minimale pluginloze Claude 2.1.301-PTY-repro onder
`--debug`: manual en auto compact, oude waarde in Bash en cache-invalidatie-
logging observeren. D verandert de Claude-cache niet: dezelfde repro moet
daarna de **voorgestelde stabiele C plus wisselende T/R** demonstreren. De
waarde die bedoeld was te veranderen blijft in de controle bewust stale;
we claimen geen providerbugfix. Leg vast wanneer `scrubCredentialEnv` geldt
en dat ontbrekende proof daar weigert. Meet de bestaande en gekozen
Bash-prefix op dezelfde input/config (aantal runs, median/p95); geen extra
per-Bash initializer als verborgen kostenpost.

Daarna echte PTY met alle vaste producthooks en gesandboxte Bash, beide
richtingen van de tabel, en een echte al draaiende worker over auto compact.
Clear-replay mag als harness-child tegen de daadwerkelijk na clear aanwezige
state: oude capture eerst positief, daarna negatief, ongewijzigde state en
exacte weigering. Dit bewijst de consumer, niet aflevering van een nieuwe
Bash-aanroep. Geen permissionwijziging; de eerdere automatische weigering
wordt niet omzeild. Release wacht op dit bewijs; dit document produceert het niet.

## Provider-versies zijn bewijsdata

Vervang de hardcoded vergelijking met `2.1.301` door één gebundeld, gereviewd
JSON-manifest met exact version, receipt-adapter/schema, platform, binaryhash,
bewijscommit, samenvattingspad én hash van duurzame gesaniteerde fixtures.
Geen semverrange, "minimaal deze versie", runtime auto-enrollment of ongemeten
wildcard. Ontbrekende/corrupte/tegenstrijdige data weigert. Bestaande CLI-status
toont de geobserveerde versie en de concrete reden `provider version unproven`;
de fout noemt de versie en het ontbrekende bewijs, geen credentials.

Initieel heeft alleen **2.1.301/macOS arm64** het bestaande receiptbewijs
(binary-SHA256 `1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`).
Ook daarvoor ontbreken nog de D-proeven; bestaand bewijs bewijst het oude
receiptformaat, geen D-release-GO. 2.1.302–2.1.306 uit het reviewbericht worden
pas toegevoegd na eigen bewijs per versie: startup/resume/manual+auto compact,
Stop/End/clear, completion exit-one/crash/partial, alle vereiste velden en
afwezigheid van proof in modelinput. Onbekende versie heeft een afzonderlijke
rode/weigerproef; iedere toegelaten versie heeft positieve fixtures én een
negatieve mismatchproef. Een manifestvermelding is bewijsmetadata; de A-rij,
basiscertificaatvalidatie en live receipt blijven beslissen. Geen installatie-
update is nodig of toegestaan om nu deze docs te maken.

## Afweging en open reviewbesluit

D behoudt C uitsluitend binnen dezelfde bewezen sessie en bestaande lockbinding.
Een worker krijgt geen file- of vernieuwingsroute. Nieuwe T/R blijft de
crash-/completionpoort; echte vervanging blijft C intrekken. A-indirectie
alleen lost de stale Bash op, maar niet de reeds draaiende worker. A plus
workerbeleid zou een vergelijkbare bevoegdheidskeuze moeten maken en voegt
een extra te beveiligen bronbestand toe. D voorkomt dat transportpad, maar
verruimt bewust de levensduur van C over **geslaagde** compact en maakt
source-binding tweelaags. Dat is slechts even veilig als de bovenstaande
CAS-, receipt- en revocationregels bewezen worden.

Claude-review moet expliciet toetsen: deze contractherziening en herkomst;
preparse pending met pas later bekende bron; current-receiptselectie en
bronbinding; End/closing zonder nieuw toelatingspad; worker-publicatie onder
de bestaande deadline; schema-/wire-halfcombinaties; en de bewijsgrens van
clear als aflevering ontbreekt. Tot GO en bouwbesluit blijft de kandidaat
functioneel NO-GO voor compact. Een upstream-issue wordt uitsluitend concept
in docs; extern plaatsen vereist afzonderlijk akkoord van Sjoerd.

## Bouw (21-10-2026)

Gebouwd door Claude Opus na de ontwerpreview, op Omarchy (Linux). De
bouwvoorwaarden en waar ze landden:

| Voorwaarde | Uitwerking |
|---|---|
| MEDIUM-1 geen verloren workerresultaat | `runTrackedJob` schrijft de final output (of de foutregel) naar het eigen joblog vóór de locked publish. De core-consumer onderscheidt tijdelijk (actuele T pending met deze C als kandidaat, of de receipt van de actuele T bestaat nog niet) van definitief (een validatiebeslissing); BUSY en systeemfouten hebben geen klasse. Een consumer die opgeeft gooit `StateLockRefused` bij definitief, anders `StateLockTimeout` met `refusal`. Alleen de laatste workerpublicatie (completed of failed) wacht langer: losse pogingen, elk volledig onder A gevalideerd, met de event loop ertussen (signalen blijven werken); tot 10 s zoals elke write, daarna alleen bij een tijdelijke weigering, elke 500 ms, tot 180 s (`CODEX_COMPANION_FINAL_PUBLISH_WAIT_MS`, max 900 s). Definitief stopt direct. Een geweigerde resultaatpublicatie leidt niet tot een tweede lange wachttijd voor een failed-record; het log meldt dat het resultaat niet gepubliceerd is en de exit-reporter doet zijn gewone poging. De hook schrijft stdout vóór de env-exports, zodat een mislukte export een receipt mét het token van deze poging achterlaat (definitief). |
| MEDIUM-2 alleen de poging-API | `beginSessionAdmission`/`finishSessionAdmission`/`readSessionAdmission`/`revokeSessionAdmission` zijn weg; de hook gebruikt `beginSessionAttempt`/`finishSessionAttempt`, de vaste hooks `readSessionCapability`/`revokeSessionCapability`. Elke oude garantie heeft een eigen test op de nieuwe API (core `session-admission.test.ts`, `session-revoke.test.ts`). Het contract (core README) zegt dat intrekking bij begin voorlopig is en pas bij een niet-compact-finish definitief. Afwijking van de ontwerptekst hierboven: de oude coretests bleven níet ongewijzigd, ze zijn geport. |
| Activatie | Stop en SessionEnd binden C én de actuele T-id (`attemptId` in de activatie-envelop); een latere poging, ook een compact met dezelfde C, laat de activatie weigeren. Closing bij clear valt buiten deze bouw (#2631). |
| LOW-4 | Begin bewaart alleen `{attemptId: T1, state: "ready", capability: C}`; de receiptcheck van de voorganger draait in finish onder A. Meting `tests/fenced-lock/receipt-bench.mjs` (Node 26, i5-12500, 7 runs): 0,1 MB 0,15 ms; 1 MB 1,05 ms; 10 MB 10,9 ms; 50 MB 68 ms; 100 MB 135 ms mediaan (p95 152 ms). Lineair, ongeveer 1,4 ms per MB, ruim binnen de hookdeadline van 1 s; dezelfde check draait al bij elke consumer-acquire. |
| LOW-5 | Compact roept geen `prepareAdmission` aan; finish(compact) valideert `C.admission` met `validateExistingAdmission` en weigert een meegegeven admission. |
| LOW-7 | `plugins/codex/scripts/lib/provider-receipts.json`: versie, platform, `process.arch`, receipt-adapter, binary-hash, bewijscommit, samenvatting en fixtures met hun hashes. Beide oude `r.version === "2.1.301"`-plekken gebruiken het manifest. Ontbrekend, corrupt, dubbel of een bereik weigert; een arch-mismatch weigert. |
| LOW-6 (eigen keuze) | De bron is uit de envelop gehaald (wireversie 3). Reden: de capability-id bindt de uitgifte al uniek; `issuedSource` blijft onder A in de rij. De receipt-bron wordt vergeleken met de bron van de actuele T. Zo bestaat er geen tweelaagse bronvergelijking meer. |
| Docs | De C-id is onvoorspelbaar maar geen geheim: hij werkt alleen samen met de A-rij, het kerncertificaat, de locatorbinding en de receipt van de actuele poging. Het dreigingsmodel (coöperatieve processen van dezelfde gebruiker) verandert niet. |

Half-combinaties: een rij van versie 2 is voor de generatiemodule malformed en
omgekeerd; een v2-envelop weigert in de nieuwe consumer. Getest in core
(`half-combination`) en via de pre-D-baseline in de mutatiecontroles.

Nog open: de native macOS-proef met `tests/fenced-lock/macos-d-pty-probe.py`
(echte Claude 2.1.301-PTY, manual én auto compact, latency van hook-exit tot
de receipt-regel, worker over compact). De oudere
`macos-companion-*`-harnas hoort bij de generatie-wire (v2) en is niet
geport; hij draait nog tegen die productversie met
`FENCED_LOCK_PRODUCT_REF=258047fbc24cfb8539897875410282c65ede842b`. Voor D
vervangt de nieuwe PTY-proef hem.

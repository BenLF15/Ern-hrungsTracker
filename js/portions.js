// Typische Haushaltsmaße/Portionsgrößen (Richtwerte, "ca."). Die Nährwerte selbst stammen
// immer aus der Datenbank; hier wird nur die Menge vorgeschlagen. Getränke im BLS sind auf
// 100 g bezogen – für wässrige Getränke gilt näherungsweise 1 ml ≈ 1 g.

const R = (re, list, group = null) => ({ re, list, group });

// Reihenfolge wichtig: erste passende Regel gewinnt.
const RULES = [
  R(/^huhnerei eigelb/, [["1 Eigelb (Gr. M)", 18]]),
  R(/^huhnerei eiklar/, [["1 Eiklar (Gr. M)", 33]]),
  R(/^huhnerei(?! pulver)/, [["1 Ei Gr. M (ca. 50 g essbar)", 50], ["1 Ei Gr. L (ca. 58 g essbar)", 58], ["1 Ei Gr. S (ca. 42 g essbar)", 42]]),
  R(/^wachtelei/, [["1 Wachtelei (ca. 9 g essbar)", 9]]),
  R(/knackebrot/, [["1 Scheibe (ca. 10 g)", 10]]),
  R(/toastbrot/, [["1 Scheibe (ca. 25 g)", 25]]),
  R(/brotchen|semmel|baguettebrotchen|laugenbrezel|brezel/, [["1 Stück (ca. 60 g)", 60]]),
  R(/^croissant/, [["1 Croissant (ca. 50 g)", 50]]),
  R(/brot/, [["1 Scheibe (ca. 50 g)", 50], ["1 dünne Scheibe (ca. 30 g)", 30]], "B"),
  R(/^hafer flocken$|^hafer flocken,|musli|getreideflakes|cornflakes|cerealien/, [["1 EL (ca. 8 g)", 8], ["1 Portion (40 g)", 40], ["1 große Portion (60 g)", 60]]),
  R(/^reis .*roh|reis poliert, roh|teigwaren roh|eierteigwaren roh|nudeln roh|couscous roh|bulgur roh|quinoa roh/, [["1 Portion roh (75 g)", 75], ["1 kleine Portion roh (60 g)", 60]]),
  R(/^reis .*gekocht|teigwaren .*gekocht|reisnudeln gekocht/, [["1 Portion gekocht (200 g)", 200], ["1 kleine Portion gekocht (150 g)", 150]]),
  R(/olivenol|rapsol|sonnenblumenol|ol$|^.*ol,|leinol|kokosfett/, [["1 EL (ca. 10 g)", 10], ["1 TL (ca. 4 g)", 4]], "Q"),
  R(/butter|margarine|halbfett|schmalz/, [["1 TL (ca. 5 g)", 5], ["1 Portion für 1 Brot (ca. 10 g)", 10], ["1 Portionspackung (20 g)", 20]], "Q"),
  R(/mayonnaise/, [["1 EL (ca. 15 g)", 15], ["1 TL (ca. 5 g)", 5]]),
  R(/ketchup|senf|sauce|dressing/, [["1 EL (ca. 15 g)", 15], ["1 TL (ca. 5 g)", 5]], "R"),
  R(/^zucker|puderzucker|rohrzucker/, [["1 TL (ca. 4 g)", 4], ["1 EL (ca. 12 g)", 12], ["1 Würfel (ca. 3 g)", 3]]),
  R(/^honig|marmelade|konfiture|gelee|sirup/, [["1 TL (ca. 8 g)", 8], ["1 EL (ca. 20 g)", 20]]),
  R(/nuss-nougat|nussnougat|erdnussmus|mandelmus|nussmus/, [["1 TL (ca. 8 g)", 8], ["1 Portion (15 g)", 15]]),
  R(/^banane roh/, [["1 mittelgroße Banane (ca. 120 g ohne Schale)", 120], ["1 kleine Banane (ca. 90 g)", 90]]),
  R(/^apfel roh/, [["1 mittelgroßer Apfel (ca. 125 g essbar)", 125], ["1 großer Apfel (ca. 180 g essbar)", 180]]),
  R(/^birne roh/, [["1 Birne (ca. 140 g essbar)", 140]]),
  R(/^orange roh|^apfelsine/, [["1 Orange (ca. 150 g essbar)", 150]]),
  R(/^mandarine roh|^clementine/, [["1 Mandarine (ca. 60 g essbar)", 60]]),
  R(/^kiwi/, [["1 Kiwi (ca. 70 g essbar)", 70]]),
  R(/^pfirsich roh|^nektarine roh/, [["1 Stück (ca. 130 g essbar)", 130]]),
  R(/^avocado roh/, [["1/2 Avocado (ca. 70 g essbar)", 70]]),
  R(/^erdbeere roh|^heidelbeere roh|^himbeere roh|^weintraube/, [["1 Handvoll (ca. 80 g)", 80], ["1 Schale (ca. 150 g)", 150]]),
  R(/^tomate roh/, [["1 mittelgroße Tomate (ca. 80 g)", 80], ["1 Cocktailtomate (ca. 15 g)", 15]]),
  R(/^gurke roh|^salatgurke/, [["1/4 Gurke (ca. 100 g)", 100]]),
  R(/^paprika .*roh/, [["1 Paprikaschote (ca. 150 g essbar)", 150]]),
  R(/^karotte\/mohre, roh/, [["1 Karotte (ca. 70 g)", 70]]),
  R(/^zwiebel roh/, [["1 Zwiebel (ca. 60 g)", 60]]),
  R(/^kartoffel .*(gekocht|gegart)|^pellkartoffel/, [["1 mittelgroße Kartoffel (ca. 80 g)", 80], ["1 Portion (200 g)", 200]]),
  R(/pommes frites/, [["1 kleine Portion (100 g)", 100], ["1 Portion (150 g)", 150]]),
  R(/joghurt|skyr|dickmilch|kefir/, [["1 Becher (150 g)", 150], ["1 großer Becher (500 g)", 500], ["1 EL (ca. 15 g)", 15]], "M"),
  R(/speisequark|quark/, [["1 Packung (250 g)", 250], ["1 EL (ca. 30 g)", 30]], "M"),
  R(/mozzarella/, [["1 Kugel (125 g)", 125]]),
  R(/kase|gouda|edamer|emmentaler|tilsiter|camembert|brie|feta/, [["1 Scheibe (ca. 20 g)", 20], ["1 Portion (30 g)", 30]], "M"),
  R(/sahne|rahm|creme fraiche|schmand/, [["1 EL (ca. 15 g)", 15], ["1 Becher (200 g)", 200]], "M"),
  R(/milch|drink|kakao/, [["1 Glas (200 ml ≈ 200 g)", 200], ["1 Tasse (150 ml ≈ 150 g)", 150], ["Schuss für Kaffee (ca. 30 g)", 30]], "M"),
  R(/espresso/, [["1 Espresso (ca. 30 ml ≈ 30 g)", 30], ["1 doppelter Espresso (ca. 60 ml)", 60]], "N"),
  R(/kaffee|tee/, [["1 Tasse (150 ml ≈ 150 g)", 150], ["1 Becher (250 ml ≈ 250 g)", 250]], "N"),
  R(/./, [["1 Glas (200 ml ≈ 200 g)", 200], ["1 kleine Flasche (330 ml ≈ 330 g)", 330], ["1 Flasche (500 ml ≈ 500 g)", 500]], "N"),
  R(/wein|sekt|prosecco|champagner/, [["1 Glas (125 ml ≈ 125 g)", 125], ["1 Glas Sekt (100 ml)", 100]], "P"),
  R(/bier|radler|weizen|pils/, [["1 Flasche (330 ml)", 330], ["1 Flasche/Glas (500 ml)", 500]], "P"),
  R(/likor|vol|schnaps|whisky|wodka|rum|gin|korn/, [["1 Schnapsglas (20 ml)", 20], ["1 Doppelter (40 ml)", 40]], "P"),
  R(/./, [["1 Glas (200 ml)", 200]], "P"),
  R(/schokolade|riegel/, [["1 Rippe/Stück (ca. 6 g)", 6], ["1 Riegel (ca. 25 g)", 25], ["1 Tafel (100 g)", 100]], "S"),
  R(/eis/, [["1 Kugel (ca. 50 g)", 50]], "S"),
  R(/kuchen|torte|teilchen|plunder|berliner|krapfen|muffin/, [["1 Stück (ca. 100 g)", 100], ["1 kleines Stück (ca. 70 g)", 70]], "D"),
  R(/keks|platzchen|cracker|zwieback/, [["1 Stück (ca. 8 g)", 8]], "D"),
  R(/chips|flips|salzstangen/, [["1 Handvoll (ca. 25 g)", 25], ["1 Tüte (175 g)", 175]], "D"),
  R(/nuss|kern|mandel|samen/, [["1 Handvoll (ca. 25 g)", 25], ["1 EL (ca. 10 g)", 10]], "H"),
  R(/wurst|salami|schinken|aufschnitt|mortadella|lyoner/, [["1 Scheibe (ca. 15 g)", 15], ["1 Portion (30 g)", 30]], "W"),
  R(/bratwurst|wiener|frankfurter|bockwurst|knacker/, [["1 Stück (ca. 100 g)", 100]], "W"),
  R(/./, [["1 Portion (150 g)", 150], ["1 kleine Portion (100 g)", 100]], "U"),
  R(/./, [["1 Portion (150 g)", 150], ["1 kleine Portion (100 g)", 100]], "V"),
  R(/./, [["1 Portion (150 g)", 150], ["1 kleine Portion (100 g)", 100]], "T"),
  R(/suppe|eintopf/, [["1 Teller (ca. 300 g)", 300], ["1 Tasse (ca. 200 g)", 200]], "X"),
  R(/./, [["1 Portion (ca. 350 g)", 350], ["1 kleine Portion (ca. 250 g)", 250]], "X"),
  R(/./, [["1 Portion (ca. 350 g)", 350], ["1 kleine Portion (ca. 250 g)", 250]], "Y"),
];

function f2(s) {
  return s.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss");
}

export function portionsFor(food) {
  const name = f2(food.name);
  const out = [];
  for (const r of RULES) {
    if (r.group && r.group !== food.group) continue;
    if (r.re.test(name)) { out.push(...r.list.map(([label, g]) => ({ label, g }))); break; }
  }
  return out;
}


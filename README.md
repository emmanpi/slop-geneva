# Slop Genève

A simulation of Geneva's city centre built with [three.js](https://threejs.org/), WebGPURenderer and TSL. Explore the
Rade, the Jet d'eau, the Vieille-Ville and the Cathédrale Saint-Pierre, Cornavin, the Pâquis, Plainpalais, the
Jonction of the Rhône and the Arve, and up to the Palais des Nations on foot, by car, by bicycle or cargo bike, or by
helicopter, at 1:1 and **on the real relief**.

A fork of [Slop Zürich](https://github.com/colorfield/slop-zurich) by colorfield, itself based on
[Slop New York](https://github.com/mrdoob/slop-newyork) by mrdoob. More cities in
[Slop Cities](https://github.com/zz85/slop-cities).

## What makes it Geneva

- **swisstopo swissBUILDINGS3D 3.0**: every building with its real roof, from the 3D Tiles of `3d.geo.admin.ch`,
  stored in the repository (`data/swissbuildings3d/`).
- **The real ground and roofs**: a SWISSIMAGE orthophoto mosaic of the frame at 1 m per pixel (`data/geneva-ortho.jpg`)
  colours the roofs and every ground surface (the sand of Plainpalais, asphalt, lawns, paving). The crowns and
  shadows of the 39,000 inventoried trees are filled out of the photo from the ground around them, since the engine
  draws its own trees.
- **Facade archetypes learnt from the photomesh** (`tools/sample-photomesh-facades.mjs`, `tools/build-geneva-facades.mjs`):
  the walls of ~740 buildings photographed in the SITG photomesh are measured for their colour, share of windows and
  ground floor, then grouped into 20 archetypes. Every other building in the city takes the archetype of the measured
  buildings most like it (RegBL period, storeys, neighbourhood). The procedural facades draw that colour, those
  windows and shop fronts. The toolbar's **Photomesh** button (P) unloads the photos and shows them in the old town
  too.
- **Facades by period** from the Federal Register of Buildings (RegBL): each building's year or period of
  construction and storeys pick its style (`data/geneva-facades.json`): the old town's stone with shutters and
  cornices, the 19th-century molasse with tall windows, string courses and wrought-iron balconies, post-war balcony
  slabs, contemporary glazing, office curtain walls. Windows light up after dusk.
- **swisstopo swissALTI3D**: the terrain (2 m, resampled to 4 m): the Léman at 372 m, the old town's hill around
  Saint-Pierre (~400 m), the Rhône below the Seujet dam, the climb to the Nations.
- **Bridges at their real height** from swissSURFACE3D: the Pont du Mont-Blanc, the Pont de la Machine, the
  Coulouvrenière, the Arve bridges.
- **The canton around the city** (`js/canton.js`, `tools/build-geneva-canton.mjs`): beyond the mapped frame, the relief
  wears a SWISSIMAGE mosaic of the whole canton (±12 km at ~6 m, `data/geneva-canton-ortho.jpg`). The canton's
  ~6,400 swissBUILDINGS3D tiles (Carouge, Lancy, Meyrin, Vernier, the airport, Cologny…) stream straight from swisstopo's
  3D Tiles service around the camera, nearest first. Their reach grows with height, from ~1.5 km at street level to
  4.5 km from the helicopter, and nothing is stored in the repository.
- **The horizon** from swissALTIRegio, which also covers the French border regions: the Salève, the Jura, the Voirons
  and the Mont-Blanc massif.
- **The Jet d'eau** (`js/jet-deau.js`): a GPU particle plume at OSM's fountain node, each drop on its own ballistic
  arc (~52 m/s, up to 140 m), bent by the bise and falling back as spray; floodlit after dusk.
- **TPG trams on the real timetable** (`js/trams.js`, `data/geneva-transit.json`): one weekday of the Swiss GTFS feed
  (opentransportdata.swiss) for lines 12, 14, 15, 17 and 18. Each trip drives in from the edge of the network along
  the OSM tracks, waits at its stops for its departure time and shows its line's colour on the displays. The city's
  clock (`js/sim-clock.js`, top left) runs from the hour of the chosen light, or `?heure=HH:MM`.
- **TPG buses on their lines** (`js/tpg-buses.js`): a bus the traffic puts on the road near the player takes a trip
  running at the city's clock and follows its line over the road graph from stop to stop. It stops at each stop for
  12 to 22 s and shows its line and destination on its signs. Buses wear the TPG's white and orange.
- **Genève Aéroport** (`js/planes.js`): airliners land and take off on Cointrin's 3,900 m runway, one movement every
  2 to 3 minutes from 6:00 to 23:00, arrivals on a 3° glide path. The runway in use follows the wind: into the bise
  they land towards the north-east, otherwise towards the south-west.
- **Fireworks over the Rade** (`js/fireworks.js`) on the 1st of August, at the Fêtes de Genève (mid-August) and at
  New Year's midnight, from barges off the Pâquis, or at any time with `?evenement=feux`. They are drawn as a GPU
  particle system of peonies, gold willows and rings.
- **The cycle network** (`js/cycling.js`): OSM's cycle tracks (the two-way track along the lake's quays among them,
  asphalt) and the cycle lanes along the streets (`cycleway:left/right`). They are marked in Swiss yellow: lane edge
  lines (dashed where advisory), bicycle pictograms and the two-way tracks' dashed centre line. About 70 cyclists ride
  the network around the camera, keeping right on the tracks and riding the lanes' way.
- **The quays** (`js/quays.js`): along every shore of the Léman and the Rhône, where the bank stands high, a
  dressed-stone quay wall rises from below the water, wet and darker at the waterline with a line of algae. It has a
  coping stone, the quay's paving laid flat up to the wall and a painted iron railing on the high quays. A line of foam
  laps at the foot of the walls and the beaches, and the lake and river beds drop steeply at the banks.
- **The Mouettes genevoises** (`js/boats.js`): lines M1 to M4 cross the Rade on their timetable. A boat sails its
  line's next trip from the pier it reached and waits at the pier in between. It crosses on a smooth course over the
  water, rocking with a wake.
- **Weather** (`js/weather.js`): by default the live values of MeteoSwiss's station at Genève-Cointrin (every 10
  minutes), or a chosen sky (fair, bise, rain, November stratus, snow). The weather sets the cloud deck and haze, wet
  roads, rain or snow around the camera and the wind in the trees and on the Jet d'eau. The Jet d'eau runs from 10:00
  to 22:30 and stops in a gale or a frost. The Weather menu or `?meteo=` picks the sky.
- **Seasons** (`js/seasons.js`, `js/phenology.js`): each inventoried tree follows its genus through the year. Maples
  go orange and red, limes and birches yellow, planes tan and chestnuts brown early. Oaks stay bronze late, deciduous
  trees stand bare in winter and conifers stay green. The Season menu picks the day (default: today), as do `?saison=`
  and `?jour=AAAA-MM-JJ`.
- **Inventaire cantonal des arbres isolés** (SITG): ~39,000 trees with their surveyed height and crown.
- The **quartiers** of the Ville de Genève (Cité, Pâquis, Eaux-Vives, Plainpalais, Jonction…) and the neighbouring
  communes for place names, plus teleports and viewpoints.
- **The real city in 3D over the old town and Plainpalais**: the SITG's textured photomesh (Photomaillage 3D 2019,
  100 m tiles of OBJ + JPEG) converted to glTF in the world frame (`tools/build-photomesh.mjs`, `data/photomesh/<area>/`).
  The two areas are the Vieille-Ville with the Rues Basses, the Bastions and the Rive quarter (800 × 800 m), and the
  Plaine de Plainpalais (400 × 500 m). There the photomesh replaces the engine's buildings and ground. Its tree crowns
  are flattened onto the orthophoto, and the engine's own trees stand on it (`js/photomesh.js`, `PHOTOMESH_AREAS`).
  - Each tile has two levels. The full one is simplified to ~20 cm of the survey, with a 1024 px texture. The coarse
    one keeps ~12% of the triangles and carries vertex colours from the photo, with the orthophoto on what faces up.
    Geometry is compressed with `EXT_meshopt_compression`.
  - The coarse tiles load with the city (~10 MB). The full tiles stream in around the camera, within 240 m and 28 at
    most, and are released again beyond 340 m.
- **The follow camera stays on the player's side of the walls** (`js/cameras.js`): it is pulled in short of the first
  building between the player and the camera, which matters in the old town's narrow streets.
- **LV95 world frame** (`js/geneva-frame.js`): 1 unit = 1 m, `x = E − 2500000`, `z = 1118000 − N`,
  `y = height − 372 m` (lake level). The mapped area is LV95 E 2498300–2502300, N 1116500–1121300 (4.0 × 4.8 km).

## Run it

```sh
npm run serve          # python3 -m http.server 8766 → http://127.0.0.1:8766/
npm install && npm test
```

A WebGPU-capable browser is needed (recent Chrome, Edge or Safari).

## Data

The generated data is committed (`js/geneva-geodata.js`, `data/geneva-terrain.bin`, `data/geneva-surroundings.bin`,
`data/swissbuildings3d/`); the raw downloads go to `tools/data/cache/` (not committed). To rebuild everything:

```sh
npm install
npm run data
npm run update:buildings
```

| Step | Script | Source |
| --- | --- | --- |
| `data:osm`, `data:areas` | `tools/overpass.sh` + `tools/data/q_geneva*.overpassql` | OpenStreetMap (Overpass API) |
| `data:trees` | `tools/fetch-geneva-trees.mjs` | SITG, Inventaire cantonal des arbres isolés (ArcGIS REST) |
| `data:terrain` | `tools/build-geneva-terrain.mjs` | swisstopo swissALTI3D |
| `data:decks` | `tools/fetch-bridge-decks.mjs` | swisstopo swissSURFACE3D Raster |
| `data:geo` | `tools/build-geneva-geodata.mjs` | all of the above → `js/geneva-geodata.js` |
| `data:surroundings` | `tools/build-geneva-surroundings.mjs` | swisstopo swissALTIRegio |
| `data:ortho` | `tools/build-geneva-ortho.mjs` | swisstopo SWISSIMAGE 10 cm (COG overviews) |
| `data:canton` | `tools/build-geneva-canton.mjs` | swisstopo SWISSIMAGE (WMTS) and swissBUILDINGS3D 3.0 (tile index) |
| `data:transit` | `tools/build-geneva-transit.mjs` | Horaire officiel suisse (GTFS, opentransportdata.swiss), saved to `tools/data/cache/gtfs/gtfs.zip` |
| `data:facade-samples` | `tools/sample-photomesh-facades.mjs` | the cached SITG photomesh tiles (run `data:photomesh` first) |
| `data:gwr`, `data:facades` | `tools/build-geneva-facades.mjs` | OFS RegBL, canton de Genève |
| `data:photomesh` | `tools/build-photomesh.mjs` | SITG Photomaillage 3D 2019 (Plainpalais, Vieille-Ville) |
| `update:buildings` | `tools/update-swissbuildings3d.mjs` | swisstopo swissBUILDINGS3D 3.0 (3D Tiles) |

## Ideas

- The CGN paddle steamers (in the timetable from spring to autumn).
- A French interface.

## License and data

The code is available under the [MIT License](LICENSE).

Data: © [swisstopo](https://www.swisstopo.admin.ch/) (swissBUILDINGS3D 3.0, swissALTI3D, swissSURFACE3D,
swissALTIRegio, open government data), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL),
[SITG / État de Genève](https://ckan.opendata.swiss/dataset/inventaire-cantonal-des-arbres-isoles) (Inventaire
cantonal des arbres isolés, Photomaillage 3D 2019), [OFS](https://www.housing-stat.ch/) (Registre fédéral des bâtiments et des logements),
[opentransportdata.swiss](https://opentransportdata.swiss/) (horaire officiel, GTFS),
[MeteoSwiss](https://opendata.swiss/) (SwissMetNet, Genève-Cointrin).

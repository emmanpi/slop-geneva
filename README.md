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
- **Facades by period** from the Federal Register of Buildings (RegBL): each building's year or period of
  construction and storeys pick its style (`data/geneva-facades.json`): the old town's stone with shutters and
  cornices, the 19th-century molasse with tall windows, string courses and wrought-iron balconies, post-war balcony
  slabs, contemporary glazing, office curtain walls. Windows light up after dusk.
- **swisstopo swissALTI3D**: the terrain (2 m, resampled to 4 m): the Léman at 372 m, the old town's hill around
  Saint-Pierre (~400 m), the Rhône below the Seujet dam, the climb to the Nations.
- **Bridges at their real height** from swissSURFACE3D: the Pont du Mont-Blanc, the Pont de la Machine, the
  Coulouvrenière, the Arve bridges.
- **The horizon** from swissALTIRegio, which also covers the French border regions: the Salève, the Jura, the Voirons
  and the Mont-Blanc massif.
- **The Jet d'eau** (`js/jet-deau.js`): a GPU particle plume at OSM's fountain node, each drop on its own ballistic
  arc (~52 m/s, up to 140 m), bent by the bise and falling back as spray; floodlit after dusk.
- **TPG trams on the real timetable** (`js/trams.js`, `data/geneva-transit.json`): one weekday of the Swiss GTFS feed
  (opentransportdata.swiss) for lines 12, 14, 15, 17 and 18. Each trip drives in from the edge of the network along
  the OSM tracks, waits at its stops for its departure time and shows its line's colour on the displays. The city's
  clock (`js/sim-clock.js`, top left) runs from the hour of the chosen light, or `?heure=HH:MM`.
- **Seasons** (`js/seasons.js`, `js/phenology.js`): each inventoried tree follows its genus through the year. Maples
  go orange and red, limes and birches yellow, planes tan and chestnuts brown early. Oaks stay bronze late, deciduous
  trees stand bare in winter and conifers stay green. The Season menu picks the day (default: today), as do `?saison=`
  and `?jour=AAAA-MM-JJ`.
- **Inventaire cantonal des arbres isolés** (SITG): ~39,000 trees with their surveyed height and crown.
- The **quartiers** of the Ville de Genève (Cité, Pâquis, Eaux-Vives, Plainpalais, Jonction…) and the neighbouring
  communes for place names, plus teleports and viewpoints.
- **The real city in 3D, over a test area**: the SITG's textured photomesh (Photomaillage 3D 2019, 100 m tiles of
  OBJ + JPEG) converted to glTF in the world frame (`tools/build-photomesh.mjs`, `data/photomesh/<area>/`). The first
  area is the Plaine de Plainpalais (400 × 500 m); there it replaces the engine's buildings, ground and trees
  (`js/photomesh.js`, `PHOTOMESH_AREAS`).
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
| `data:transit` | `tools/build-geneva-transit.mjs` | Horaire officiel suisse (GTFS, opentransportdata.swiss), saved to `tools/data/cache/gtfs/gtfs.zip` |
| `data:gwr`, `data:facades` | `tools/build-geneva-facades.mjs` | OFS RegBL, canton de Genève |
| `data:photomesh` | `tools/build-photomesh.mjs` | SITG Photomaillage 3D 2019 (Plainpalais) |
| `update:buildings` | `tools/update-swissbuildings3d.mjs` | swisstopo swissBUILDINGS3D 3.0 (3D Tiles) |

## Ideas

- The Mouettes genevoises crossing the Rade, the CGN paddle steamers.
- A French interface.

## License and data

The code is available under the [MIT License](LICENSE).

Data: © [swisstopo](https://www.swisstopo.admin.ch/) (swissBUILDINGS3D 3.0, swissALTI3D, swissSURFACE3D,
swissALTIRegio, open government data), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL),
[SITG / État de Genève](https://ckan.opendata.swiss/dataset/inventaire-cantonal-des-arbres-isoles) (Inventaire
cantonal des arbres isolés, Photomaillage 3D 2019), [OFS](https://www.housing-stat.ch/) (Registre fédéral des bâtiments et des logements),
[opentransportdata.swiss](https://opentransportdata.swiss/) (horaire officiel, GTFS).

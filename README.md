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
- **swisstopo swissALTI3D**: the terrain (2 m, resampled to 4 m): the Léman at 372 m, the old town's hill around
  Saint-Pierre (~400 m), the Rhône below the Seujet dam, the climb to the Nations.
- **Bridges at their real height** from swissSURFACE3D: the Pont du Mont-Blanc, the Pont de la Machine, the
  Coulouvrenière, the Arve bridges.
- **The horizon** from swissALTIRegio, which also covers the French border regions: the Salève, the Jura, the Voirons
  and the Mont-Blanc massif.
- **The Jet d'eau** (`js/jet-deau.js`): a GPU particle plume at OSM's fountain node, each drop on its own ballistic
  arc (~52 m/s, up to 140 m), bent by the bise and falling back as spray; floodlit after dusk.
- **TPG trams** in their orange and white livery on the OSM tram network, with their stops.
- **Inventaire cantonal des arbres isolés** (SITG): ~39,000 trees with their surveyed height and crown.
- The **quartiers** of the Ville de Genève (Cité, Pâquis, Eaux-Vives, Plainpalais, Jonction…) and the neighbouring
  communes for place names, plus teleports and viewpoints.
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
| `update:buildings` | `tools/update-swissbuildings3d.mjs` | swisstopo swissBUILDINGS3D 3.0 (3D Tiles) |

## Ideas

- The Mouettes genevoises crossing the Rade, the CGN paddle steamers.
- The TPG lines and timetables (GTFS) for the trams.
- A French interface.

## License and data

The code is available under the [MIT License](LICENSE).

Data: © [swisstopo](https://www.swisstopo.admin.ch/) (swissBUILDINGS3D 3.0, swissALTI3D, swissSURFACE3D,
swissALTIRegio, open government data), © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL),
[SITG / État de Genève](https://ckan.opendata.swiss/dataset/inventaire-cantonal-des-arbres-isoles) (Inventaire
cantonal des arbres isolés).

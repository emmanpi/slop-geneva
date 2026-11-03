[out:json][timeout:120];
// The quartiers of the Ville de Genève (admin_level 10), and the neighbouring communes the frame reaches
// (Pregny-Chambésy and Le Grand-Saconnex by the Nations, Cologny across the lake)
(
  relation["boundary"="administrative"]["admin_level"="10"](46.19226,6.12021,46.23603,6.17306);
  relation["boundary"="administrative"]["admin_level"="8"]["name"~"^(Pregny-Chambésy|Le Grand-Saconnex|Cologny|Chêne-Bougeries)$"](46.19226,6.12021,46.23603,6.17306);
);
out geom;
